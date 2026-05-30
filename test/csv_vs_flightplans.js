/**
 * Test: CSV importer → compare against WorldState.FlightPlans in .acl
 *
 * Given a game CSV file and its matching ACL file, this test:
 * 1. Imports flights from the CSV via importCsvFromFile()
 * 2. Extracts FlightPlans entries from the .acl WorldState section
 * 3. Matches them by Registration (or CallSign if registration empty)
 * 4. Compares all relevant fields and reports mismatches
 *
 * Usage: node test/csv_vs_flightplans.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const parser = require('../src/acl_parser');

// ═══════════════════════════════════════════════════════════════
//  Test cases — add more as needed
// ═══════════════════════════════════════════════════════════════
const TEST_CASES = [
  {
    name: 'KJFK CrossRunwayTutorial',
    csvPath: path.join(ROOT, 'GroundATC_Data/StreamingAssets/Airports/KJFK/Levels/flight_schedule_CrossRunway.csv'),
    aclPath: path.join(ROOT, 'GroundATC_Data/StreamingAssets/Airports/KJFK/Levels/KJFK_CrossRunwayTutorial.acl'),
  },
  {
    name: 'KJFK 07-09',
    csvPath: path.join(ROOT, 'GroundATC_Data/StreamingAssets/Airports/KJFK/Levels/flight_schedule_07-09.csv'),
    aclPath: path.join(ROOT, 'GroundATC_Data/StreamingAssets/Airports/KJFK/Levels/KJFK_07-09.acl'),
  },
];

// ═══════════════════════════════════════════════════════════════
//  ACL FlightPlans parser
// ═══════════════════════════════════════════════════════════════

const TICKS_PER_SECOND = 10000000n;

/** Extract BaseTime ticks from the ACL raw text */
function extractBaseTime(text) {
  const m = text.match(/"BaseTime"\s*:\s*\{\s*"\$type"\s*:\s*3\s*,\s*(-?\d+)\s*\}/);
  return m ? BigInt(m[1]) : null;
}

/** Extract startTime (HH:MM:SS) from the ACL Config section, in seconds */
function extractStartTimeSeconds(text) {
  // Look for "startTime": "HH:MM:SS" inside Config
  const configIdx = text.indexOf('"Config"');
  if (configIdx < 0) return 0;
  const configEnd = text.indexOf('"Author"', configIdx);
  const configSection = text.substring(configIdx, configEnd > 0 ? configEnd : configIdx + 3000);
  const m = configSection.match(/"startTime"\s*:\s*"(\d{2}):(\d{2}):(\d{2})"/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}

/**
 * Compute expected ticks for a wall-clock time string (HH:MM:SS).
 * In the game, ticks = BaseTime + (wallClockSeconds - startTimeSeconds) * TICKS_PER_SECOND
 */
function timeToExpectedTicks(csvTime, baseTime, startTimeSec) {
  if (!csvTime || !csvTime.trim()) return null;
  const parts = csvTime.trim().split(':').map(Number);
  if (parts.length !== 3) return null;
  const wallSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  const relativeSec = wallSec - startTimeSec;
  return baseTime + BigInt(relativeSec) * TICKS_PER_SECOND;
}

/**
 * Parse the WorldState.FlightPlans $rcontent array entries from raw ACL text.
 * Each entry is: { "$k": "guid", "$v": { FlightPlanState } }
 * Returns array of parsed FlightPlanState objects with raw ticks preserved.
 */
function extractFlightPlans(text) {
  const fpIdx = text.indexOf('"FlightPlans"');
  if (fpIdx < 0) return { entries: [], rlength: 0 };

  const section = text.substring(fpIdx);
  const rlMatch = section.match(/"\$rlength"\s*:\s*(\d+)/);
  const rlength = rlMatch ? parseInt(rlMatch[1], 10) : 0;

  // Find $rcontent array bounds
  const rcMatch = section.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return { entries: [], rlength };

  const absStart = fpIdx + rcMatch.index + rcMatch[0].length;
  let depth = 0;
  let endPos = text.length;
  for (let i = absStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
        if (j < text.length && text[j] === ']') { endPos = j + 1; break; }
      }
    } else if (text[i] === ']' && depth === 0) { endPos = i + 1; break; }
  }

  const arrayContent = text.substring(absStart, endPos);
  const entries = [];

  // Split into top-level { "$k": ... "$v": { ... } } blocks
  depth = 0;
  let blockStart = -1;
  for (let i = 0; i < arrayContent.length; i++) {
    if (arrayContent[i] === '{') {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (arrayContent[i] === '}') {
      depth--;
      if (depth === 0 && blockStart >= 0) {
        const block = arrayContent.substring(blockStart, i + 1);
        const parsed = parseFlightPlanEntry(block);
        if (parsed) entries.push(parsed);
        blockStart = -1;
      }
    }
  }

  return { entries, rlength };
}

