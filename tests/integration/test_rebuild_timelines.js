/**
 * End-to-end test: _rebuildTimelineSections
 *
 * Verifies that WeatherFrames, WindFrames, and RunwayTimeline sections in the
 * .acl file are correctly patched when the timeline JSON data changes.
 *
 * Usage: node test/test_rebuild_timelines.js --acl <path-to-.acl-file>
 *
 * Timeline JSON files (weather_timeline.json, wind_timeline.json,
 * runway_timeline_*.json) are auto-discovered from the ACL's directory.
 * All temp files are written to test/ and cleaned up.
 */
const fs = require('fs');
const path = require('path');
const { _rebuildTimelineSections, _parseRunwayTimeline } = require('../../src/acl/flight_plans');
const { readAclText } = require('../../src/acl/gatcarc');

// ─── CLI ──────────────────────────────────────────────────────
let aclSrc = null;
let weatherPath = null, windPath = null, runwayPath = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--acl' && i + 1 < process.argv.length) {
    aclSrc = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--weather' && i + 1 < process.argv.length) {
    weatherPath = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--wind' && i + 1 < process.argv.length) {
    windPath = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--runway' && i + 1 < process.argv.length) {
    runwayPath = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node test/test_rebuild_timelines.js --acl <path-to-.acl-file> [--weather <path>] [--wind <path>] [--runway <path>]');
    console.log('  --acl       Path to the .acl file to test against (required).');
    console.log('  --weather   Path to weather_timeline.json (auto-discovered if omitted).');
    console.log('  --wind      Path to wind_timeline.json (auto-discovered if omitted).');
    console.log('  --runway    Path to runway_timeline_*.json (auto-discovered if omitted).');
    process.exit(0);
  }
}
if (!aclSrc) {
  console.error('ERROR: --acl <path> is required.');
  console.error('Usage: node test/test_rebuild_timelines.js --acl <path-to-.acl-file>');
  process.exit(1);
}
if (!fs.existsSync(aclSrc)) {
  console.error('ERROR: File not found: ' + aclSrc);
  process.exit(1);
}

// Auto-discover timeline JSON paths from ACL directory
const aclDir = path.dirname(aclSrc);
const aclBase = path.basename(aclSrc, '.acl');

if (!weatherPath) {
  const p = path.join(aclDir, 'weather_timeline.json');
  if (fs.existsSync(p)) weatherPath = p;
}
if (!windPath) {
  const p = path.join(aclDir, 'wind_timeline.json');
  if (fs.existsSync(p)) windPath = p;
}
if (!runwayPath) {
  // Try runway_timeline_<aclBase>.json first, then any runway_timeline_*.json
  const specific = path.join(aclDir, 'runway_timeline_' + aclBase + '.json');
  if (fs.existsSync(specific)) {
    runwayPath = specific;
  } else {
    const files = fs.readdirSync(aclDir).filter(f => f.startsWith('runway_timeline_') && f.endsWith('.json'));
    if (files.length > 0) runwayPath = path.join(aclDir, files[0]);
  }
}

const ACL_TEMP = path.join(__dirname, '_e2e_temp_rebuild_timelines.acl');
const ACL_TEMP2 = path.join(__dirname, '_e2e_temp_rebuild_timelines2.acl');

// ─── Helpers ──────────────────────────────────────────────────

function check(condition, label) {
  if (condition) { console.log('  ✓ ' + label); return true; }
  else { console.log('  ✗ ' + label); return false; }
}

function extractSection(text, sectionKey) {
  const idx = text.indexOf('"' + sectionKey + '"');
  if (idx < 0) return null;
  const colonIdx = text.indexOf(':', idx);
  if (colonIdx < 0) return null;
  let braceIdx = colonIdx + 1;
  while (braceIdx < text.length && text[braceIdx] !== '{') braceIdx++;
  if (braceIdx >= text.length) return null;
  const between = text.substring(colonIdx + 1, braceIdx).trim();
  if (between.startsWith('null')) return null;
  let depth = 0, endIdx = braceIdx;
  for (let i = braceIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
  }
  return { raw: text.substring(braceIdx, endIdx), end: endIdx };
}

function countInText(text, pattern) {
  const m = text.match(new RegExp(pattern, 'g'));
  return m ? m.length : 0;
}

