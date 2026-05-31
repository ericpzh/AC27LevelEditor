/**
 * Test: Generate ACL timeline sections from JSON
 *
 * #1  WindFrames        ← wind_timeline.json
 * #2  RunwayTimeline    ← runway_timeline_XXX.json
 * #3  WeatherFrames     ← weather_timeline.json
 *
 * Usage: node test/test_generate_timelines.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LEVELS_DIR = path.join(ROOT, 'GroundATC_Data', 'StreamingAssets', 'Airports', 'KJFK', 'Levels');

const REF_ACL = path.join(LEVELS_DIR, 'KJFK_07-09.acl');

// ─── Helpers ─────────────────────────────────────────────────

function check(condition, label) {
  if (condition) { console.log('  \u2713 ' + label); return true; }
  else { console.log('  \u2717 ' + label); return false; }
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

/** Extract $id and $type metadata from any ACL section. */
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

/** Find element $type from first child in $rcontent. */
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

/** Parse all metadata needed for WindFrames/WeatherFrames. */
function metaFrames(sectionText) {
  const parent = sectionMeta(sectionText);
  return {
    parentId: parent.id,
    parentTypeNum: parent.typeNum,
    parentTypeStr: parent.typeStr,
    elemTypeNum: elemTypeFromRcontent(sectionText),
  };
}