/** Parse a single { "$k": "...", "$v": { FlightPlanState ... } } block */
function parseFlightPlanEntry(block) {
  const kMatch = block.match(/"\$k"\s*:\s*"([^"]*)"/);
  const vStart = block.indexOf('"$v"');
  if (vStart < 0) return null;

  const colonIdx = block.indexOf(':', vStart);
  const braceIdx = block.indexOf('{', colonIdx);
  let vDepth = 1;
  let vEnd = braceIdx + 1;
  for (; vEnd < block.length; vEnd++) {
    if (block[vEnd] === '{') vDepth++;
    else if (block[vEnd] === '}') { vDepth--; if (vDepth === 0) break; }
  }
  const vBlock = block.substring(braceIdx, vEnd + 1);

  const fp = { _guid: kMatch ? kMatch[1] : '' };

  // Top-level string fields
  fp.Registration = extractString(vBlock, 'Registration');
  fp.AircraftType = extractString(vBlock, 'AircraftType');
  fp.AirlineName = extractString(vBlock, 'AirlineName');
  fp.Voice = extractString(vBlock, 'Voice');
  fp.Language = extractString(vBlock, 'Language');

  // Check for Arrival sub-object
  const arrIdx = vBlock.indexOf('"Arrival"');
  const arrNull = vBlock.match(/"Arrival"\s*:\s*null/);
  const depNull = vBlock.match(/"Departure"\s*:\s*null/);

  if (arrIdx >= 0 && !arrNull) {
    fp.Leg = 'arrival';
    const arrMatch = vBlock.match(/"Arrival"\s*:\s*\{/);
    if (arrMatch) {
      const obj = extractSubObject(vBlock, arrMatch.index + arrMatch[0].length);
      fp.CallSign = extractString(obj, 'CallSign');
      fp.OriginAirport = extractString(obj, 'OriginAirport');
      fp.DestinationAirport = '';
      fp.LandingTime = extractTicks(obj, 'LandingTime');
      fp.InBlockTime = extractTicks(obj, 'InBlockTime');
      fp.OffBlockTime = null;
      fp.TakeoffTime = null;
      // Older format uses "Runway"/"Stand", newer uses "PlannedRunway"/"PlannedStand"
      fp.Runway = extractString(obj, 'Runway') || extractString(obj, 'PlannedRunway');
      fp.Stand = extractString(obj, 'Stand') || extractString(obj, 'PlannedStand');
    }
  } else if (!depNull) {
    fp.Leg = 'departure';
    const depMatch = vBlock.match(/"Departure"\s*:\s*\{/);
    if (depMatch) {
      const obj = extractSubObject(vBlock, depMatch.index + depMatch[0].length);
      fp.CallSign = extractString(obj, 'CallSign');
      fp.OriginAirport = '';
      fp.DestinationAirport = extractString(obj, 'DestinationAirport');
      fp.LandingTime = null;
      fp.InBlockTime = null;
      fp.OffBlockTime = extractTicks(obj, 'OffBlockTime');
      fp.TakeoffTime = extractTicks(obj, 'TakeoffTime');
      fp.Runway = extractString(obj, 'Runway') || extractString(obj, 'PlannedRunway');
      fp.Stand = extractString(obj, 'Stand') || extractString(obj, 'PlannedStand');
    }
  } else {
    fp.Leg = 'unknown';
  }

  return fp;
}

function extractString(text, field) {
  const m = text.match(new RegExp('"' + field + '"\\s*:\\s*"([^"]*)"'));
  return m ? m[1] : '';
}

function extractTicks(text, field) {
  const m = text.match(new RegExp('"' + field + '"\\s*:\\s*\\{\\s*"\\$type"\\s*:\\s*\\d+\\s*,\\s*(-?\\d+)\\s*\\}'));
  return m ? BigInt(m[1]) : null;
}

/** Extract a sub-object starting right after the opening { */
function extractSubObject(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.substring(start, i); }
  }
  return '';
}

