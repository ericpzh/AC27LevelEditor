/**
 * Test: ACL Aircraft → FlightPlan Linkage Validation
 *
 * Verifies every Aircraft entry's FlightPlanGuid resolves to
 * a valid FlightPlan entry in the same file. Broken links cause
 * NullReferenceException crashes in-game.
 *
 * v4 schema: StaticData.$blobdoc StaticItems flight-plan:* definitions —
 * every "flight-plan:<REG>" reference must resolve to a definition
 * whose Registration matches its key
 *
 * Usage:
 *   node test/test_acl_linkage.js --acl <path-to-.acl-file>
 */

const fs = require('fs');
const path = require('path');
const { readAclText } = require('../../src/acl/gatcarc');

let aclPath = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--acl' && i + 1 < process.argv.length) {
    aclPath = path.resolve(process.argv[++i]);
  } else if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node test/test_acl_linkage.js --acl <path-to-.acl-file>');
    console.log('Validates Aircraft → FlightPlan linkage integrity (v4).');
    process.exit(0);
  }
}

if (!aclPath) {
  console.error('ERROR: --acl <path> is required');
  process.exit(1);
}

console.log('ACL:', aclPath);
const text = readAclText(aclPath);

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

runV4LinkageCheck(text);
