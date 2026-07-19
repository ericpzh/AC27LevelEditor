/**
 * Save Integrity Check — parsed-state comparison.
 *
 * Loads two .acl files through the parser and compares every component
 * of the internal parsed state: flights (field-by-field), config,
 * scenery maps, embedded timelines, and source format.
 *
 * Byte-level comparison is deliberately NOT performed — GUID
 * regeneration, $id reassignment, and CDT updates are expected
 * and irrelevant. Only parsed state matters.
 *
 * Usage: node --require ./tests/integration/preload.cjs tests/save-integrity-check.js --acl <saved.acl> --bak <original.bak>
 */

const fs = require('fs');
const path = require('path');
const parser = require('../src/acl/parser');
const { readAclText } = require('../src/acl/gatcarc');

const {
  loadFlights,
  _extractConfig,
  _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline,
} = parser;

// ── CLI ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const isDemo = hasFlag('--demo');
const aclPath = getArg('--acl');
const bakPath = getArg('--bak');

if (!aclPath) {
  console.error('Usage: node --require ./tests/integration/preload.cjs tests/save-integrity-check.js --acl <saved.acl> [--bak <original.bak>] [--demo]');
  process.exit(1);
}
if (!fs.existsSync(aclPath)) { console.error('ACL not found:', aclPath); process.exit(1); }
if (!isDemo && !bakPath) { console.error('--bak required (unless --demo)'); process.exit(1); }
if (bakPath && !fs.existsSync(bakPath)) { console.error('BAK not found:', bakPath); process.exit(1); }

console.log('=== Save Integrity Check ===');
console.log('Saved:', aclPath);
if (bakPath) console.log('Orig: ', bakPath);
if (isDemo) console.log('Mode:  demo (parsability only, no comparison)');

// ── Comparison config ────────────────────────────────────────────
const COMPARE_FIELDS = [
  'CallSign', 'DepartureAirport', 'ArrivalAirport',
  'Stand', 'Runway', 'OffBlockTime', 'TakeoffTime',
  'LandingTime', 'InBlockTime', 'AirlineName',
  'AircraftType', 'Airway', 'Registration', 'Voice', 'Language',
];
const CFG_FIELDS = ['startTime', 'endTime', 'flightScheduleFile', 'runwayTimelineFile'];

function countTimeline(frames) {
  if (!frames) return 0;
  if (Array.isArray(frames)) return frames.length;
  return Object.keys(frames).length;
}

// ── Load saved file ─────────────────────────────────────────────
let savedResult;
try {
  savedResult = loadFlights(aclPath);
  if (!savedResult || !savedResult.flights.length) throw new Error('empty');
  console.log(`\n  Saved: ${savedResult.flights.length} flights loaded`);
} catch (e) {
  console.log(`  FAIL: Cannot parse saved .acl — ${e.message}`);
  process.exit(1);
}

let pass = true;
const diffs = [];