// ═══════════════════════════════════════════════════════════════
//  Comparison logic
// ═══════════════════════════════════════════════════════════════

/**
 * Compare CSV-imported flights against ACL FlightPlans entries.
 * Returns an array of mismatch descriptions (empty = all good).
 */
function compare(csvFlights, aclEntries, baseTime, startTimeSec) {
  const mismatches = [];

  // Build lookup: Registration → ACL entry (fallback: CallSign)
  const aclByReg = new Map();
  const aclByCallSign = new Map();
  for (const e of aclEntries) {
    if (e.Registration) aclByReg.set(e.Registration, e);
    if (e.CallSign) aclByCallSign.set(e.CallSign, e);
  }

  for (let i = 0; i < csvFlights.length; i++) {
    const csv = csvFlights[i];
    const reg = csv._Registration || '';
    const cs = csv.CallSign || '';

    // Match ACL entry
    let aclEntry = aclByReg.get(reg);
    if (!aclEntry) aclEntry = aclByCallSign.get(cs);
    if (!aclEntry) {
      mismatches.push(`Row ${i + 2} (${reg}/${cs}): no matching FlightPlan entry found in ACL`);
      continue;
    }

    const prefix = `Row ${i + 2} (${reg}/${cs})`;

    // Compare Registration
    cmpStr(prefix, 'Registration', csv._Registration || '', aclEntry.Registration, mismatches);

    // Compare CallSign
    cmpStr(prefix, 'CallSign', csv.CallSign || '', aclEntry.CallSign || '', mismatches);

    // Compare DepartureAirport / ArrivalAirport
    if (aclEntry.Leg === 'arrival') {
      cmpStr(prefix, 'OriginAirport', csv.DepartureAirport || '', aclEntry.OriginAirport || '', mismatches);
    } else {
      cmpStr(prefix, 'DestinationAirport', csv.ArrivalAirport || '', aclEntry.DestinationAirport || '', mismatches);
    }

    // Compare Runway
    cmpStr(prefix, 'Runway', csv.Runway || '', aclEntry.Runway || '', mismatches);

    // Compare Stand
    cmpStr(prefix, 'Stand', csv.Stand || '', aclEntry.Stand || '', mismatches);

    // Compare AirlineName
    cmpStr(prefix, 'AirlineName', csv.AirlineName || '', aclEntry.AirlineName || '', mismatches);

    // Compare AircraftType
    cmpStr(prefix, 'AircraftType', csv.AircraftType || '', aclEntry.AircraftType || '', mismatches);

    // Compare Voice
    cmpStr(prefix, 'Voice', csv.Voice || '', aclEntry.Voice || '', mismatches);

    // Compare Language
    cmpStr(prefix, 'Language', csv.Language || '', aclEntry.Language || '', mismatches);

    // Compare time fields (ticks)
    if (aclEntry.Leg === 'arrival') {
      cmpTime(prefix, 'LandingTime', csv.LandingTime || '', aclEntry.LandingTime, baseTime, startTimeSec, mismatches);
    } else {
      cmpTime(prefix, 'OffBlockTime', csv.OffBlockTime || '', aclEntry.OffBlockTime, baseTime, startTimeSec, mismatches);
    }
  }

  // Check for orphaned ACL entries (entries not matched to any CSV row)
  const matchedRegs = new Set();
  const matchedCS = new Set();
  for (const csv of csvFlights) {
    if (csv._Registration) matchedRegs.add(csv._Registration);
    if (csv.CallSign) matchedCS.add(csv.CallSign);
  }
  for (const e of aclEntries) {
    if (e.Registration && !matchedRegs.has(e.Registration) && e.CallSign && !matchedCS.has(e.CallSign)) {
      mismatches.push(`Orphan ACL entry: Registration=${e.Registration} CallSign=${e.CallSign} — no matching CSV row`);
    }
  }

  return mismatches;
}

