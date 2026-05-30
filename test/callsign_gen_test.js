/**
 * Test: callsign generation consistency across all CSVs
 *
 * For every flight_schedule_*.csv row, the test:
 *   1. Extracts the actual CallSign from the CSV (arrivalCallSign or departureCallSign).
 *   2. Extracts the Airline from the CSV column.
 *   3. Extracts flight number from the CallSign (numeric suffix, or alphanumeric for special callsigns).
 *   4. Converts Airline to ICAO via getAirlineCode().
 *   5. If airline ICAO matches callsign prefix → generate expected callsign via: icao + flightNum (no zero-padding)
 *   6. If airline ICAO ≠ callsign prefix → intentional real-world subsidiary codes — note as info, not failure.
 *
 * Usage: node test/callsign_gen_test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const AIRPORTS_DIR = path.join(ROOT, 'GroundATC_Data', 'StreamingAssets', 'Airports');

// Files to skip (test data, tutorials with intentional mismatches)
const SKIP_FILES = new Set([
  'flight_schedule_test.csv',
  'flight_schedule_RunwayIncursionTutorial.csv',
]);

// ─── Airline Name → ICAO Code mapping (synced from src/renderer.js) ───
const AIRLINE_CODE_MAP = {
  'Air China': 'CCA',        '中国国航': 'CCA',
  'China Eastern': 'CES',    '中国东方航空': 'CES',
  'China Southern': 'CSN',   '中国南方航空': 'CSN',
  'Hainan Airlines': 'CHH',  '海南航空': 'CHH',
  'Shenzhen Airlines': 'CSZ','深圳航空': 'CSZ',
  'Sichuan Airlines': 'CSC', '四川航空': 'CSC',
  'Xiamen Airlines': 'CXA',  '厦门航空': 'CXA',
  'Shandong Airlines': 'CDG','山东航空': 'CDG',
  'Spring Airlines': 'CQH',  '春秋航空': 'CQH',
  'Okay Airways': 'CJX',     '奥凯航空': 'CJX',
  'Tibet Airlines': 'UEA',   '西藏航空': 'UEA',
  'American Airlines': 'AAL',
  'Delta Air Lines': 'DAL',
  'United Airlines': 'UAL',
  'JetBlue': 'JBU',
  'British Airways': 'BAW',
  'Air France': 'AFR',
  'Lufthansa': 'DLH',
  'Qantas': 'QFA',
  'Qatar Airways': 'QTR',
  'Cathay Pacific': 'CPA',
  'Singapore Airlines': 'SIA',
  'Air New Zealand': 'ANZ',
  'Alaska Airlines': 'ASA',
  'Etihad Airways': 'ETD',
  'Gulf Air': 'GFA',
  'Air Arabia': 'AAR',
  'Virgin Atlantic': 'VIR',
  'Avianca': 'AVA',
  'Asiana Airlines': 'AAR',
  'Korean Air': 'AAR',
  'Emirates': 'UAE',
  'Turkish Airlines': 'THY',
  'Air Canada': 'ACA',
  'Japan Airlines': 'JAL',
  'All Nippon Airways': 'ANA',
  'Ethiopian Airlines': 'ETH',
  'KLM': 'KLM',
  'Swiss': 'SWR',
  'Aeroflot': 'AFL',
  'China Airlines': 'CAL',
  'EVA Air': 'EVA',
  'Vistajet': 'VJT',
};

// ─── getAirlineCode() — mirrors src/renderer.js ───
function getAirlineCode(airlineName) {
  if (!airlineName) return 'NEW';
  if (/^[A-Z]{3}$/.test(airlineName)) return airlineName;
  const code = AIRLINE_CODE_MAP[airlineName];
  if (code) return code;
  return airlineName.substring(0, 3).toUpperCase();
}

// ─── Extract flight number suffix from a callsign ───
// Returns { num: number, raw: string } or null if only alphanumeric (like BAW7NY)
function extractFlightNumber(callsign) {
  const match = (callsign || '').match(/(\d+)$/);
  if (match) return { num: parseInt(match[1], 10), raw: match[1] };
  // Alphanumeric suffix (e.g. BAW7NY, BAW17R) — valid but not numeric-exclusive
  const alphaMatch = (callsign || '').match(/^[A-Z]{3}(.+)$/);
  if (alphaMatch) return { num: null, raw: alphaMatch[1] };
  return null;
}

// ─── Generate expected callsign (NO zero-padding — matches game behaviour) ───
function generateCallSign(airlineName, flightNum) {
  const icao = getAirlineCode(airlineName);
  return icao + String(flightNum);
}

// ─── Discover all flight_schedule_*.csv files ───
function discoverCsvFiles() {
  const result = [];
  if (!fs.existsSync(AIRPORTS_DIR)) {
    console.error(`Airports directory not found: ${AIRPORTS_DIR}`);
    return result;
  }
  const airports = fs.readdirSync(AIRPORTS_DIR);
  for (const apt of airports) {
    const levelsDir = path.join(AIRPORTS_DIR, apt, 'Levels');
    if (!fs.existsSync(levelsDir)) continue;
    const files = fs.readdirSync(levelsDir);
    for (const f of files) {
      if (f.startsWith('flight_schedule') && f.endsWith('.csv')) {
        result.push({
          airport: apt,
          name: f,
          fullPath: path.join(levelsDir, f),
        });
      }
    }
  }
  return result;
}

// ─── Parse one CSV and test every row ───
function testCsvFile(fileInfo) {
  const { airport, name, fullPath } = fileInfo;
  const text = fs.readFileSync(fullPath, 'utf-8').trim();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { file: `${airport}/${name}`, rows: 0, mismatches: [], info: [], skipped: [], errors: [] };

  // Parse header
  const header = lines[0].trim().toLowerCase().split(',');
  const colMap = {};
  header.forEach((h, i) => { colMap[h.trim()] = i; });

  const mismatches = [];  // real bugs: generation doesn't match CSV callsign
  const info = [];        // intentional: airline ICAO ≠ callsign prefix (subsidiary codes)
  const skipped = [];     // alphanumeric callsigns (e.g. BAW7NY) — valid but can't auto-generate
  const errors = [];
  let totalRows = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 7) continue;

    const get = (colName) => {
      const idx = colMap[colName];
      return idx !== undefined && idx < cols.length ? (cols[idx] || '').trim() : '';
    };

    const airline = get('airline');
    const arrCall = get('arrivalcallsign');
    const depCall = get('departurecallsign');
    const actualCallSign = arrCall || depCall;

    if (!actualCallSign) continue;
    totalRows++;

    const flightInfo = extractFlightNumber(actualCallSign);
    if (flightInfo === null) {
      errors.push(`Row ${i + 1}: cannot extract flight number from CallSign "${actualCallSign}"`);
      continue;
    }

    // Alphanumeric callsigns like BAW7NY, BAW17R — valid real-world callsigns,
    // cannot be auto-generated from airline + number. Skip test.
    if (flightInfo.num === null) {
      skipped.push({
        row: i + 1,
        airline,
        actualCallSign,
        suffix: flightInfo.raw,
        leg: arrCall ? 'arrival' : 'departure',
      });
      continue;
    }

    const flightNum = flightInfo.num;

    // Get the ICAO prefix from the actual callsign (first 3 chars)
    const actualPrefix = actualCallSign.substring(0, 3).toUpperCase();

    // Get the ICAO code from the airline column
    const icaoFromAirline = getAirlineCode(airline);

    // If airline ICAO ≠ callsign prefix, this is intentional real-world data
    // (e.g. EGLC uses "British Airways" in airline column but "CFE" callsign for BA CityFlyer)
    if (icaoFromAirline !== actualPrefix) {
      info.push({
        row: i + 1,
        airline,
        icaoFromAirline,
        flightNum,
        actualCallSign,
        actualPrefix,
        leg: arrCall ? 'arrival' : 'departure',
      });
      continue;
    }

    // Airline ICAO matches callsign prefix — now verify the generated callsign
    // Game uses NO zero-padding: airlineCode + flightNum
    const expectedCallSign = icaoFromAirline + String(flightNum);

    if (expectedCallSign !== actualCallSign) {
      mismatches.push({
        row: i + 1,
        airline,
        icaoFromAirline,
        flightNum,
        expected: expectedCallSign,
        actual: actualCallSign,
        actualPrefix,
        leg: arrCall ? 'arrival' : 'departure',
      });
    }
  }

  const allOk = mismatches.length === 0 && errors.length === 0;

  return {
    file: `${airport}/${name}`,
    rows: totalRows,
    mismatches,
    info,
    skipped,
    errors,
    ok: allOk,
  };
}

// ─── Main ────────────────────────────────────────────────────
function main() {
  const csvFiles = discoverCsvFiles();
  console.log(`Found ${csvFiles.length} flight_schedule_*.csv files\n`);

  let grandTotalRows = 0;
  let grandTotalMismatches = 0;
  let grandTotalInfos = 0;
  let grandTotalSkipped = 0;
  let grandTotalErrors = 0;
  let filesOk = 0;
  let filesFailed = 0;
  let filesEmpty = 0;
  let filesSkipped = 0;
  const allMismatches = [];
  const allInfos = [];

  for (const fileInfo of csvFiles) {
    // Skip known test/tutorial files with intentional data
    if (SKIP_FILES.has(fileInfo.name)) {
      filesSkipped++;
      console.log(`  ⏭ SKIP ${fileInfo.airport}/${fileInfo.name} — known test/tutorial data`);
      continue;
    }

    const result = testCsvFile(fileInfo);

    // Empty files (header only, no data)
    if (result.rows === 0 && result.mismatches.length === 0 && result.errors.length === 0) {
      filesEmpty++;
      console.log(`  ∅ ${result.file} — empty (no data rows)`);
      continue;
    }

    grandTotalRows += result.rows;
    grandTotalMismatches += result.mismatches.length;
    grandTotalInfos += result.info.length;
    grandTotalSkipped += result.skipped.length;
    grandTotalErrors += result.errors.length;

    if (result.ok) {
      filesOk++;
      const notes = [];
      if (result.info.length > 0) notes.push(`${result.info.length} subsidiary`);
      if (result.skipped.length > 0) notes.push(`${result.skipped.length} alpha`);
      const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
      console.log(`  ✓ ${result.file} — ${result.rows} rows, all match${suffix}`);
    } else {
      filesFailed++;
      console.log(`\n  ✗ ${result.file} — ${result.rows} rows, ${result.mismatches.length} mismatches, ${result.errors.length} errors`);

      for (const err of result.errors) {
        console.log(`      [ERR] ${err}`);
      }
      for (const m of result.mismatches) {
        console.log(`      [MISMATCH] Row ${m.row}: airline="${m.airline}" → ICAO="${m.icaoFromAirline}", flightNum=${m.flightNum}`);
        console.log(`                 Expected: "${m.expected}"  Actual: "${m.actual}"`);
        allMismatches.push({ file: result.file, ...m });
      }
    }

    // Collect info & skipped items
    for (const inf of result.info) {
      allInfos.push({ file: result.file, ...inf });
    }
  }

  // ─── Summary ──────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log(`SUMMARY:`);
  console.log(`  Files tested:     ${csvFiles.length}`);
  console.log(`  Files skipped:    ${filesSkipped} (test/tutorial data)`);
  console.log(`  Files empty:      ${filesEmpty} (no data rows)`);
  console.log(`  Files all-OK:     ${filesOk}`);
  console.log(`  Files w/issues:   ${filesFailed}`);
  console.log(`  Total rows:       ${grandTotalRows}`);
  console.log(`  Mismatches:       ${grandTotalMismatches}`);
  console.log(`  Info (alt codes): ${grandTotalInfos}`);
  console.log(`  Alpha skipped:    ${grandTotalSkipped} (e.g. BAW7NY)`);
  console.log(`  Parse errors:     ${grandTotalErrors}`);
  console.log('══════════════════════════════════════════════════');

  // ─── Show info about subsidiary callsigns ───
  if (allInfos.length > 0) {
    console.log('\n─── Intentional Subsidiary Callsigns (airline code ≠ callsign prefix) ───');
    const byFile = {};
    for (const inf of allInfos) {
      if (!byFile[inf.file]) byFile[inf.file] = [];
      byFile[inf.file].push(inf);
    }
    for (const [file, items] of Object.entries(byFile)) {
      const groups = new Map();
      for (const it of items) {
        const key = `${it.airline}→${it.icaoFromAirline} (CSV uses: ${it.actualPrefix})`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
      }
      console.log(`  ${file}:`);
      for (const [key, grp] of groups) {
        console.log(`    ${key} — ${grp.length} rows, e.g. ${grp[0].actualCallSign}`);
      }
    }
  }

  // ─── Show real mismatches ───
  if (allMismatches.length > 0) {
    console.log('\n─── Mismatch Pattern Analysis ───');
    const prefixMap = new Map();
    for (const m of allMismatches) {
      const key = `${m.icaoFromAirline}→${m.actualPrefix}`;
      if (!prefixMap.has(key)) prefixMap.set(key, []);
      prefixMap.get(key).push(m);
    }
    console.log('\n  Airline ICAO → Actual CallSign prefix mappings:');
    for (const [key, items] of [...prefixMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const airlines = [...new Set(items.map(m => m.airline))].slice(0, 3);
      console.log(`    ${key.padEnd(16)} (${items.length} rows)  airlines: ${airlines.join(', ')}`);
    }
  }

  console.log(filesFailed > 0 ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
  process.exit(filesFailed > 0 ? 1 : 0);
}

main();
