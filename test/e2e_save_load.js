/**
 * End-to-End Save/Load Test
 * 
 * Verifies that load → snapshot → sort → save → load produces the same flight data.
 * The test NEVER modifies the original files — all writes go to a temp file in /test.
 * 
 * Usage: node test/e2e_save_load.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const parser = require('../src/acl_parser');

const ACL_ORIGINAL = path.join(ROOT, 'GroundATC_Data/StreamingAssets/Airports/KJFK/Levels/KJFK_20-22.acl');
const CSV_ORIGINAL = path.join(ROOT, 'GroundATC_Data/StreamingAssets/Airports/KJFK/Levels/flight_schedule_20-22.csv');
const ACL_TEMP     = path.join(__dirname, '_e2e_temp_KJFK_20-22.acl');
// CSV must match flightScheduleFile in .aclcfg
const CSV_TEMP     = path.join(__dirname, 'flight_schedule_20-22.csv');
const CFG_TEMP     = path.join(__dirname, '_e2e_temp_KJFK_20-22.aclcfg');

// ═══════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Compare two flight arrays semantically (string fields, HH:MM:SS time fields) */
function compareFlights(original, roundtripped, label) {
  const diffs = [];

  if (original.length !== roundtripped.length) {
    diffs.push(`Flight count mismatch: original=${original.length} vs roundtripped=${roundtripped.length}`);
    return diffs;
  }

  for (let i = 0; i < original.length; i++) {
    const a = original[i];
    const b = roundtripped[i];
    const prefix = `${label} [${i}] ${a.CallSign || b.CallSign || '?'}`;

    // Compare CallSign
    if ((a.CallSign || '') !== (b.CallSign || ''))
      diffs.push(`${prefix}: CallSign "${a.CallSign}" vs "${b.CallSign}"`);

    // Compare other string fields
    for (const f of ['DepartureAirport', 'ArrivalAirport', 'Stand', 'Runway',
                      'AirlineName', 'AircraftType', 'Airway', 'Voice', 'Language']) {
      const va = (a[f] || '').trim();
      const vb = (b[f] || '').trim();
      if (va !== vb) diffs.push(`${prefix}: ${f} "${va}" vs "${vb}"`);
    }

    // Compare time fields (HH:MM:SS strings, tolerant to sub-second precision differences)
    for (const f of ['OffBlockTime', 'TakeoffTime', 'LandingTime', 'InBlockTime']) {
      const ta = (a[f] || '').trim();
      const tb = (b[f] || '').trim();
      if (ta !== tb) diffs.push(`${prefix}: ${f} "${ta}" vs "${tb}"`);
    }

    // Compare Registration
    const ra = a._Registration || '';
    const rb = b._Registration || '';
    if (ra !== rb) diffs.push(`${prefix}: _Registration "${ra}" vs "${rb}"`);

    // Compare isDeparture flag
    if (!!a.isDeparture !== !!b.isDeparture)
      diffs.push(`${prefix}: isDeparture ${a.isDeparture} vs ${b.isDeparture}`);
  }

  return diffs;
}

// ═══════════════════════════════════════════════════════════════
//  Main test
// ═══════════════════════════════════════════════════════════════

