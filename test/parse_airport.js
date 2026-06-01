/**
 * Airport Parse Test
 * Scans all airports and their .acl files, validates parsing, and reports stats.
 * Usage: node test/parse_airport.js
 */

const fs = require('fs');
const path = require('path');
const { loadFlights, FIELDS } = require('../src/acl_parser');

const ROOT = path.resolve(__dirname, '..', '..');
const AIRPORTS_DIR = path.join(ROOT, 'GroundATC_Data', 'StreamingAssets', 'Airports');

const MIN_EXPECTED_FIELDS = ['CallSign', 'AircraftType', 'AirlineName', 'Voice', 'Language'];

// ─── Helpers ──────────────────────────────────────────────────

function countNonNull(arr) {
  return arr.filter(v => v !== null && v !== undefined && v !== '').length;
}

function summarizeFlight(flight, idx) {
  const issues = [];
  for (const [fn, ft] of FIELDS) {
    const v = flight[fn];
    if (v === undefined) issues.push(`${fn}: missing`);
    else if (ft === 'time' && v === '' && fn !== 'Airway') {} // time can be empty for opposite leg
  }
  // Check that at least either departure or arrival airports is non-empty
  if (!flight.DepartureAirport && !flight.ArrivalAirport) {
    issues.push('no airport: both DepartureAirport and ArrivalAirport are empty');
  }
  return issues;
}

// ─── Main ─────────────────────────────────────────────────────

function testAirport(icao, levelsDir) {
  if (!fs.existsSync(levelsDir) || !fs.statSync(levelsDir).isDirectory()) {
    return { icao, files: 0, ok: 0, fail: 0, totalFlights: 0, errors: [] };
  }

  const aclFiles = fs.readdirSync(levelsDir).filter(f => 
    f.endsWith('.acl')
    && !f.endsWith('.acl.bak')
    && !f.includes('_backup_')
    && !f.includes('-bak')
    && !f.includes('.demo.')
    && !f.includes('Tutorial')
    && !f.includes('Endless')
    && !f.includes('_test')
    && !f.includes('Dev')
    && !f.includes('PerfBench')
  );
  const result = { icao, files: aclFiles.length, ok: 0, fail: 0, totalFlights: 0, details: [] };

  for (const f of aclFiles) {
    const filePath = path.join(levelsDir, f);
    try {
      const data = loadFlights(filePath);
      const flights = data.flights;
      const mode = data._fromFlightPlans ? 'FlightPlans' : data._fromWorldState ? 'WorldState' : 'Unknown';

      // Validate each flight
      let flightIssues = 0;
      const badFlights = [];
      for (let i = 0; i < flights.length; i++) {
        const issues = summarizeFlight(flights[i], i);
        if (issues.length > 0) {
          flightIssues++;
          badFlights.push({ idx: i, callSign: flights[i].CallSign || '(none)', issues });
        }
      }

      result.totalFlights += flights.length;
      result.ok++;

      const issueStr = flightIssues > 0 ? ` (${flightIssues} flights with issues)` : '';
      result.details.push(`  ✓ ${f}: ${flights.length} flights [${mode}]${issueStr}`);

      if (badFlights.length > 0) {
        for (const bf of badFlights.slice(0, 3)) {
          result.details.push(`    - [#${bf.idx}] ${bf.callSign}: ${bf.issues.join(', ')}`);
        }
        if (badFlights.length > 3) result.details.push(`    ... and ${badFlights.length - 3} more`);
      }
    } catch (err) {
      result.fail++;
      result.details.push(`  ✗ ${f}: ${err.message.substring(0, 100)}`);
    }
  }

  return result;
}

// ─── Runner ──────────────────────────────────────────────────────

if (!fs.existsSync(AIRPORTS_DIR)) {
  console.error(`Airports directory not found: ${AIRPORTS_DIR}`);
  process.exit(1);
}

const airports = fs.readdirSync(AIRPORTS_DIR)
  .filter(d => fs.statSync(path.join(AIRPORTS_DIR, d)).isDirectory());

console.log(`Testing ${airports.length} airports in ${AIRPORTS_DIR}\n`);

let totalFiles = 0, totalOk = 0, totalFail = 0, totalFlights = 0;
const results = [];

for (const icao of airports) {
  const levelsDir = path.join(AIRPORTS_DIR, icao, 'Levels');
  const r = testAirport(icao, levelsDir);
  results.push(r);

  totalFiles += r.files;
  totalOk += r.ok;
  totalFail += r.fail;
  totalFlights += r.totalFlights;

  console.log(`${icao}: ${r.ok}/${r.files} files OK, ${r.totalFlights} flights total`);
  for (const line of r.details) console.log(line);
  console.log('');
}

console.log('═══════════════════════════════════');
console.log(`Total airports:    ${airports.length}`);
console.log(`Total .acl files:  ${totalFiles}`);
console.log(`Parsed OK:         ${totalOk}`);
console.log(`Parse failures:    ${totalFail}`);
console.log(`Total flights:     ${totalFlights}`);
console.log('═══════════════════════════════════');

if (totalFail > 0) {
  console.log('\n✗ SOME FILES FAILED TO PARSE');
  process.exit(1);
} else {
  console.log('✓ ALL FILES PARSED SUCCESSFULLY');
  process.exit(0);
}
