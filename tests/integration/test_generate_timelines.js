/**
 * Test: Generate ACL timeline sections from JSON
 *
 * Verifies that _generateFramesSection() and _generateRunwayTimelineSection()
 * (from src/acl_flight_plans.js) produce output identical to the ACL-embedded
 * sections when given the same JSON input.
 *
 * Usage: node test/test_generate_timelines.js --acl <path-to-.acl-file>
 *
 * Timeline JSON files are auto-discovered from the ACL's directory.
 */
const fs = require('fs');
const path = require('path');
const {
  _generateFramesSection,
  _generateRunwayTimelineSection,
} = require('../../src/acl/flight_plans');

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
    console.log('Usage: node test/test_generate_timelines.js --acl <path-to-.acl-file> [--weather <path>] [--wind <path>] [--runway <path>]');
    console.log('  --acl       Path to the .acl file to test against (required).');
    console.log('  --weather   Path to weather_timeline.json (auto-discovered if omitted).');
    console.log('  --wind      Path to wind_timeline.json (auto-discovered if omitted).');
    console.log('  --runway    Path to runway_timeline_*.json (auto-discovered if omitted).');
    process.exit(0);
  }
}
if (!aclSrc) {
  console.error('ERROR: --acl <path> is required.');
  console.error('Usage: node test/test_generate_timelines.js --acl <path-to-.acl-file>');
  process.exit(1);
}
if (!fs.existsSync(aclSrc)) {
  console.error('ERROR: File not found: ' + aclSrc);
  process.exit(1);
}

// Auto-discover timeline JSON paths
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
  const specific = path.join(aclDir, 'runway_timeline_' + aclBase + '.json');
  if (fs.existsSync(specific)) {
    runwayPath = specific;
  } else {
    const files = fs.readdirSync(aclDir).filter(f => f.startsWith('runway_timeline_') && f.endsWith('.json'));
    if (files.length > 0) runwayPath = path.join(aclDir, files[0]);
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function check(condition, label) {
  if (condition) { console.log('  ✓ ' + label); return true; }
  else { console.log('  ✗ ' + label); return false; }
}

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** Extract an object section from raw ACL text by brace-matching from sectionKey. */
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
  return text.substring(braceIdx, endIdx);
}

function parseTypeNum(typeStr) {
  if (!typeStr) return null;
  const m = typeStr.match(/^"?(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function sectionMeta(sectionText) {
  const idMatch = sectionText.match(/"\$id"\s*:\s*(\d+)/);
  const typeMatch = sectionText.match(/"\$type"\s*:\s*"([^"]+)"|\$type"\s*:\s*(\d+)/);
  let typeStr = null, typeNum = null;
  if (typeMatch) {
    typeStr = typeMatch[1] || null;
    typeNum = typeMatch[1] ? parseTypeNum(typeMatch[1]) : parseInt(typeMatch[2], 10);
  }
  return { id: idMatch ? parseInt(idMatch[1], 10) : 0, typeStr, typeNum };
}

function elemTypeFromRcontent(sectionText) {
  const rcMatch = sectionText.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return null;
  const after = sectionText.substring(rcMatch.index + rcMatch[0].length);
  const brace = after.indexOf('{');
  if (brace < 0) return null;
  const m = after.substring(brace).match(/"\$type"\s*:\s*"([^"]+)"|\$type"\s*:\s*(\d+)/);
  if (!m) return null;
  return m[1] ? parseTypeNum(m[1]) : parseInt(m[2], 10);
}

function metaFrames(sectionText) {
  const parent = sectionMeta(sectionText);
  return { parentId: parent.id, parentTypeNum: parent.typeNum, parentTypeStr: parent.typeStr, elemTypeNum: elemTypeFromRcontent(sectionText) };
}