// ── Demo mode: parsability + flight data validation only ─────────
if (isDemo) {
  const savedText = readAclText(aclPath);
  const savedCfg = _extractConfig(savedText) || {};

  // Verify every flight has required key fields
  const KEY_FIELDS = ['CallSign', 'LandingTime', 'InBlockTime', 'OffBlockTime', 'TakeoffTime'];
  let missingFields = 0;
  for (const f of savedResult.flights) {
    for (const field of KEY_FIELDS) {
      if (!(field in f)) { missingFields++; break; }
    }
  }
  if (missingFields === 0) {
    console.log(`  [OK] All ${savedResult.flights.length} flights have required fields`);
  } else {
    console.log(`  FAIL: ${missingFields} flights missing required fields`);
    pass = false;
  }

  // Verify config is readable
  if (savedCfg.startTime) {
    console.log(`  [OK] Config: startTime=${savedCfg.startTime}, endTime=${savedCfg.endTime}`);
  } else {
    console.log(`  [WARN] Config: no startTime`);
  }

  // Verify scenery
  const rw = Object.keys(savedResult.sceneryMaps.runwayNameToGuid || {}).length;
  const st = Object.keys(savedResult.sceneryMaps.standIdToGuid || {}).length;
  console.log(`  [OK] Scenery maps: ${rw} runways, ${st} stands`);

  // Verify timelines
  const sw = countTimeline(_parseWeatherFrames(savedText));
  const sWi = countTimeline(_parseWindFrames(savedText));
  const sr = countTimeline(_parseRunwayTimeline(savedText));
  console.log(`  [OK] Timelines: weather=${sw} wind=${sWi} runway=${sr}`);

  // Timeline JSONs
  const tlDir = path.dirname(aclPath);
  for (const [name, file] of [['weather', 'weather_timeline.json'], ['wind', 'wind_timeline.json']]) {
    const p = path.join(tlDir, file);
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      console.log(`  [OK] ${name} timeline JSON: ${Array.isArray(data) ? data.length : Object.keys(data).length} entries`);
    }
  }

} else {
  // ── Full comparison mode ──────────────────────────────────────

  // Load original
  let origResult;
  try {
    origResult = loadFlights(bakPath);
    if (!origResult || !origResult.flights.length) throw new Error('empty');
    console.log(`  Original: ${origResult.flights.length} flights loaded`);
  } catch (e) {
    console.log(`  FAIL: Cannot parse original .bak — ${e.message}`);
    process.exit(1);
  }

  // 1. Flight count
  if (savedResult.flights.length !== origResult.flights.length) {
    diffs.push(`Flight count: ${origResult.flights.length} → ${savedResult.flights.length}`);
    pass = false;
  } else {
    console.log(`  [OK] Flight count: ${savedResult.flights.length}`);
  }

  // 2. CallSign sets
  const savedByCS = new Map(), origByCS = new Map();
  for (const f of savedResult.flights) savedByCS.set((f.CallSign || '').trim(), f);
  for (const f of origResult.flights) origByCS.set((f.CallSign || '').trim(), f);
  const savedCS = new Set(savedByCS.keys()), origCS = new Set(origByCS.keys());
  const missing = [...origCS].filter(cs => !savedCS.has(cs));
  const extra = [...savedCS].filter(cs => !origCS.has(cs));
  if (missing.length) { diffs.push(`${missing.length} missing: ${missing.slice(0,5).join(',')}`); pass = false; }
  if (extra.length) { diffs.push(`${extra.length} extra: ${extra.slice(0,5).join(',')}`); pass = false; }
  if (!missing.length && !extra.length) console.log(`  [OK] CallSign sets identical (${origCS.size})`);

  // 3. Field-by-field
  if (pass) {
    let fieldDiffs = 0;
    for (const cs of origCS) {
      if (!savedByCS.has(cs)) continue;
      const o = origByCS.get(cs), s = savedByCS.get(cs);
      for (const f of COMPARE_FIELDS) {
        if ((o[f] || '').toString().trim() !== (s[f] || '').toString().trim()) {
          fieldDiffs++;
          if (fieldDiffs <= 5) diffs.push(`${cs}.${f}: "${o[f]}" → "${s[f]}"`);
        }
      }
    }
    if (fieldDiffs === 0) console.log('  [OK] All flight data fields identical');
    else { console.log(`  FAIL: ${fieldDiffs} field value differences`); pass = false; }
  }

  // 4. Config
  const savedCfg = _extractConfig(readAclText(aclPath)) || {};
  const origCfg = _extractConfig(readAclText(bakPath)) || {};
  let cfgOk = true;
  for (const f of CFG_FIELDS) {
    if ((savedCfg[f]||'') !== (origCfg[f]||'')) { diffs.push(`Config.${f}: "${origCfg[f]}" → "${savedCfg[f]}"`); cfgOk = false; }
  }
  if (cfgOk) console.log(`  [OK] Config identical (startTime=${savedCfg.startTime}, endTime=${savedCfg.endTime})`);
  else console.log('  [WARN] Config differs');

  // 5. Scenery maps
  const origRw = Object.keys(origResult.sceneryMaps.runwayNameToGuid || {}).length;
  const savedRw = Object.keys(savedResult.sceneryMaps.runwayNameToGuid || {}).length;
  const origSt = Object.keys(origResult.sceneryMaps.standIdToGuid || {}).length;
  const savedSt = Object.keys(savedResult.sceneryMaps.standIdToGuid || {}).length;
  if (origRw === savedRw && origSt === savedSt) console.log(`  [OK] Scenery maps: ${savedRw} runways, ${savedSt} stands`);
  else { diffs.push(`Scenery: runways ${origRw}→${savedRw}, stands ${origSt}→${savedSt}`); pass = false; }

  // 6. Source format
  if (origResult._fromFlightPlans === savedResult._fromFlightPlans) console.log('  [OK] Source format preserved (FlightPlans)');
  else { diffs.push('Source format changed'); pass = false; }

  // 7. Embedded timelines
  const savedText = readAclText(aclPath);
  const origText = readAclText(bakPath);
  const sw2 = countTimeline(_parseWeatherFrames(savedText)), ow2 = countTimeline(_parseWeatherFrames(origText));
  const sWi2 = countTimeline(_parseWindFrames(savedText)), oWi2 = countTimeline(_parseWindFrames(origText));
  const sr2 = countTimeline(_parseRunwayTimeline(savedText)), or2 = countTimeline(_parseRunwayTimeline(origText));
  if (sw2 === ow2 && sWi2 === oWi2 && sr2 === or2) console.log(`  [OK] Timelines: weather=${sw2} wind=${sWi2} runway=${sr2}`);
  else {
    if (sw2 !== ow2) diffs.push(`Weather: ${ow2}→${sw2}`);
    if (sWi2 !== oWi2) diffs.push(`Wind: ${oWi2}→${sWi2}`);
    if (sr2 !== or2) diffs.push(`Runway: ${or2}→${sr2}`);
    pass = false;
  }
}

// ── Timeline JSONs (common) ──────────────────────────────────────
try {
  const tlDir = path.dirname(aclPath);
  for (const [name, file] of [['weather', 'weather_timeline.json'], ['wind', 'wind_timeline.json']]) {
    const p = path.join(tlDir, file);
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      console.log(`  [OK] ${name} timeline JSON: ${Array.isArray(data) ? data.length : Object.keys(data).length} entries`);
    }
  }
} catch (e) { /* JSON parse issues are non-fatal */ }

// ── Report ───────────────────────────────────────────────────────
if (pass) {
  console.log('\n=== ALL CHECKS PASSED ===');
} else {
  console.log(`\n=== ${diffs.length} ISSUES FOUND ===`);
  diffs.forEach(d => console.log(`  ! ${d}`));
}
process.exit(pass ? 0 : 1);
