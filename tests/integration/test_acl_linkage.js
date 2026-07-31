/**
 * Test: ACL Aircraft → FlightPlan Linkage Validation
 *
 * Verifies every Aircraft entry's FlightPlanGuid resolves to
 * a valid FlightPlan entry in the same file. Broken links cause
 * NullReferenceException crashes in-game.
 *
 * Works on both schemas:
 *   - v2/v3: WorldState.Aircrafts → WorldState.FlightPlans (FlightPlanGuid)
 *   - v4:    StaticData.$blobdoc StaticItems flight-plan:* definitions —
 *            every "flight-plan:<REG>" reference must resolve to a definition
 *            whose Registration matches its key
 *
 * Usage:
 *   node test/test_acl_linkage.js --acl <path-to-.acl-file>
 */

const fs = require('fs');
const path = require('path');
const { readAclText } = require('../../src/acl/gatcarc');
const { detectSchemaVersion } = require('../../src/acl/parser');

let aclPath = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--acl' && i + 1 < process.argv.length) {
    aclPath = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node test/test_acl_linkage.js --acl <path-to-.acl-file>');
    console.log('Validates Aircraft → FlightPlan linkage integrity (v2/v3 + v4).');
    process.exit(0);
  }
}

if (!aclPath) {
  console.error('ERROR: --acl <path> is required');
  process.exit(1);
}

console.log('ACL:', aclPath);
const text = readAclText(aclPath);
const isV4 = detectSchemaVersion(text) === 4;
console.log('Schema:', isV4 ? 'v4' : 'v2/v3');

// ─── Parse helpers ────────────────────────────────────────────
function findArrayEnd(t, start) {
  let d = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') d++;
    else if (t[i] === '}') {
      d--;
      if (d === 0) { let j = i + 1; while (j < t.length && ' \t\n\r'.includes(t[j])) j++; if (j < t.length && t[j] === ']') return j + 1; }
    } else if (t[i] === ']' && d === 0) return i + 1;
  }
  return null;
}

function parseRcontent(text, startAfter) {
  const idx = text.indexOf('"$rcontent"', startAfter);
  if (idx < 0) return [];
  const open = text.indexOf('[', idx);
  let d = 0, entries = [], s = -1;
  const end = findArrayEnd(text, open + 1);
  const limit = end || text.length;
  for (let i = open + 1; i < limit; i++) {
    if (text[i] === '{') { if (d === 0) s = i; d++; }
    else if (text[i] === '}') { d--; if (d === 0 && s >= 0) { entries.push(text.substring(s, i + 1)); s = -1; } }
  }
  return entries;
}

function getV(e) {
  const vi = e.indexOf('"$v"'); if (vi < 0) return null;
  const c = e.indexOf(':', vi); const b = e.indexOf('{', c);
  let d = 1, ed = b + 1;
  for (; ed < e.length; ed++) { if (e[ed] === '{') d++; else if (e[ed] === '}') { d--; if (d === 0) break; } }
  return e.substring(b, ed + 1);
}