/** Parse all metadata needed for RunwayTimeline. */
function metaRunway(sectionText) {
  const parent = sectionMeta(sectionText);

  // InitialRunways
  const irIdx = sectionText.indexOf('"InitialRunways"');
  let irId = 0, irType = 8;
  if (irIdx >= 0) {
    let depth = 0; let start = -1, end = -1;
    for (let i = irIdx; i < sectionText.length; i++) {
      if (sectionText[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (sectionText[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (start >= 0) {
      const ir = sectionText.substring(start, end);
      const m = ir.match(/"\$id"\s*:\s*(\d+)/);
      irId = m ? parseInt(m[1], 10) : 0;
      const tm = ir.match(/"\$type"\s*:\s*(\d+)/);
      irType = tm ? parseInt(tm[1], 10) : 8;
    }
  }

  // Timeline
  const tlIdx = sectionText.indexOf('"Timeline"');
  let tlId = 0, tlTypeNum = null, tlTypeStr = null;
  let tlElemTypeNum = null;
  let changesArrTypeNum = null, changeElemTypeNum = null;
  if (tlIdx >= 0) {
    let depth = 0, start = -1, end = -1;
    for (let i = tlIdx; i < sectionText.length; i++) {
      if (sectionText[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (sectionText[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (start >= 0) {
      const tl = sectionText.substring(start, end);
      const tm = tl.match(/"\$id"\s*:\s*(\d+)/);
      tlId = tm ? parseInt(tm[1], 10) : 0;
      const ttm = tl.match(/"\$type"\s*:\s*"([^"]+)"|\$type"\s*:\s*(\d+)/);
      if (ttm) {
        tlTypeStr = ttm[1] || null;
        tlTypeNum = ttm[1] ? parseTypeNum(ttm[1]) : parseInt(ttm[2], 10);
      }
      tlElemTypeNum = elemTypeFromRcontent(tl);

      // Extract Changes metadata if timeline has entries
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

  return {
    parentId: parent.id, parentTypeNum: parent.typeNum, parentTypeStr: parent.typeStr,
    irId, irType, tlId, tlTypeNum, tlTypeStr, tlElemTypeNum,
    changesArrTypeNum, changeElemTypeNum,
  };
}

// ─── Generators ─────────────────────────────────────────────

function generateFramesSection(frames, meta, fieldMap, parentName, arrayTypeName, elemTypeName) {
  const L = [];
  const I = '    ';
  L.push(`${I}"${parentName}": {`);
  L.push(`${I}    "$id": ${meta.parentId},`);
  L.push(`${I}    "$type": "${meta.parentTypeNum}|ContextCross.States.${arrayTypeName}, GroundATC.Core",`);
  L.push(`${I}    "$rlength": ${frames.length},`);
  L.push(`${I}    "$rcontent": [`);

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const fid = meta.parentId + 1 + i;
    const keys = Object.keys(fieldMap);
    L.push(`${I}        {`);
    L.push(`${I}            "$id": ${fid},`);
    if (i === 0)
      L.push(`${I}            "$type": "${meta.elemTypeNum}|ContextCross.States.${elemTypeName}, GroundATC.Core",`);
    else
      L.push(`${I}            "$type": ${meta.elemTypeNum},`);

    for (let k = 0; k < keys.length; k++) {
      const jk = keys[k];
      const { acl, type } = fieldMap[jk];
      const comma = (k < keys.length - 1) ? ',' : '';
      if (type === 'string')
        L.push(`${I}            "${acl}": "${f[jk]}"${comma}`);
      else
        L.push(`${I}            "${acl}": ${f[jk]}${comma}`);
    }

    L.push(`${I}        }${i < frames.length - 1 ? ',' : ''}`);
  }

  L.push(`${I}    ]`);
  L.push(`${I}}`);
  return L.join('\n');
}

function generateRunwayTimelineSection(data, meta) {
  const L = [];
  const I = '    ';
  const ir = data.initialRunways || [];
  const tl = data.timeline || [];

  L.push(`${I}"RunwayTimeline": {`);
  L.push(`${I}    "$id": ${meta.parentId},`);
  L.push(`${I}    "$type": "${meta.parentTypeNum}|ContextCross.States.RunwayTimelineData, GroundATC.Core",`);

  // InitialRunways
  L.push(`${I}    "InitialRunways": {`);
  L.push(`${I}        "$id": ${meta.irId},`);
  L.push(`${I}        "$type": ${meta.irType},`);
  L.push(`${I}        "$rlength": ${ir.length},`);
  L.push(`${I}        "$rcontent": [`);
  for (let i = 0; i < ir.length; i++)
    L.push(`${I}            "${ir[i]}"${i < ir.length - 1 ? ',' : ''}`);
  L.push(`${I}        ]`);
  L.push(`${I}    },`);

  // Timeline
  L.push(`${I}    "Timeline": {`);
  L.push(`${I}        "$id": ${meta.tlId},`);
  if (meta.tlTypeStr)
    L.push(`${I}        "$type": "${meta.tlTypeNum}|ContextCross.States.RunwayChangeFrame[], GroundATC.Core",`);
  else
    L.push(`${I}        "$type": ${meta.tlTypeNum},`);
  L.push(`${I}        "$rlength": ${tl.length},`);
  L.push(`${I}        "$rcontent": [`);

  if (tl.length === 0) {
    L.push(`${I}        ]`);
  } else {
    for (let i = 0; i < tl.length; i++) {
      const e = tl[i];
      const ch = e.changes || [];
      const fid = meta.tlId + 1 + i;
      const chId = meta.tlId + 1 + tl.length + i * 3;

      L.push(`${I}            {`);
      L.push(`${I}                "$id": ${fid},`);
      L.push(`${I}                "$type": ${i === 0 ? '"' + meta.tlElemTypeNum + '|ContextCross.States.RunwayChangeFrame, GroundATC.Core"' : meta.tlElemTypeNum},`);
      L.push(`${I}                "Time": "${e.time}",`);

      L.push(`${I}                "Changes": {`);
      L.push(`${I}                    "$id": ${chId},`);
      L.push(`${I}                    "$type": "${meta.changesArrTypeNum}|ContextCross.States.RunwayChange[], GroundATC.Core",`);
      L.push(`${I}                    "$rlength": ${ch.length},`);
      L.push(`${I}                    "$rcontent": [`);

      for (let j = 0; j < ch.length; j++) {
        const c = ch[j];
        const cid = chId + 1 + j;
        L.push(`${I}                        {`);
        L.push(`${I}                            "$id": ${cid},`);
        L.push(`${I}                            "$type": ${j === 0 ? '"' + meta.changeElemTypeNum + '|ContextCross.States.RunwayChange, GroundATC.Core"' : meta.changeElemTypeNum},`);
        L.push(`${I}                            "Source": "${c.source}",`);
        L.push(`${I}                            "Dest": "${c.dest}"`);
        L.push(`${I}                        }${j < ch.length - 1 ? ',' : ''}`);
      }

      L.push(`${I}                    ]`);
      L.push(`${I}                }`);
      L.push(`${I}            }${i < tl.length - 1 ? ',' : ''}`);
    }
    L.push(`${I}        ]`);
  }

  L.push(`${I}    }`);
  L.push(`${I}}`);
  return L.join('\n');
}

// ─── Test Runners ───────────────────────────────────────────

function testWindFrames() {
  console.log('\n=== Test #1: WindFrames from wind_timeline.json ===');

  const aclText = fs.readFileSync(REF_ACL, 'utf-8');
  const jsonData = JSON.parse(fs.readFileSync(path.join(LEVELS_DIR, 'wind_timeline.json'), 'utf-8'));
  const orig = extractSection(aclText, 'WindFrames');
  const meta = metaFrames(orig);

  let ok = true;
  ok &= check(!!meta.parentTypeNum, 'Parent $type number parsed');
  ok &= check(!!meta.elemTypeNum, 'Element $type number parsed');

  const fieldMap = {
    direction: { acl: 'Direction', type: 'number' },
    speed:     { acl: 'Speed',     type: 'number' },
    time:      { acl: 'Time',      type: 'string' },
  };
  const gen = generateFramesSection(jsonData, meta, fieldMap, 'WindFrames', 'WindFrame[]', 'WindFrame');

  ok &= check(gen.includes('"$rlength": ' + jsonData.length), `rlength == ${jsonData.length}`);
  // Strip parent key prefix ("WindFrames": ) for 1:1 comparison since orig starts with '{'
  const genObj = gen.substring(gen.indexOf('{'));
  ok &= check(normalizeText(orig) === normalizeText(genObj), 'Generated matches original ACL section 1:1');

  // Verify each frame
  for (let i = 0; i < jsonData.length; i++) {
    const f = jsonData[i];
    ok &= check(gen.includes(`"Direction": ${f.direction},`) || gen.includes(`"Direction": ${f.direction}\n`), `Frame[${i}] Direction=${f.direction}`);
    ok &= check(gen.includes(`"Speed": ${f.speed},`) || gen.includes(`"Speed": ${f.speed}\n`), `Frame[${i}] Speed=${f.speed}`);
    ok &= check(gen.includes(`"Time": "${f.time}"`), `Frame[${i}] Time="${f.time}"`);
  }

  return ok;
}

function testRunwayTimeline() {
  console.log('\n=== Test #2: RunwayTimeline from runway_timeline_KJFK_07-09.json ===');

  const aclText = fs.readFileSync(REF_ACL, 'utf-8');
  const jsonData = JSON.parse(fs.readFileSync(path.join(LEVELS_DIR, 'runway_timeline_KJFK_07-09.json'), 'utf-8'));
  const orig = extractSection(aclText, 'RunwayTimeline');
  const meta = metaRunway(orig);

  let ok = true;
  ok &= check(meta.irType === 8, `InitialRunways $type == 8 (got ${meta.irType})`);
  ok &= check(!!meta.tlTypeNum, `Timeline $type number parsed (${meta.tlTypeNum})`);

  const gen = generateRunwayTimelineSection(jsonData, meta);

  const genObj = gen.substring(gen.indexOf('{'));
  ok &= check(normalizeText(orig) === normalizeText(genObj), 'Generated matches original ACL section 1:1');

  for (let i = 0; i < jsonData.initialRunways.length; i++)
    ok &= check(gen.includes('"' + jsonData.initialRunways[i] + '"'), `InitialRunways[${i}]="${jsonData.initialRunways[i]}"`);

  ok &= check(gen.includes('"$rlength": 0') || gen.includes('"$rlength":0'), 'Timeline rlength == 0');

  return ok;
}

function testWeatherFrames() {
  console.log('\n=== Test #3: WeatherFrames from weather_timeline.json ===');

  const aclText = fs.readFileSync(REF_ACL, 'utf-8');
  const jsonData = JSON.parse(fs.readFileSync(path.join(LEVELS_DIR, 'weather_timeline.json'), 'utf-8'));
  const orig = extractSection(aclText, 'WeatherFrames');
  const meta = metaFrames(orig);

  let ok = true;
  ok &= check(!!meta.parentTypeNum, 'Parent $type number parsed');
  ok &= check(!!meta.elemTypeNum, 'Element $type number parsed');

  const fieldMap = {
    preset: { acl: 'Preset', type: 'string' },
    time:   { acl: 'Time',   type: 'string' },
  };
  const gen = generateFramesSection(jsonData, meta, fieldMap, 'WeatherFrames', 'WeatherFrame[]', 'WeatherFrame');

  ok &= check(gen.includes('"$rlength": ' + jsonData.length), `rlength == ${jsonData.length}`);
  const genObj = gen.substring(gen.indexOf('{'));
  ok &= check(normalizeText(orig) === normalizeText(genObj), 'Generated matches original ACL section 1:1');

  for (let i = 0; i < jsonData.length; i++) {
    const f = jsonData[i];
    ok &= check(gen.includes(`"Preset": "${f.preset}"`), `Frame[${i}] Preset="${f.preset}"`);
    ok &= check(gen.includes(`"Time": "${f.time}"`), `Frame[${i}] Time="${f.time}"`);
  }

  return ok;
}

/**
 * Test #2b: RunwayTimeline WITH changes (Day.Prod)
 * Verifies the generation handles timeline entries with runway changes.
 */
function testRunwayTimelineWithChanges() {
  console.log('\n=== Test #2b: RunwayTimeline WITH changes (Day.Prod) ===');

  const aclPath = path.join(LEVELS_DIR, 'KJFK-Day.Prod.acl');
  const jsonPath = path.join(LEVELS_DIR, 'runway_timeline_KJFK-Day.Prod.json');
  if (!fs.existsSync(aclPath) || !fs.existsSync(jsonPath)) {
    console.log('  SKIP: Day.Prod files not available');
    return true;
  }

  const aclText = fs.readFileSync(aclPath, 'utf-8');
  const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const orig = extractSection(aclText, 'RunwayTimeline');
  const meta = metaRunway(orig);

  let ok = true;
  ok &= check(meta.tlElemTypeNum !== null, `Timeline element $type: ${meta.tlElemTypeNum}`);
  ok &= check(meta.changesArrTypeNum !== null, `Changes array $type: ${meta.changesArrTypeNum}`);
  ok &= check(meta.changeElemTypeNum !== null, `Change element $type: ${meta.changeElemTypeNum}`);

  const gen = generateRunwayTimelineSection(jsonData, meta);
  const genObj = gen.substring(gen.indexOf('{'));
  ok &= check(normalizeText(orig) === normalizeText(genObj), 'Generated matches original ACL section 1:1 (with changes)');

  // Verify timeline data
  const tl = jsonData.timeline || [];
  for (let i = 0; i < tl.length; i++) {
    const t = tl[i];
    ok &= check(gen.includes(`"Time": "${t.time}"`), `Timeline[${i}] Time="${t.time}"`);
    for (let j = 0; j < (t.changes || []).length; j++) {
      const c = t.changes[j];
      ok &= check(gen.includes(`"Source": "${c.source}"`), `  Change[${j}] Source="${c.source}"`);
      ok &= check(gen.includes(`"Dest": "${c.dest}"`), `  Change[${j}] Dest="${c.dest}"`);
    }
  }

  return ok;
}

// ─── Main ───────────────────────────────────────────────────

function main() {
  console.log('Test: Generate ACL Timeline Sections from JSON');
  console.log('Reference ACL: ' + path.basename(REF_ACL));

  let allOk = true;
  allOk &= testWindFrames();
  allOk &= testRunwayTimeline();
  allOk &= testWeatherFrames();
  allOk &= testRunwayTimelineWithChanges();

  console.log('\n' + '='.repeat(60));
  if (allOk) {
    console.log('ALL TESTS PASSED');
  } else {
    console.log('SOME TESTS FAILED');
  }
  process.exit(allOk ? 0 : 1);
}

main();
