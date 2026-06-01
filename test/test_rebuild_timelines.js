/**
 * End-to-end test: _rebuildTimelineSections
 *
 * Verifies that WeatherFrames, WindFrames, RunwayTimeline in the .acl file
 * are correctly patched when the timeline JSON data changes.
 *
 * Usage: node test/test_rebuild_timelines.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LEVELS_DIR = path.join(ROOT, 'GroundATC_Data', 'StreamingAssets', 'Airports', 'KJFK', 'Levels');
const ACL_SRC = path.join(LEVELS_DIR, 'KJFK_07-09.acl');
const ACL_TEMP = path.join(LEVELS_DIR, '_test_rebuild_timelines.acl');

const { _rebuildTimelineSections } = require('../src/acl_flight_plans');

// ─── Helpers ─────────────────────────────────────────────────────────

function check(condition, label) {
  if (condition) { console.log('  \u2713 ' + label); return true; }
  else { console.log('  \u2717 ' + label); return false; }
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

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ─── Test #1: WeatherFrames rebuild ──────────────────────────────────

function testWeatherFramesRebuild() {
  console.log('\n=== Test #1: WeatherFrames rebuild ===');

  // Setup: clean temp copy
  fs.copyFileSync(ACL_SRC, ACL_TEMP);

  // Load & modify weather data (reverse order, change some presets)
  const origData = JSON.parse(fs.readFileSync(path.join(LEVELS_DIR, 'weather_timeline.json'), 'utf-8'));
  const modifiedData = origData.map((f, i) => ({
    preset: (i % 3 === 0) ? 'TEST_PRESET_' + i : f.preset,
    time: f.time
  }));
  // Re-sort by time (the rebuild function sorts internally)
  modifiedData.sort((a, b) => {
    const t = s => { const p = s.split(':'); return +p[0]*3600 + +p[1]*60 + +p[2]; };
    return t(a.time) - t(b.time);
  });

  // Run rebuild (only WeatherFrames)
  _rebuildTimelineSections(ACL_TEMP, modifiedData, null, null);

  // Verify
  const outText = fs.readFileSync(ACL_TEMP, 'utf-8');
  let ok = true;

  // Check TEST_PRESET entries exist
  ok &= check(outText.includes('"Preset": "TEST_PRESET_0"'), 'Modified preset TEST_PRESET_0 present');
  ok &= check(outText.includes('"Preset": "TEST_PRESET_3"'), 'Modified preset TEST_PRESET_3 present');

  // Check $rlength updated
  const ws = extractSection(outText, 'WeatherFrames');
  ok &= check(ws.raw.includes('"$rlength": ' + modifiedData.length), 'WeatherFrames $rlength == ' + modifiedData.length);

  // Check all entries exist
  ok &= check(countInText(ws.raw, '"Preset":') === modifiedData.length, 'Preset count == ' + modifiedData.length);
  ok &= check(countInText(ws.raw, '"Time":') === modifiedData.length, 'Time count == ' + modifiedData.length);

  // Check WindFrames UNTOUCHED (null means no rebuild)
  const windOrig = extractSection(fs.readFileSync(ACL_SRC, 'utf-8'), 'WindFrames');
  const windOut = extractSection(outText, 'WindFrames');
  ok &= check(windOrig.raw === windOut.raw, 'WindFrames unchanged (null passed)');

  return ok;
}

// ─── Test #2: WindFrames rebuild ─────────────────────────────────────

function testWindFramesRebuild() {
  console.log('\n=== Test #2: WindFrames rebuild ===');

  fs.copyFileSync(ACL_SRC, ACL_TEMP);

  // Modify wind data aggressively
  const origData = JSON.parse(fs.readFileSync(path.join(LEVELS_DIR, 'wind_timeline.json'), 'utf-8'));
  const modifiedData = origData.map(f => ({
    direction: (f.direction + 90) % 360,
    speed: Math.min(f.speed + 3, 15),
    time: f.time
  }));

  _rebuildTimelineSections(ACL_TEMP, null, modifiedData, null);

  const outText = fs.readFileSync(ACL_TEMP, 'utf-8');
  let ok = true;

  const ws = extractSection(outText, 'WindFrames');
  ok &= check(ws.raw.includes('"$rlength": ' + modifiedData.length), 'WindFrames $rlength == ' + modifiedData.length);

  // Spot check modified values
  ok &= check(ws.raw.includes('"Direction": ' + modifiedData[0].direction), 'Modified Direction[0]=' + modifiedData[0].direction);
  ok &= check(ws.raw.includes('"Speed": ' + modifiedData[0].speed), 'Modified Speed[0]=' + modifiedData[0].speed);

  // WeatherFrames untouched
  const wxOrig = extractSection(fs.readFileSync(ACL_SRC, 'utf-8'), 'WeatherFrames');
  const wxOut = extractSection(outText, 'WeatherFrames');
  ok &= check(wxOrig.raw === wxOut.raw, 'WeatherFrames unchanged (null passed)');

  return ok;
}

// ─── Test #3: RunwayTimeline rebuild (empty timeline) ────────────────

function testRunwayTimelineEmpty() {
  console.log('\n=== Test #3: RunwayTimeline rebuild (empty) ===');

  fs.copyFileSync(ACL_SRC, ACL_TEMP);

  const modifiedData = {
    initialRunways: ['22L', '22R'],
    timeline: []
  };

  _rebuildTimelineSections(ACL_TEMP, null, null, modifiedData);

  const outText = fs.readFileSync(ACL_TEMP, 'utf-8');
  let ok = true;

  ok &= check(outText.includes('"22L"'), 'InitialRunway 22L present');
  ok &= check(outText.includes('"22R"'), 'InitialRunway 22R present');
  // Check within RunwayTimeline section only (4L appears elsewhere in scenery/flights)
  const rwForCheck = extractSection(outText, 'RunwayTimeline');
  ok &= check(!rwForCheck.raw.includes('"4L"'), 'Old InitialRunway 4L removed from RunwayTimeline');

  // Timeline $rlength should be 0
  ok &= check(rwForCheck.raw.match(/"Timeline"[\s\S]*?"\$rlength"\s*:\s*0/), 'Timeline $rlength == 0');

  return ok;
}

// ─── Test #4: RunwayTimeline rebuild WITH changes (Day.Prod) ─────────

function testRunwayTimelineWithChanges() {
  console.log('\n=== Test #4: RunwayTimeline rebuild WITH changes ===');

  const aclProd = path.join(LEVELS_DIR, 'KJFK-Day.Prod.acl');
  const jsonProd = path.join(LEVELS_DIR, 'runway_timeline_KJFK-Day.Prod.json');
  if (!fs.existsSync(aclProd) || !fs.existsSync(jsonProd)) {
    console.log('  SKIP: Day.Prod files not available');
    return true;
  }

  const ACL_TEMP2 = path.join(LEVELS_DIR, '_test_rebuild_timelines2.acl');
  fs.copyFileSync(aclProd, ACL_TEMP2);

  const origData = JSON.parse(fs.readFileSync(jsonProd, 'utf-8'));

  // Modify: add a new runway change frame
  const modifiedData = {
    initialRunways: origData.initialRunways,
    timeline: [
      ...origData.timeline,
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

  const outText = fs.readFileSync(ACL_TEMP2, 'utf-8');
  let ok = true;

  // Check the added frame
  ok &= check(outText.includes('"Time": "18:00:00"'), 'Added frame Time="18:00:00"');
  ok &= check(outText.includes('"Source": "31L"'), 'Change Source=31L present');
  ok &= check(outText.includes('"Dest": "22R"'), 'Change Dest=22R present');
  ok &= check(outText.includes('"Source": "31R"'), 'Change Source=31R present');
  ok &= check(outText.includes('"Dest": "22L"'), 'Change Dest=22L present');

  // Check $rlength matches new count
  const rw = extractSection(outText, 'RunwayTimeline');
  const tlMatch = rw.raw.match(/"Timeline"[\s\S]*?"\$rlength"\s*:\s*(\d+)/);
  ok &= check(tlMatch && parseInt(tlMatch[1], 10) === modifiedData.timeline.length,
    'Timeline $rlength == ' + modifiedData.timeline.length + ' (got ' + (tlMatch ? tlMatch[1] : '?') + ')');

  // Cleanup
  try { fs.unlinkSync(ACL_TEMP2); } catch (_) {}

  return ok;
}

// ─── Test #5: All three sections simultaneously ──────────────────────

function testAllSectionsRebuild() {
  console.log('\n=== Test #5: All 3 sections simultaneous rebuild ===');

  fs.copyFileSync(ACL_SRC, ACL_TEMP);

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
    timeline: [
      { time: '08:00:00', changes: [{ source: 'TEST', dest: 'NONE' }] }
    ]
  };

  _rebuildTimelineSections(ACL_TEMP, weatherData, windData, runwayData);

  const outText = fs.readFileSync(ACL_TEMP, 'utf-8');
  let ok = true;

  // Weather
  ok &= check(outText.includes('"Preset": "FULL_SYNC_TEST"'), 'Weather: custom preset present');
  ok &= check(countInText(extractSection(outText, 'WeatherFrames').raw, '"Preset":') === 2, 'Weather: 2 entries');

  // Wind
  ok &= check(outText.includes('"Direction": 270'), 'Wind: Direction=270 present');
  ok &= check(outText.includes('"Speed": 10'), 'Wind: Speed=10 present');
  ok &= check(countInText(extractSection(outText, 'WindFrames').raw, '"Direction":') === 2, 'Wind: 2 entries');

  // Runway
  ok &= check(outText.includes('"TEST"'), 'Runway: TEST initial runway');
  ok &= check(outText.includes('"Time": "08:00:00"'), 'Runway: timeline frame time');
  ok &= check(outText.includes('"Source": "TEST"'), 'Runway: change source');

  // Non-timeline sections preserved
  ok &= check(outText.includes('"WorldState"'), 'WorldState section preserved');
  ok &= check(outText.includes('"SceneryData"'), 'SceneryData section preserved');
  ok &= check(outText.includes('"FlightPlans"'), 'FlightPlans section preserved');

  return ok;
}

// ─── Test #6: Round-trip stability (rebuild with same data = identical) ──

function testRoundTripStability() {
  console.log('\n=== Test #6: Round-trip stability ===');

  fs.copyFileSync(ACL_SRC, ACL_TEMP);

  const weatherData = JSON.parse(fs.readFileSync(path.join(LEVELS_DIR, 'weather_timeline.json'), 'utf-8'));
  const windData = JSON.parse(fs.readFileSync(path.join(LEVELS_DIR, 'wind_timeline.json'), 'utf-8'));
  const runwayData = JSON.parse(fs.readFileSync(path.join(LEVELS_DIR, 'runway_timeline_KJFK_07-09.json'), 'utf-8'));

  _rebuildTimelineSections(ACL_TEMP, weatherData, windData, runwayData);

  const outText = fs.readFileSync(ACL_TEMP, 'utf-8');
  const srcText = fs.readFileSync(ACL_SRC, 'utf-8');

  let ok = true;

  // Each timeline section should match original (normalize line endings: ACL has \r\n, generated has \n)
  const weatherOrig = normalizeNewlines(extractSection(srcText, 'WeatherFrames').raw);
  const weatherOut = normalizeNewlines(extractSection(outText, 'WeatherFrames').raw);
  ok &= check(weatherOrig === weatherOut, 'WeatherFrames round-trip identical');

  const windOrig = normalizeNewlines(extractSection(srcText, 'WindFrames').raw);
  const windOut = normalizeNewlines(extractSection(outText, 'WindFrames').raw);
  ok &= check(windOrig === windOut, 'WindFrames round-trip identical');

  const rwOrig = normalizeNewlines(extractSection(srcText, 'RunwayTimeline').raw);
  const rwOut = normalizeNewlines(extractSection(outText, 'RunwayTimeline').raw);
  ok &= check(rwOrig === rwOut, 'RunwayTimeline round-trip identical');

  return ok;
}

// ─── Main ────────────────────────────────────────────────────────────

function main() {
  console.log('Test: _rebuildTimelineSections — E2E ACL patching');
  console.log('Reference ACL: ' + path.basename(ACL_SRC));
  console.log('Temp file: ' + path.basename(ACL_TEMP));

  if (!fs.existsSync(ACL_SRC)) {
    console.error('FATAL: Source ACL not found: ' + ACL_SRC);
    process.exit(1);
  }

  let allOk = true;
  allOk &= testWeatherFramesRebuild();
  allOk &= testWindFramesRebuild();
  allOk &= testRunwayTimelineEmpty();
  allOk &= testRunwayTimelineWithChanges();
  allOk &= testAllSectionsRebuild();
  allOk &= testRoundTripStability();

  // ── Cleanup ──
  console.log('\nCleaning up temp file...');
  try { fs.unlinkSync(ACL_TEMP); console.log('  Removed'); } catch (_) {}

  console.log('\n' + '='.repeat(60));
  if (allOk) {
    console.log('ALL TESTS PASSED');
  } else {
    console.log('SOME TESTS FAILED');
  }
  process.exit(allOk ? 0 : 1);
}

main();
