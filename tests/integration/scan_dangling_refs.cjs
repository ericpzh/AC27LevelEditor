#!/usr/bin/env node
/**
 * Dangling-$iref scanner for .acl levels.
 *
 * Reports every $iref that points at an $id that does not exist anywhere in the
 * document, grouped by owning PK and by which section of the level the owner
 * lives in. Used to find what makes the game throw NullReferenceException while
 * building taxiway visuals (ContextCross.Factories.TaxiwaySegment2DFactory).
 *
 * Usage: node scan_dangling_refs.cjs <level.acl> [...]
 *        node scan_dangling_refs.cjs --diff a.acl b.acl
 */
const fs = require('fs');
const path = require('path');
const { decodeArchive, isGatcArchive } = require('../../src/acl/gatcarc');

function decode(p) {
  const buf = fs.readFileSync(p);
  return isGatcArchive(buf) ? decodeArchive(buf) : buf.toString('utf-8');
}

/** Section (top-level blob) an entity lives in, for triage. */
function sectionOf(text, byteOffset) {
  let best = '(root)'; let bestPos = -1;
  for (const m of text.matchAll(/"(StaticData|RuntimeSnapshot|RuntimeData|TaxiNavigation|TaxiwayData|SceneryData|FlightPlans)"\s*:/g)) {
    if (m.index <= byteOffset && m.index > bestPos) { bestPos = m.index; best = m[1]; }
  }
  return best;
}

function audit(levelPath) {
  const text = decode(levelPath);
  const allIds = new Set();
  for (const m of text.matchAll(/"\$id":\s*(-?\d+)/g)) allIds.add(parseInt(m[1], 10));

  const lines = text.split(/\r?\n/);
  const findings = [];
  let owner = '(root)'; let ownerType = '(root)';
  let offset = 0;

  for (const line of lines) {
    const km = line.match(/"PK":\s*"([^"]*)"/);
    if (km) { owner = km[1]; ownerType = owner.split(':')[0]; }
    for (const m of line.matchAll(/\$iref:\s*(\d+|[^\s,\}\]]*)/g)) {
      const raw = m[1];
      const bad = !/^\d+$/.test(raw) || !allIds.has(parseInt(raw, 10));
      if (bad) findings.push({ owner, ownerType, ref: raw, offset });
    }
    offset += line.length + 1;
  }
  return { text, allIds, findings };
}

function summarise(p) {
  const { allIds, findings } = audit(p);
  const byType = new Map();
  for (const f of findings) {
    if (!byType.has(f.ownerType)) byType.set(f.ownerType, new Set());
    byType.get(f.ownerType).add(f.owner + ' → ' + f.ref);
  }
  console.log('\n' + '='.repeat(78));
  console.log('FILE: ' + path.basename(p));
  console.log('='.repeat(78));
  console.log(`  ids in document : ${allIds.size}`);
  console.log(`  dangling $irefs : ${findings.length}`);
  for (const [t, set] of [...byType].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`\n  [${t}] ${set.size} dangling ref(s)`);
    for (const s of [...set].slice(0, 15)) console.log('      ' + s);
    if (set.size > 15) console.log(`      … ${set.size - 15} more`);
  }
  return new Set(findings.map((f) => f.owner + ' → ' + f.ref));
}

const argv = process.argv.slice(2);
if (argv[0] === '--diff') {
  const a = summarise(argv[1]);
  const b = summarise(argv[2]);
  const onlyB = [...b].filter((x) => !a.has(x));
  const onlyA = [...a].filter((x) => !b.has(x));
  console.log('\n' + '='.repeat(78));
  console.log('DIFF');
  console.log('='.repeat(78));
  console.log(`  only in ${path.basename(argv[1])} (${onlyA.length}):`);
  for (const x of onlyA.slice(0, 30)) console.log('      ' + x);
  console.log(`\n  only in ${path.basename(argv[2])} (${onlyB.length}):`);
  for (const x of onlyB.slice(0, 30)) console.log('      ' + x);
} else {
  for (const p of argv) summarise(p);
}
