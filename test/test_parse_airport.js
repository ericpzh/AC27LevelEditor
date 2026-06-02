/**
 * Airport Parse Test
 * Scans all airports and their .acl files, validates parsing, and reports stats.
 *
 * Usage: node test/test_parse_airport.js [--root <game-root-path>]
 *
 *   --root   Path to Airport Control 27 Playtest game root.
 *            Defaults to ../../../ (relative to this script).
 */
const fs = require('fs');
const path = require('path');
const { loadFlights, FIELDS } = require('../src/acl_parser');

// ─── CLI ──────────────────────────────────────────────────────
let ROOT = path.resolve(__dirname, '..', '..', '..');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--root' && i + 1 < process.argv.length) {
    ROOT = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node test/test_parse_airport.js [--root <game-root-path>]');
    console.log('  --root   Path to Airport Control 27 Playtest game root.');
    console.log('           Defaults to ../../../');
    process.exit(0);
  }
}

const AIRPORTS_DIR = path.join(ROOT, 'GroundATC_Data', 'StreamingAssets', 'Airports');

// ─── Helpers ──────────────────────────────────────────────────

function check(condition, label) {
  if (condition) { console.log('  ✓ ' + label); return true; }
  else { console.log('  ✗ ' + label); return false; }
}

function countNonNull(arr) {
  return arr.filter(v => v !== null && v !== undefined && v !== '').length;
}

function summarizeFlight(flight, idx) {
  const issues = [];
  for (const [fn, ft] of FIELDS) {
    const v = flight[fn];
    if (v === undefined) issues.push(fn + ': missing');
    else if (ft === 'time' && v === '' && fn !== 'Airway') {} // time can be empty for opposite leg
  }
  if (!flight.DepartureAirport && !flight.ArrivalAirport) {
    issues.push('no airport: both DepartureAirport and ArrivalAirport are empty');
  }
  return issues;
}

// ─── Test runner ──────────────────────────────────────────────

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
      result.details.push('  ✓ ' + f + ': ' + flights.length + ' flights [' + mode + ']' +
        (flightIssues > 0 ? ' (' + flightIssues + ' flights with issues)' : ''));

      if (badFlights.length > 0) {
        for (const bf of badFlights.slice(0, 3)) {
          result.details.push('    - [#' + bf.idx + '] ' + bf.callSign + ': ' + bf.issues.join(', '));
        }
        if (badFlights.length > 3) result.details.push('    ... and ' + (badFlights.length - 3) + ' more');
      }
    } catch (err) {
      result.fail++;
      result.details.push('  ✗ ' + f + ': ' + err.message.substring(0, 100));
    }
  }

  return result;
}

// ─── Main ─────────────────────────────────────────────────────

console.log('Test: Parse All Airports');
console.log('Game root: ' + ROOT);
console.log('');

if (!fs.existsSync(AIRPORTS_DIR)) {
  console.error('ERROR: Airports directory not found: ' + AIRPORTS_DIR);
  console.error('Specify game root with: node test/test_parse_airport.js --root <path>');
  process.exit(1);
}

const airports = fs.readdirSync(AIRPORTS_DIR)
  .filter(d => fs.statSync(path.join(AIRPORTS_DIR, d)).isDirectory());

console.log('Testing ' + airports.length + ' airports in ' + AIRPORTS_DIR + '\n');

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

  console.log(icao + ': ' + r.ok + '/' + r.files + ' files OK, ' + r.totalFlights + ' flights total');
  for (const line of r.details) console.log(line);
  console.log('');
}

console.log('═'.repeat(40));
console.log('Total airports:    ' + airports.length);
console.log('Total .acl files:  ' + totalFiles);
console.log('Parsed OK:         ' + totalOk);
console.log('Parse failures:    ' + totalFail);
console.log('Total flights:     ' + totalFlights);
console.log('═'.repeat(40));

if (totalFail > 0) {
  console.log('\n✗ SOME FILES FAILED TO PARSE');
  process.exit(1);
} else {
  console.log('\n✓ ALL FILES PARSED SUCCESSFULLY');
  process.exit(0);
}