function cmpStr(prefix, field, csvVal, aclVal, out) {
  if (csvVal !== aclVal) {
    out.push(`${prefix}: ${field} mismatch — CSV="${csvVal}" vs ACL="${aclVal}"`);
  }
}

function cmpTime(prefix, field, csvTime, aclTicks, baseTime, startTimeSec, out) {
  if (!csvTime) {
    if (aclTicks !== null && aclTicks !== 0n) {
      out.push(`${prefix}: ${field} mismatch — CSV="" (empty) vs ACL=${aclTicks}`);
    }
    return;
  }
  const expectedTicks = timeToExpectedTicks(csvTime, baseTime, startTimeSec);
  if (expectedTicks === null) {
    out.push(`${prefix}: ${field} — bad CSV time format: "${csvTime}"`);
    return;
  }

  if (aclTicks === null) {
    out.push(`${prefix}: ${field} mismatch — CSV=${expectedTicks} (${csvTime}) vs ACL=null`);
  } else if (expectedTicks !== aclTicks) {
    const diff = aclTicks - expectedTicks;
    out.push(`${prefix}: ${field} mismatch — CSV=${expectedTicks} (${csvTime}) vs ACL=${aclTicks} (diff=${diff} ticks = ${Number(diff) / 1e7}s)`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  Runner
// ═══════════════════════════════════════════════════════════════

function runTest(tc) {
  console.log(`\n══════ ${tc.name} ══════`);

  // 1. Import CSV
  const csvFlights = parser.importCsvFromFile(tc.csvPath);
  console.log(`  CSV: ${csvFlights.length} flights imported`);

  // 2. Parse ACL FlightPlans
  const aclText = fs.readFileSync(tc.aclPath, 'utf-8');
  const baseTime = extractBaseTime(aclText);
  const startTimeSec = extractStartTimeSeconds(aclText);
  console.log(`  ACL BaseTime: ${baseTime} (${baseTime !== null ? formatBaseTime(baseTime) : 'N/A'}), startTime offset: ${startTimeSec}s`);

  const fpData = extractFlightPlans(aclText);
  console.log(`  ACL FlightPlans: ${fpData.entries.length} entries (rlength=${fpData.rlength})`);

  // Print sample entries for debugging
  if (fpData.entries.length > 0) {
    const first = fpData.entries[0];
    console.log(`  First entry: Reg=${first.Registration} CS=${first.CallSign} Leg=${first.Leg} Type=${first.AircraftType}`);
  }

  // 3. Compare
  const mismatches = compare(csvFlights, fpData.entries, baseTime, startTimeSec);

  if (mismatches.length === 0) {
    console.log(`  ✓ ALL MATCH (${csvFlights.length} flights, ${fpData.entries.length} ACL entries)`);
    return true;
  } else {
    console.log(`  ✗ ${mismatches.length} MISMATCHES:`);
    for (const m of mismatches) {
      console.log(`    - ${m}`);
    }
    return false;
  }
}

function formatBaseTime(ticks) {
  // Convert .NET ticks to a readable UTC datetime
  const NET_EPOCH = 621355968000000000n;
  const ms = Number((BigInt(ticks) - NET_EPOCH) / 10000n);
  return new Date(ms).toISOString();
}

// ═══════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════

let allOk = true;
for (const tc of TEST_CASES) {
  if (!fs.existsSync(tc.csvPath)) {
    console.log(`\nSKIP ${tc.name}: CSV not found at ${tc.csvPath}`);
    continue;
  }
  if (!fs.existsSync(tc.aclPath)) {
    console.log(`\nSKIP ${tc.name}: ACL not found at ${tc.aclPath}`);
    continue;
  }
  const ok = runTest(tc);
  allOk = allOk && ok;
}

console.log('\n══════════════════════════════════════');
if (allOk) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.log('SOME TESTS FAILED');
  process.exit(1);
}