/** Parse a frames $rcontent as [{ lowerKey: value }] entries (data-level only). */
function parseFrames(sectionText) {
  if (!sectionText) return [];
  const entries = [];
  const rcMatch = sectionText.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return entries;
  const absStart = rcMatch.index + rcMatch[0].length;
  let depth = 0, blockStart = -1;
  for (let i = absStart; i < sectionText.length; i++) {
    if (sectionText[i] === '{') {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (sectionText[i] === '}') {
      depth--;
      if (depth === 0 && blockStart >= 0) {
        const block = sectionText.substring(blockStart, i + 1);
        const entry = {};
        for (const m of block.matchAll(/"(\w+)":\s*"([^"]*)"/g)) entry[m[1].toLowerCase()] = m[2];
        for (const m of block.matchAll(/"(\w+)":\s*(-?\d+)/g)) {
          const key = m[1].toLowerCase();
          if (!(key in entry)) entry[key] = parseInt(m[2], 10);
        }
        entries.push(entry);
        blockStart = -1;
      }
    }
  }
  return entries;
}

function cleanup() {
  for (const p of [ACL_TEMP, ACL_TEMP2]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }
}

// ─── Test #1: WeatherFrames rebuild ───────────────────────────

function testWeatherFramesRebuild() {
  console.log('\n=== Test #1: WeatherFrames rebuild ===');
  if (!weatherPath) { console.log('  SKIP: no weather_timeline.json found'); return true; }

  fs.copyFileSync(aclSrc, ACL_TEMP);
  const origData = JSON.parse(fs.readFileSync(weatherPath, 'utf-8'));
  const modifiedData = origData.map((f, i) => ({
    preset: (i % 3 === 0) ? 'TEST_PRESET_' + i : f.preset,
    time: f.time
  }));
  modifiedData.sort((a, b) => {
    const t = s => { const p = s.split(':'); return +p[0] * 3600 + +p[1] * 60 + +p[2]; };
    return t(a.time) - t(b.time);
  });

  _rebuildTimelineSections(ACL_TEMP, modifiedData, null, null);
  const outText = readAclText(ACL_TEMP);
  let ok = true;

  ok &= check(outText.includes('"Preset": "TEST_PRESET_0"'), 'Modified preset TEST_PRESET_0 present');
  // Data-driven: the fixture JSON may hold any entry count (ZSJN_leisure_1
  // ships a single weather frame) — every (i % 3 === 0) entry is renamed.
  let renamedAll = true;
  for (let i = 0; i < modifiedData.length; i++) {
    if (i % 3 === 0 && !outText.includes('"Preset": "TEST_PRESET_' + i + '"')) renamedAll = false;
  }
  ok &= check(renamedAll, 'every (i % 3 === 0) preset renamed to TEST_PRESET_<i>');

  const ws = extractSection(outText, 'WeatherFrames');
  ok &= check(ws && ws.raw.includes('"$rlength": ' + modifiedData.length),
    'WeatherFrames $rlength == ' + modifiedData.length);
  ok &= check(countInText(ws.raw, '"Preset":') === modifiedData.length,
    'Preset count == ' + modifiedData.length);
  ok &= check(countInText(ws.raw, '"Time":') === modifiedData.length,
    'Time count == ' + modifiedData.length);

  // WindFrames untouched (null means no rebuild). Data-level comparison —
  // writeAcl's ascending-$id renumber (id_renumber.js) rewrites ids in the
  // whole document, so raw-text identity no longer holds on real prod files.
  const windOrig = extractSection(readAclText(aclSrc), 'WindFrames');
  const windOut = extractSection(outText, 'WindFrames');
  if (windOrig && windOut) ok &= check(
    JSON.stringify(parseFrames(windOrig.raw)) === JSON.stringify(parseFrames(windOut.raw)),
    'WindFrames unchanged (null passed, data-level)');

  return ok;
}

// ─── Test #2: WindFrames rebuild ──────────────────────────────

function testWindFramesRebuild() {
  console.log('\n=== Test #2: WindFrames rebuild ===');
  if (!windPath) { console.log('  SKIP: no wind_timeline.json found'); return true; }

  fs.copyFileSync(aclSrc, ACL_TEMP);
  const origData = JSON.parse(fs.readFileSync(windPath, 'utf-8'));
  const modifiedData = origData.map(f => ({
    direction: (f.direction + 90) % 360,
    speed: Math.min(f.speed + 3, 15),
    time: f.time
  }));

  _rebuildTimelineSections(ACL_TEMP, null, modifiedData, null);
  const outText = readAclText(ACL_TEMP);
  let ok = true;

  const ws = extractSection(outText, 'WindFrames');
  ok &= check(ws && ws.raw.includes('"$rlength": ' + modifiedData.length),
    'WindFrames $rlength == ' + modifiedData.length);
  ok &= check(ws.raw.includes('"Direction": ' + modifiedData[0].direction),
    'Modified Direction[0]=' + modifiedData[0].direction);
  ok &= check(ws.raw.includes('"Speed": ' + modifiedData[0].speed),
    'Modified Speed[0]=' + modifiedData[0].speed);

  // WeatherFrames untouched (null passed) — data-level (see Test #1)
  const wxOrig = extractSection(readAclText(aclSrc), 'WeatherFrames');
  const wxOut = extractSection(outText, 'WeatherFrames');
  if (wxOrig && wxOut) ok &= check(
    JSON.stringify(parseFrames(wxOrig.raw)) === JSON.stringify(parseFrames(wxOut.raw)),
    'WeatherFrames unchanged (null passed, data-level)');

  return ok;
}

// ─── Test #3: RunwayTimeline rebuild (empty) ──────────────────

function testRunwayTimelineEmpty() {
  console.log('\n=== Test #3: RunwayTimeline rebuild (empty) ===');

  fs.copyFileSync(aclSrc, ACL_TEMP);
  const modifiedData = { initialRunways: ['22L', '22R'], timeline: [] };
  _rebuildTimelineSections(ACL_TEMP, null, null, modifiedData);

  const outText = readAclText(ACL_TEMP);
  let ok = true;

  ok &= check(outText.includes('"22L"'), 'InitialRunway 22L present');
  ok &= check(outText.includes('"22R"'), 'InitialRunway 22R present');

  const rwForCheck = extractSection(outText, 'RunwayTimeline');
  // Old runway removed (check is relative — 4L may or may not be the old one)
  ok &= check(rwForCheck && rwForCheck.raw.match(/"Timeline"[\s\S]*?"\$rlength"\s*:\s*0/),
    'Timeline $rlength == 0');

  return ok;
}

// ─── Test #4: RunwayTimeline rebuild WITH changes ─────────────

function testRunwayTimelineWithChanges() {
  console.log('\n=== Test #4: RunwayTimeline rebuild WITH changes ===');
  if (!runwayPath) { console.log('  SKIP: no runway_timeline_*.json found'); return true; }

  fs.copyFileSync(aclSrc, ACL_TEMP2);
  const origData = JSON.parse(fs.readFileSync(runwayPath, 'utf-8'));

  const modifiedData = {
    initialRunways: origData.initialRunways || [],
    timeline: [
      ...(origData.timeline || []),
      {
        time: '18:00:00',
        changes: [
          { source: '31L', dest: '22R' },
          { source: '31R', dest: '22L' }
        ]
      }
    ]
  };

  _rebuildTimelineSections(ACL_TEMP2, null, null, modifiedData);
  const outText = readAclText(ACL_TEMP2);
  let ok = true;

  ok &= check(outText.includes('"Time": "18:00:00"'), 'Added frame Time="18:00:00"');
  ok &= check(outText.includes('"Source": "31L"'), 'Change Source=31L present');
  ok &= check(outText.includes('"Dest": "22R"'), 'Change Dest=22R present');
  ok &= check(outText.includes('"Source": "31R"'), 'Change Source=31R present');
  ok &= check(outText.includes('"Dest": "22L"'), 'Change Dest=22L present');

  const rw = extractSection(outText, 'RunwayTimeline');
  const tlMatch = rw && rw.raw.match(/"Timeline"[\s\S]*?"\$rlength"\s*:\s*(\d+)/);
  ok &= check(tlMatch && parseInt(tlMatch[1], 10) === modifiedData.timeline.length,
    'Timeline $rlength == ' + modifiedData.timeline.length + ' (got ' + (tlMatch ? tlMatch[1] : '?') + ')');

  return ok;
}

// ─── Test #5: All three sections simultaneously ───────────────

function testAllSectionsRebuild() {
  console.log('\n=== Test #5: All 3 sections simultaneous rebuild ===');

  fs.copyFileSync(aclSrc, ACL_TEMP);

  const weatherData = [
    { preset: 'FULL_SYNC_TEST', time: '06:00:00' },
    { preset: 'Sunny', time: '12:00:00' }
  ];
  const windData = [
    { direction: 270, speed: 10, time: '06:00:00' },
    { direction: 90, speed: 3, time: '18:00:00' }
  ];
  const runwayData = {
    initialRunways: ['TEST'],
    timeline: [{ time: '08:00:00', changes: [{ source: 'TEST', dest: 'NONE' }] }]
  };

  _rebuildTimelineSections(ACL_TEMP, weatherData, windData, runwayData);
  const outText = readAclText(ACL_TEMP);
  let ok = true;

  ok &= check(outText.includes('"Preset": "FULL_SYNC_TEST"'), 'Weather: custom preset present');
  ok &= check(countInText(extractSection(outText, 'WeatherFrames').raw, '"Preset":') === 2, 'Weather: 2 entries');
  ok &= check(outText.includes('"Direction": 270'), 'Wind: Direction=270 present');
  ok &= check(outText.includes('"Speed": 10'), 'Wind: Speed=10 present');
  ok &= check(countInText(extractSection(outText, 'WindFrames').raw, '"Direction":') === 2, 'Wind: 2 entries');
  ok &= check(outText.includes('"TEST"'), 'Runway: TEST initial runway');
  ok &= check(outText.includes('"Time": "08:00:00"'), 'Runway: timeline frame time');
  ok &= check(outText.includes('"Source": "TEST"'), 'Runway: change source');

  // Non-timeline sections preserved (v4: flight plans + scenery live inside
  // StaticData.$blobdoc — no top-level WorldState/SceneryData/FlightPlans keys)
  ok &= check(outText.includes('"StaticData"'), 'StaticData section preserved');
  ok &= check(outText.includes('"$k": "flight-plan:'), 'Flight plan entries preserved');
  ok &= check(outText.includes('"OsmId"'), 'Scenery (osm entities) preserved');

  return ok;
}

// ─── Test #6: Round-trip stability ────────────────────────────

function testRoundTripStability() {
  console.log('\n=== Test #6: Round-trip stability ===');
  if (!weatherPath || !windPath || !runwayPath) {
    console.log('  SKIP: need all three timeline JSONs (weather, wind, runway)');
    return true;
  }

  fs.copyFileSync(aclSrc, ACL_TEMP);

  const weatherData = JSON.parse(fs.readFileSync(weatherPath, 'utf-8'));
  const windData = JSON.parse(fs.readFileSync(windPath, 'utf-8'));
  // Parse RunwayTimeline from ACL itself (JSON file may be stale — known mismatch)
  const runwayData = _parseRunwayTimeline(readAclText(aclSrc));

  _rebuildTimelineSections(ACL_TEMP, weatherData, windData, runwayData);

  const outText = readAclText(ACL_TEMP);
  const srcText = readAclText(aclSrc);
  let ok = true;

  // Data-level round-trip: rebuilding the sections from their own data must
  // preserve every entry and values. (Raw-text identity is not asserted —
  // the rebuild regenerates $ids and may bump colliding $type numbers, e.g.
  // the prod fixture's RunwayTimeline element types 12/13/14 re-resolve to
  // 52/53/54 during the MetaData-scope collision pass.)
  const weatherSrc = parseFrames(extractSection(srcText, 'WeatherFrames').raw);
  const weatherOut = parseFrames(extractSection(outText, 'WeatherFrames').raw);
  ok &= check(JSON.stringify(weatherSrc) === JSON.stringify(weatherOut),
    'WeatherFrames round-trip data identical');

  const windSrc = parseFrames(extractSection(srcText, 'WindFrames').raw);
  const windOut = parseFrames(extractSection(outText, 'WindFrames').raw);
  ok &= check(JSON.stringify(windSrc) === JSON.stringify(windOut),
    'WindFrames round-trip data identical');

  const rwOrig = JSON.stringify(_parseRunwayTimeline(srcText));
  const rwOut = JSON.stringify(_parseRunwayTimeline(outText));
  ok &= check(rwOrig === rwOut, 'RunwayTimeline round-trip data identical');

  return ok;
}

// ─── Main ─────────────────────────────────────────────────────

function main() {
  console.log('Test: _rebuildTimelineSections — E2E ACL patching');
  console.log('ACL:  ' + aclSrc);
  console.log('Temp: ' + path.basename(ACL_TEMP));
  if (weatherPath) console.log('Weather: ' + path.basename(weatherPath));
  if (windPath) console.log('Wind:    ' + path.basename(windPath));
  if (runwayPath) console.log('Runway:  ' + path.basename(runwayPath));

  console.log('  Schema: v4 (MetaData subsections, binary re-encode)');

  let allOk = true;
  allOk &= testWeatherFramesRebuild();
  allOk &= testWindFramesRebuild();
  allOk &= testRunwayTimelineEmpty();
  allOk &= testRunwayTimelineWithChanges();
  allOk &= testAllSectionsRebuild();
  allOk &= testRoundTripStability();

  cleanup();
  console.log('\nCleaned up temp files.');
  console.log('\n' + '='.repeat(60));
  console.log(allOk ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
  process.exit(allOk ? 0 : 1);
}

main();