function metaRunway(sectionText) {
  const parent = sectionMeta(sectionText);

  let irId = 0, irType = 8;
  const irIdx = sectionText.indexOf('"InitialRunways"');
  if (irIdx >= 0) {
    let depth = 0, start = -1, end = -1;
    for (let i = irIdx; i < sectionText.length; i++) {
      if (sectionText[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (sectionText[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (start >= 0) {
      const ir = sectionText.substring(start, end);
      irId = parseInt((ir.match(/"\$id"\s*:\s*(\d+)/) || [0, 0])[1], 10);
      irType = parseInt((ir.match(/"\$type"\s*:\s*(\d+)/) || [0, 8])[1], 10);
    }
  }

  let tlId = 0, tlTypeNum = null, tlTypeStr = null, tlElemTypeNum = null;
  let changesArrTypeNum = null, changeElemTypeNum = null;
  const tlIdx = sectionText.indexOf('"Timeline"');
  if (tlIdx >= 0) {
    let depth = 0, start = -1, end = -1;
    for (let i = tlIdx; i < sectionText.length; i++) {
      if (sectionText[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (sectionText[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (start >= 0) {
      const tl = sectionText.substring(start, end);
      tlId = parseInt((tl.match(/"\$id"\s*:\s*(\d+)/) || [0, 0])[1], 10);
      const ttm = tl.match(/"\$type"\s*:\s*"([^"]+)"|\$type"\s*:\s*(\d+)/);
      if (ttm) { tlTypeStr = ttm[1] || null; tlTypeNum = ttm[1] ? parseTypeNum(ttm[1]) : parseInt(ttm[2], 10); }
      tlElemTypeNum = elemTypeFromRcontent(tl);
      const chIdx = tl.indexOf('"Changes"');
      if (chIdx >= 0) {
        let chDepth = 0, chStart = -1, chEnd = -1;
        for (let i = chIdx; i < tl.length; i++) {
          if (tl[i] === '{') { if (chDepth === 0) chStart = i; chDepth++; }
          else if (tl[i] === '}') { chDepth--; if (chDepth === 0) { chEnd = i + 1; break; } }
        }
        if (chStart >= 0) {
          const ch = tl.substring(chStart, chEnd);
          const ctm = ch.match(/"\$type"\s*:\s*"([^"]+)"|\$type"\s*:\s*(\d+)/);
          if (ctm) changesArrTypeNum = ctm[1] ? parseTypeNum(ctm[1]) : parseInt(ctm[2], 10);
          changeElemTypeNum = elemTypeFromRcontent(ch);
        }
      }
    }
  }

  // Fallback: when timeline is empty, compute element type numbers from
  // tlTypeNum using known fixed offsets (verified across all .acl files).
  if (tlTypeNum !== null) {
    if (tlElemTypeNum === null) tlElemTypeNum = tlTypeNum + 1;
    if (changesArrTypeNum === null) changesArrTypeNum = tlTypeNum + 2;
    if (changeElemTypeNum === null) changeElemTypeNum = tlTypeNum + 3;
  }

  return {
    parentId: parent.id, parentTypeNum: parent.typeNum, parentTypeStr: parent.typeStr,
    irId, irType, tlId, tlTypeNum, tlTypeStr, tlElemTypeNum,
    changesArrTypeNum, changeElemTypeNum,
  };
}

// ─── Test #1: WindFrames ─────────────────────────────────────

function testWindFrames() {
  console.log('\n=== Test #1: WindFrames from wind_timeline.json ===');
  if (!windPath) { console.log('  SKIP: no wind_timeline.json found'); return true; }

  const aclText = fs.readFileSync(aclSrc, 'utf-8');
  const jsonData = JSON.parse(fs.readFileSync(windPath, 'utf-8'));
  const orig = extractSection(aclText, 'WindFrames');
  if (!orig) { console.log('  SKIP: no WindFrames section in ACL'); return true; }

  const meta = metaFrames(orig);
  let ok = true;
  ok &= check(!!meta.parentTypeNum, 'Parent $type number parsed');
  ok &= check(!!meta.elemTypeNum, 'Element $type number parsed');

  const fieldMap = {
    direction: { acl: 'Direction', type: 'number' },
    speed:     { acl: 'Speed',     type: 'number' },
    time:      { acl: 'Time',      type: 'string' },
  };
  const gen = _generateFramesSection(jsonData, meta.parentId, meta.elemTypeNum, meta.parentTypeNum, 'WindFrames', 'WindFrame[]', 'WindFrame', fieldMap);

  ok &= check(gen.includes('"$rlength": ' + jsonData.length), 'rlength == ' + jsonData.length);
  const genObj = gen.substring(gen.indexOf('{'));
  ok &= check(normalizeText(orig) === normalizeText(genObj), 'Generated matches original ACL section 1:1');

  for (let i = 0; i < jsonData.length; i++) {
    const f = jsonData[i];
    ok &= check(gen.includes('"Direction": ' + f.direction + ',') || gen.includes('"Direction": ' + f.direction + '\n'),
      'Frame[' + i + '] Direction=' + f.direction);
    ok &= check(gen.includes('"Speed": ' + f.speed + ',') || gen.includes('"Speed": ' + f.speed + '\n'),
      'Frame[' + i + '] Speed=' + f.speed);
    ok &= check(gen.includes('"Time": "' + f.time + '"'), 'Frame[' + i + '] Time="' + f.time + '"');
  }
  return ok;
}

// ─── Test #2: RunwayTimeline (empty) ─────────────────────────

function testRunwayTimeline() {
  console.log('\n=== Test #2: RunwayTimeline (empty timeline) ===');
  if (!runwayPath) { console.log('  SKIP: no runway_timeline_*.json found'); return true; }

  const aclText = fs.readFileSync(aclSrc, 'utf-8');
  const jsonData = JSON.parse(fs.readFileSync(runwayPath, 'utf-8'));
  const orig = extractSection(aclText, 'RunwayTimeline');
  if (!orig) { console.log('  SKIP: no RunwayTimeline section in ACL'); return true; }

  const meta = metaRunway(orig);
  let ok = true;
  ok &= check(meta.irType === 8, 'InitialRunways $type == 8 (got ' + meta.irType + ')');
  ok &= check(!!meta.tlTypeNum, 'Timeline $type number parsed (' + meta.tlTypeNum + ')');

  const gen = _generateRunwayTimelineSection(jsonData, meta);
  const genObj = gen.substring(gen.indexOf('{'));
  ok &= check(normalizeText(orig) === normalizeText(genObj), 'Generated matches original ACL section 1:1');

  for (let i = 0; i < jsonData.initialRunways.length; i++)
    ok &= check(gen.includes('"' + jsonData.initialRunways[i] + '"'), 'InitialRunways[' + i + ']="' + jsonData.initialRunways[i] + '"');

  return ok;
}

// ─── Test #3: WeatherFrames ──────────────────────────────────

function testWeatherFrames() {
  console.log('\n=== Test #3: WeatherFrames from weather_timeline.json ===');
  if (!weatherPath) { console.log('  SKIP: no weather_timeline.json found'); return true; }

  const aclText = fs.readFileSync(aclSrc, 'utf-8');
  const jsonData = JSON.parse(fs.readFileSync(weatherPath, 'utf-8'));
  const orig = extractSection(aclText, 'WeatherFrames');
  if (!orig) { console.log('  SKIP: no WeatherFrames section in ACL'); return true; }

  const meta = metaFrames(orig);
  let ok = true;
  ok &= check(!!meta.parentTypeNum, 'Parent $type number parsed');
  ok &= check(!!meta.elemTypeNum, 'Element $type number parsed');

  const fieldMap = {
    preset: { acl: 'Preset', type: 'string' },
    time:   { acl: 'Time',   type: 'string' },
  };
  const gen = _generateFramesSection(jsonData, meta.parentId, meta.elemTypeNum, meta.parentTypeNum, 'WeatherFrames', 'WeatherFrame[]', 'WeatherFrame', fieldMap);

  ok &= check(gen.includes('"$rlength": ' + jsonData.length), 'rlength == ' + jsonData.length);
  const genObj = gen.substring(gen.indexOf('{'));
  ok &= check(normalizeText(orig) === normalizeText(genObj), 'Generated matches original ACL section 1:1');

  for (let i = 0; i < jsonData.length; i++) {
    const f = jsonData[i];
    ok &= check(gen.includes('"Preset": "' + f.preset + '"'), 'Frame[' + i + '] Preset="' + f.preset + '"');
    ok &= check(gen.includes('"Time": "' + f.time + '"'), 'Frame[' + i + '] Time="' + f.time + '"');
  }
  return ok;
}

// ─── Test #4: RunwayTimeline WITH changes ────────────────────

function testRunwayTimelineWithChanges() {
  console.log('\n=== Test #4: RunwayTimeline WITH changes ===');

  // Find a runway JSON that has non-empty timeline
  let rwWithChanges = runwayPath;
  if (rwWithChanges) {
    const data = JSON.parse(fs.readFileSync(rwWithChanges, 'utf-8'));
    if (!data.timeline || data.timeline.length === 0) rwWithChanges = null;
  }
  // Only run this test if the ACL's own paired runway JSON has changes.
  // Never borrow from another file — that creates a cross-file mismatch.
  if (!rwWithChanges) {
    console.log('  SKIP: paired runway_timeline_*.json has no changes (empty timeline)');
    return true;
  }

  const aclText = fs.readFileSync(aclSrc, 'utf-8');
  const jsonData = JSON.parse(fs.readFileSync(rwWithChanges, 'utf-8'));
  const orig = extractSection(aclText, 'RunwayTimeline');
  if (!orig) { console.log('  SKIP: no RunwayTimeline section in ACL'); return true; }

  const meta = metaRunway(orig);
  let ok = true;
  ok &= check(meta.tlElemTypeNum !== null, 'Timeline element $type: ' + meta.tlElemTypeNum);
  ok &= check(meta.changesArrTypeNum !== null, 'Changes array $type: ' + meta.changesArrTypeNum);
  ok &= check(meta.changeElemTypeNum !== null, 'Change element $type: ' + meta.changeElemTypeNum);

  const gen = _generateRunwayTimelineSection(jsonData, meta);
  const genObj = gen.substring(gen.indexOf('{'));
  ok &= check(normalizeText(orig) === normalizeText(genObj), 'Generated matches original ACL section 1:1 (with changes)');

  const tl = jsonData.timeline || [];
  for (let i = 0; i < tl.length; i++) {
    const t = tl[i];
    ok &= check(gen.includes('"Time": "' + t.time + '"'), 'Timeline[' + i + '] Time="' + t.time + '"');
    for (let j = 0; j < (t.changes || []).length; j++) {
      const c = t.changes[j];
      ok &= check(gen.includes('"Source": "' + c.source + '"'), '  Change[' + j + '] Source="' + c.source + '"');
      ok &= check(gen.includes('"Dest": "' + c.dest + '"'), '  Change[' + j + '] Dest="' + c.dest + '"');
    }
  }
  return ok;
}

// ─── Main ─────────────────────────────────────────────────────

function main() {
  console.log('Test: Generate ACL Timeline Sections from JSON');
  console.log('ACL:  ' + aclSrc);
  if (weatherPath) console.log('Weather: ' + path.basename(weatherPath));
  if (windPath) console.log('Wind:    ' + path.basename(windPath));
  if (runwayPath) console.log('Runway:  ' + path.basename(runwayPath));

  let allOk = true;
  allOk &= testWindFrames();
  allOk &= testRunwayTimeline();
  allOk &= testWeatherFrames();
  allOk &= testRunwayTimelineWithChanges();

  console.log('\n' + '='.repeat(60));
  console.log(allOk ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
  process.exit(allOk ? 0 : 1);
}

main();