function getField(v, key) {
  const m = v.match(new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*"([^"]*)"'));
  return m ? m[1] : '';
}
function getInt(v, key) {
  const m = v.match(new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*(-?\\d+)'));
  return m ? parseInt(m[1]) : null;
}

// ─── v2/v3: WorldState.Aircrafts → FlightPlans linkage ─────────
function runV2v3LinkageCheck(text) {
  const wsIdx = text.indexOf('"WorldState"');
  const acIdx = text.indexOf('"Aircrafts"', wsIdx);
  const fpIdx = text.indexOf('"FlightPlans"');

  const acEntries = parseRcontent(text, acIdx);
  const fpEntries = parseRcontent(text, fpIdx);

  // Build FlightPlan map
  const fpMap = new Map();
  for (const e of fpEntries) {
    const v = getV(e); if (!v) continue;
    const g = getField(v, 'Guid');
    if (g) {
      const cs = getField(v, 'CallSign');
      const at = getField(v, 'AircraftType');
      const arr = v.includes('"Arrival"') && !v.includes('"Arrival": null');
      fpMap.set(g, { cs, at, arr });
    }
  }

  console.log(`\nFlightPlans: ${fpEntries.length} entries, ${fpMap.size} with valid GUIDs`);
  console.log(`Aircrafts:   ${acEntries.length} entries\n`);

  // ─── Validate ──────────────────────────────────────────────────
  let pass = 0, fail = 0;
  const stateCount = {};

  console.log('State  AC-GUID                              FP-GUID                              FP-CallSign      Status');
  console.log('-'.repeat(105));

  for (const e of acEntries) {
    const v = getV(e); if (!v) { fail++; console.log('  ??  (no $v block)'); continue; }
    const state = getInt(v, 'State') || '?';
    stateCount[state] = (stateCount[state] || 0) + 1;
    const acGuid = getField(v, 'Guid');
    const fpGuid = getField(v, 'FlightPlanGuid');
    const fpData = fpGuid ? fpMap.get(fpGuid) : null;

    if (fpData) {
      pass++;
      console.log(`State ${String(state).padStart(2)}  ${acGuid}  ${fpGuid}  ${(fpData.cs||'').padEnd(16)} ✓`);
    } else {
      fail++;
      console.log(`State ${String(state).padStart(2)}  ${acGuid}  ${fpGuid || '(none)'.padEnd(36)} ${'NOT IN FlightPlans'.padEnd(16)} ✗ BROKEN`);
    }
  }

  console.log(`\nState distribution:`, Object.entries(stateCount).map(([k,v]) => `State ${k}=${v}`).join(', '));
  console.log(`\nLinked: ${pass}  Broken: ${fail}`);

  if (fail > 0) {
    console.log('\nFAIL: ' + fail + ' broken FlightPlanGuid link(s) found.');
    console.log('These will cause NullReferenceException crashes in-game.');
    process.exit(1);
  } else {
    console.log('\nPASS: All Aircraft entries have valid FlightPlan links.');
    process.exit(0);
  }
}

// ─── v4: StaticItems flight-plan:* definitions + $fstrref refs ─
// Aircraft are runtime-generated in v4, so no AircraftState→FlightPlanGuid
// links exist in static data. Flight plans live in StaticData.$blobdoc
// StaticItems as dictionary entries keyed "$k": "flight-plan:<REG>" (the $v
// declares the matching Registration). Runtime entity entries reference them
// via $fstrref:"flight-plan:<REG>" tokens — every such reference must resolve
// to a definition.
function runV4LinkageCheck(text) {
  // Definitions: "$k": "flight-plan:<REG>" entries whose $v declares the
  // same Registration as the key (FlightPlanStaticItem entries).
  // (Other dictionaries may reuse flight-plan:* keys without a Registration —
  // they are not authoritative definitions.)
  const defRe = /"\$k":\s*"flight-plan:([^"]+)"/g;
  const defCandidates = [];
  let m;
  while ((m = defRe.exec(text)) !== null) defCandidates.push({ reg: m[1], idx: m.index });

  const defs = new Set();
  for (let i = 0; i < defCandidates.length; i++) {
    const d = defCandidates[i];
    const windowEnd = i + 1 < defCandidates.length ? defCandidates[i + 1].idx : d.idx + 5000;
    const vBlock = text.substring(d.idx, windowEnd);
    const rm = vBlock.match(/"Registration"\s*:\s*"([^"]*)"/);
    if (rm && rm[1] === d.reg) defs.add(d.reg);
  }

  // References: $fstrref:"flight-plan:<REG>" must resolve to a definition
  // (NOTE: regex must be hoisted — a fresh /g regex restarts from position 0)
  const refRe = /\$fstrref:\s*"flight-plan:([^"]+)"/g;
  let refs = 0, broken = 0;
  const brokenRefs = [];
  while ((m = refRe.exec(text)) !== null) {
    refs++;
    if (!defs.has(m[1])) { broken++; brokenRefs.push(m[1]); }
  }

  console.log(`\nFlightPlans (StaticItems flight-plan:* with Registration): ${defs.size} unique`);
  console.log(`$fstrref references:      ${refs}`);
  console.log(`Broken:                    ${broken}`);
  if (brokenRefs.length) console.log(`  Unresolved: ${[...new Set(brokenRefs)].join(', ')}`);

  if (broken > 0) {
    console.log('\nFAIL: ' + broken + ' broken flight-plan link(s) found.');
    console.log('These will cause NullReferenceException crashes in-game.');
    process.exit(1);
  } else {
    console.log('\nPASS: All $fstrref flight-plan references resolve to StaticItems definitions.');
    process.exit(0);
  }
}

if (isV4) runV4LinkageCheck(text);
else runV2v3LinkageCheck(text);
