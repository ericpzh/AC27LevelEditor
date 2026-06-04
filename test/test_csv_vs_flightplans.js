/**
 * Test: CSV importer → compare against WorldState.FlightPlans in .acl
 *
 * Given a .acl file and its paired .csv, this test:
 * 1. Imports flights from the CSV via importCsvFromFile()
 * 2. Parses FlightPlans entries from the .acl via _parseWorldStateFlightPlans()
 * 3. Matches them by Registration (or CallSign if registration empty)
 * 4. Compares all relevant fields and reports mismatches
 *
 * Usage: node test/test_csv_vs_flightplans.js --acl <path-to-.acl-file> [--csv <path-to-.csv-file>]
 *
 *   --acl   Path to the .acl file (required).
 *   --csv   Path to the paired .csv file. If omitted, derived from .aclcfg or naming convention.
 */
const fs = require('fs');
const path = require('path');
const parser = require('../src/acl/parser');

// ─── CLI ──────────────────────────────────────────────────────
let aclPath = null;
let csvPath = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--acl' && i + 1 < process.argv.length) {
    aclPath = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--csv' && i + 1 < process.argv.length) {
    csvPath = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node test/test_csv_vs_flightplans.js --acl <path-to-.acl-file> [--csv <path-to-.csv-file>]');
    console.log('  --acl   Path to the .acl file (required).');
    console.log('  --csv   Path to the paired .csv file (auto-discovered if omitted).');
    process.exit(0);
  }
}
if (!aclPath) {
  console.error('ERROR: --acl <path> is required.');
  console.error('Usage: node test/test_csv_vs_flightplans.js --acl <path-to-.acl-file>');
  process.exit(1);
}
if (!fs.existsSync(aclPath)) {
  console.error('ERROR: File not found: ' + aclPath);
  process.exit(1);
}

// Auto-discover CSV if not provided
if (!csvPath) {
  const dir = path.dirname(aclPath);
  const aclBase = path.basename(aclPath, '.acl');

  // Try .aclcfg flightScheduleFile first
  const cfgPath = path.join(dir, aclBase + '.aclcfg');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.flightScheduleFile) {
        const p = path.join(dir, cfg.flightScheduleFile + '.csv');
        if (fs.existsSync(p)) csvPath = p;
      }
    } catch (_) {}
  }
  // Fallback: naming convention flight_schedule_HH-HH.csv
  if (!csvPath) {
    const match = aclBase.match(/(\d{2})-(\d{2})/);
    if (match) {
      const p = path.join(dir, 'flight_schedule_' + match[1] + '-' + match[2] + '.csv');
      if (fs.existsSync(p)) csvPath = p;
    }
  }
}
if (!csvPath) {
  console.error('ERROR: Could not find CSV file. Specify with --csv <path>.');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────

function check(condition, label) {
  if (condition) { console.log('  ✓ ' + label); return true; }
  else { console.log('  ✗ ' + label); return false; }
}

function cmpStr(prefix, field, csvVal, aclVal, out) {
  if (csvVal !== aclVal) out.push(prefix + ': ' + field + ' mismatch — CSV="' + csvVal + '" vs ACL="' + aclVal + '"');
}

// ─── Comparison ──────────────────────────────────────────────

/** Compare standard flight objects (both CSV and ACL-parsed use the same field names). */
function compare(csvFlights, aclEntries) {
  const mismatches = [];

  // Build lookup by _Registration (primary) and CallSign (fallback)
  const aclByReg = new Map();
  const aclByCallSign = new Map();
  for (const e of aclEntries) {
    if (e._Registration) aclByReg.set(e._Registration, e);
    if (e.CallSign) aclByCallSign.set(e.CallSign, e);
  }

  for (let i = 0; i < csvFlights.length; i++) {
    const csv = csvFlights[i];
    const reg = csv._Registration || '';
    const cs = csv.CallSign || '';

    let aclEntry = aclByReg.get(reg);
    if (!aclEntry) aclEntry = aclByCallSign.get(cs);
    if (!aclEntry) {
      mismatches.push('Row ' + (i + 2) + ' (' + reg + '/' + cs + '): no matching FlightPlan entry found in ACL');
      continue;
    }

    const prefix = 'Row ' + (i + 2) + ' (' + reg + '/' + cs + ')';

    // String fields
    for (const f of ['CallSign', 'DepartureAirport', 'ArrivalAirport', 'Runway', 'Stand',
                      'AirlineName', 'AircraftType', 'Voice', 'Language']) {
      cmpStr(prefix, f, csv[f] || '', aclEntry[f] || '', mismatches);
    }

    // Registration
    cmpStr(prefix, '_Registration', reg, aclEntry._Registration || '', mismatches);

    // Time fields — only compare what CSV has (CSV omits opposite-leg times, ACL fills all)
    for (const f of ['OffBlockTime', 'TakeoffTime', 'LandingTime', 'InBlockTime']) {
      if (csv[f] !== '' && csv[f] !== undefined) {
        cmpStr(prefix, f, csv[f], aclEntry[f] || '', mismatches);
      }
    }

    // isDeparture flag
    if (!!csv.isDeparture !== !!aclEntry.isDeparture) {
      mismatches.push(prefix + ': isDeparture mismatch — CSV=' + !!csv.isDeparture + ' vs ACL=' + !!aclEntry.isDeparture);
    }
  }

  // Check orphaned ACL entries
  const matchedRegs = new Set();
  const matchedCS = new Set();
  for (const csv of csvFlights) {
    if (csv._Registration) matchedRegs.add(csv._Registration);
    if (csv.CallSign) matchedCS.add(csv.CallSign);
  }
  for (const e of aclEntries) {
    if (e._Registration && !matchedRegs.has(e._Registration) && e.CallSign && !matchedCS.has(e.CallSign)) {
      mismatches.push('Orphan ACL entry: _Registration=' + e._Registration + ' CallSign=' + e.CallSign + ' — no matching CSV row');
    }
  }

  return mismatches;
}

// ─── Runner ──────────────────────────────────────────────────

console.log('Test: CSV vs FlightPlans Comparison');
console.log('ACL: ' + aclPath);
console.log('CSV: ' + csvPath + '\n');

// [1] Import CSV
const csvFlights = parser.importCsvFromFile(csvPath);
console.log('CSV: ' + csvFlights.length + ' flights imported');

// [2] Parse ACL FlightPlans using the actual source function
const aclText = fs.readFileSync(aclPath, 'utf-8');

const fpData = parser._parseWorldStateFlightPlans(aclText);
const aclEntries = fpData ? fpData.flights : [];
console.log('ACL FlightPlans: ' + aclEntries.length + ' entries');

if (aclEntries.length > 0) {
  const first = aclEntries[0];
  console.log('First entry: Reg=' + (first._Registration || '') + ' CS=' + (first.CallSign || '') +
    ' isDeparture=' + !!first.isDeparture + ' Type=' + (first.AircraftType || ''));
}

// [3] Compare
const mismatches = compare(csvFlights, aclEntries);

console.log('');
if (mismatches.length === 0) {
  console.log('✓ ALL MATCH (' + csvFlights.length + ' flights, ' + aclEntries.length + ' ACL entries)');
  process.exit(0);
} else {
  console.log('✗ ' + mismatches.length + ' MISMATCHES:');
  for (const m of mismatches) console.log('  - ' + m);
  process.exit(1);
}