function run() {
  console.log('═══ E2E Save/Load Test ═══');
  console.log('Original:', ACL_ORIGINAL);
  console.log('Temp:', ACL_TEMP);

  // ── Step 1: Load original file ──────────────────────────
  console.log('\n[1] Loading original ACL...');
  const originalData = parser.loadFlights(ACL_ORIGINAL);
  console.log(`    Flights: ${originalData.flights.length}`);
  console.log(`    Mode: ${originalData._fromFlightPlans ? 'FlightPlans' : originalData._fromWorldState ? 'WorldState' : 'Unknown'}`);

  // ── Step 2: Snapshot the flights (deep clone) ───────────
  //    This simulates what the renderer's appState.flights holds at save time.
  //    We DON'T modify the original — we work on a clone.
  console.log('\n[2] Snapshotting flights (deep clone)...');
  const snapshotFlights = deepClone(originalData.flights);

  // ── Step 3: Sort the snapshot chronologically ───────────
  //    This is what main.js does before calling generateFullAcl.
  //    sortFlightsChronologically uses .slice() internally — it does NOT mutate input.
  console.log('\n[3] Sorting snapshot chronologically...');
  const sortedFlights = parser.sortFlightsChronologically(snapshotFlights);
  console.log(`    Sorted ${sortedFlights.length} flights`);

  // ── Step 4: Copy original to temp file ──────────────────
  //    generateFullAcl re-reads the file from disk for in-place patching.
  //    We write to a temp copy so the original is NEVER touched.
  console.log('\n[4] Copying original → temp (so generateFullAcl patches a copy)...');
  fs.copyFileSync(ACL_ORIGINAL, ACL_TEMP);
  // Also copy CSV and cfg so reload works
  if (fs.existsSync(CSV_ORIGINAL)) fs.copyFileSync(CSV_ORIGINAL, CSV_TEMP);
  const origCfg = ACL_ORIGINAL.replace(/\.acl$/i, '.aclcfg');
  if (fs.existsSync(origCfg)) fs.copyFileSync(origCfg, CFG_TEMP);

  // ── Step 5: Run generateFullAcl on temp copy ────────────
  //    This is the actual save pipeline from main.js save-acl IPC handler.
  console.log('\n[5] Running generateFullAcl on temp copy...');
  try {
    parser.generateFullAcl(
      ACL_TEMP,                              // writes here (temp file)
      sortedFlights,                         // sorted snapshot
      originalData.before,                   // header before flight data
      originalData.after,                    // footer after flight data
      originalData.originalBlocks,           // original blocks (unused for FlightPlans)
      originalData.worldStateData,           // WorldState data (includes fpBefore/fpAfter)
      originalData.sceneryMaps,              // scenery maps
      originalData._fromWorldState,          // false for this file
      originalData._fromFlightPlans          // true for this file
    );
    console.log('    Save complete.');
  } catch (err) {
    console.error('    SAVE FAILED:', err.message);
    cleanup();
    process.exit(1);
  }

  // ── Step 6: Load the saved temp file back ───────────────
  console.log('\n[6] Loading saved temp file back...');
  const roundtrippedData = parser.loadFlights(ACL_TEMP);
  console.log(`    Flights: ${roundtrippedData.flights.length}`);
  console.log(`    Mode: ${roundtrippedData._fromFlightPlans ? 'FlightPlans' : roundtrippedData._fromWorldState ? 'WorldState' : 'Unknown'}`);

  // ── Step 7: Sort original data the same way for comparison ──
  //    The original load yielded flights in "display order" (arrivals first, then departures).
  //    generateFullAcl saves them in chronological (sorted) order.
  //    To compare, we sort the load data the same way.
  console.log('\n[7] Sorting both arrays identically for comparison...');
  const originalSorted = parser.sortFlightsChronologically(deepClone(originalData.flights));
  const roundtrippedSorted = parser.sortFlightsChronologically(deepClone(roundtrippedData.flights));

  // ── Step 8: Compare ─────────────────────────────────────
  console.log('\n[8] Comparing flights...');
  const diffs = compareFlights(originalSorted, roundtrippedSorted, 'Flight');

  // ── Step 9: Cleanup ─────────────────────────────────────
  cleanup();

  // ── Step 10: Report ─────────────────────────────────────
  console.log('\n═══ Results ═══');
  if (diffs.length === 0) {
    console.log('✓ PASS — Load → Save → Load produces identical flight data');
    console.log(`  ${originalData.flights.length} flights matched perfectly`);
    process.exit(0);
  } else {
    console.log(`✗ FAIL — ${diffs.length} difference(s) found:`);
    for (const d of diffs) console.log(`  - ${d}`);
    process.exit(1);
  }
}

function cleanup() {
  try {
    if (fs.existsSync(ACL_TEMP)) { fs.unlinkSync(ACL_TEMP); }
    if (fs.existsSync(CSV_TEMP)) { fs.unlinkSync(CSV_TEMP); }
    if (fs.existsSync(CFG_TEMP)) { fs.unlinkSync(CFG_TEMP); }
    console.log('\n[cleanup] Removed temp files');
  } catch (_) {}
}

// ── Run ────────────────────────────────────────────────────
if (!fs.existsSync(ACL_ORIGINAL)) {
  console.error(`Original file not found: ${ACL_ORIGINAL}`);
  process.exit(1);
}

run();
