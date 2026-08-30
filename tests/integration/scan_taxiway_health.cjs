#!/usr/bin/env node
/**
 * Taxiway health scanner — finds the taxiway segment / node that makes the game
 * throw NullReferenceException in
 * ContextCross.Factories.TaxiwaySegment2DFactory.CreateVisualPaths().
 *
 * That factory walks every taxiway-segment's `Nodes` list and dereferences each
 * $iref to a TaxiwayNode2D. Any entry it cannot resolve (a dangling id, a
 * non-numeric "$iref:null", a reference to an object that is not a node, or a
 * node with no position) dereferences to null → NRE.
 *
 * The editor's own reader (v4_pk_index.extractIrefArray) SKIPS non-numeric
 * $irefs silently, so the level can look fine in the editor and still crash the
 * game. This scanner reads the raw text instead.
 *
 * Usage: node scan_taxiway_health.cjs <level.acl> [more.acl ...]
 */
const fs = require('fs');
const path = require('path');
const { readAclText, decodeArchive } = require('../../src/acl/gatcarc');
const {
  buildPkIndex, getPkEntriesByType, extractVector3FromV4, extractStringFromV4,
} = require('../../src/acl/v4_pk_index');

// ── raw $iref scan: keeps non-numeric tokens (null, empty, garbage) ──────────
function rawIrefTokens(arrText) {
  const out = [];
  let si = 0;
  while ((si = arrText.indexOf('$iref:', si)) !== -1) {
    si += 6;
    while (si < arrText.length && ' \t'.includes(arrText[si])) si++;
    let start = si;
    // Numeric reference.
    while (si < arrText.length && arrText[si] >= '0' && arrText[si] <= '9') si++;
    if (si > start) {
      out.push({ num: parseInt(arrText.substring(start, si), 10), raw: arrText.substring(start, si) });
      continue;
    }
    // Non-numeric: capture the token up to , } ] whitespace.
    while (si < arrText.length && !',}]'.includes(arrText[si]) && !' \t\r\n'.includes(arrText[si])) si++;
    out.push({ num: NaN, raw: arrText.substring(start, si) });
  }
  return out;
}

function rawIrefArray(block, key) {
  const keyIdx = block.indexOf('"' + key + '"');
  if (keyIdx < 0) return null; // key absent entirely
  const afterKey = block.substring(keyIdx);
  const rcIdx = afterKey.indexOf('"$rcontent"');
  if (rcIdx < 0) return [];
  const bracketIdx = afterKey.indexOf('[', rcIdx);
  if (bracketIdx < 0) return [];
  let depth = 0;
  let endIdx = bracketIdx;
  for (let i = bracketIdx; i < afterKey.length; i++) {
    if (afterKey[i] === '[') depth++;
    else if (afterKey[i] === ']') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  return rawIrefTokens(afterKey.substring(bracketIdx, endIdx));
}

function scan(levelPath) {
  const buf = fs.readFileSync(levelPath);
  const text = require('../../src/acl/gatcarc').isGatcArchive(buf)
    ? decodeArchive(buf)
    : buf.toString('utf-8');

  const pkIndex = buildPkIndex(text);
  const nodeEntries = getPkEntriesByType(pkIndex, 'taxiway-node');
  const segEntries = getPkEntriesByType(pkIndex, 'taxiway-segment');

  // id → node info (only for entities that really are taxiway-node entries)
  const nodeById = new Map();
  for (const e of nodeEntries) {
    if (e.id != null) {
      nodeById.set(e.id, { pk: e.pk, pos: extractVector3FromV4(e.block) });
    }
  }

  const problems = [];
  const stats = {
    nodes: nodeEntries.length,
    nodesWithPos: nodeEntries.filter((e) => extractVector3FromV4(e.block)).length,
    segments: segEntries.length,
    segNodeRefs: 0,
    degenerate: 0,
    byName: new Map(),
  };

  for (const e of segEntries) {
    const name = extractStringFromV4(e.block, 'Name') || '(unnamed)';
    const toks = rawIrefArray(e.block, 'Nodes');
    if (toks === null) {
      problems.push({ seg: e.pk, name, kind: 'MISSING_NODES_KEY', detail: 'segment has no Nodes field at all' });
      continue;
    }
    stats.segNodeRefs += toks.length;
    if (toks.length < 2) {
      stats.degenerate++;
      problems.push({
        seg: e.pk, name, kind: 'TOO_FEW_NODES',
        detail: `Nodes has ${toks.length} entry(ies) — a segment needs >= 2`,
      });
    }

    const resolved = [];
    for (const t of toks) {
      if (!Number.isFinite(t.num)) {
        problems.push({
          seg: e.pk, name, kind: 'BAD_IREF_TOKEN',
          detail: `raw $iref value "${t.raw}" is not an integer id (game dereferences this to null)`,
        });
        continue;
      }
      const node = pkIndex.byId.get(t.num);
      if (!node) {
        problems.push({
          seg: e.pk, name, kind: 'DANGLING_NODE_REF',
          detail: `$iref:${t.num} matches no "$id" anywhere in the document`,
        });
        continue;
      }
      if (node.pk && !node.pk.startsWith('taxiway-node:')) {
        problems.push({
          seg: e.pk, name, kind: 'WRONG_TARGET_TYPE',
          detail: `$iref:${t.num} resolves to "${node.pk}", not a taxiway-node`,
        });
        continue;
      }
      const info = nodeById.get(t.num);
      if (!info) {
        problems.push({
          seg: e.pk, name, kind: 'NODE_NOT_IN_PK_LIST',
          detail: `$iref:${t.num} exists as an entity but was not indexed as a taxiway-node`,
        });
        continue;
      }
      if (!info.pos) {
        problems.push({
          seg: e.pk, name, kind: 'NODE_WITHOUT_POSITION',
          detail: `$iref:${t.num} (${info.pk}) has no position vector — node object is null in the factory`,
        });
        continue;
      }
      resolved.push(info.pos);
    }

    // Zero-length / self-referencing segment: all points identical.
    if (resolved.length >= 2) {
      const first = resolved[0];
      const allSame = resolved.every((p) => Math.abs(p.x - first.x) < 1e-9 && Math.abs(p.z - first.z) < 1e-9);
      if (allSame) {
        problems.push({
          seg: e.pk, name, kind: 'ZERO_LENGTH_POLYLINE',
          detail: `all ${resolved.length} nodes collapse to one point (${first.x}, ${first.z})`,
        });
      }
    }

    if (!stats.byName.has(name)) stats.byName.set(name, 0);
    stats.byName.set(name, stats.byName.get(name) + 1);
  }

  // Orphan nodes: exist but referenced by nothing (informational only).
  const referenced = new Set();
  for (const e of segEntries) {
    for (const t of (rawIrefArray(e.block, 'Nodes') || [])) if (Number.isFinite(t.num)) referenced.add(t.num);
  }
  const orphans = nodeEntries.filter((e) => e.id != null && !referenced.has(e.id)).length;

  return { problems, stats, orphans, size: buf.length };
}

// ── main ────────────────────────────────────────────────────────────────────
const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node scan_taxiway_health.cjs <level.acl> [...]');
  process.exit(2);
}

let totalProblems = 0;
for (const p of targets) {
  const abs = path.resolve(p);
  console.log('\n' + '='.repeat(78));
  console.log('FILE: ' + abs);
  console.log('='.repeat(78));
  let res;
  try {
    res = scan(abs);
  } catch (err) {
    console.error('  FAILED TO DECODE: ' + err.message);
    totalProblems++;
    continue;
  }
  const { problems, stats, orphans, size } = res;
  console.log(`  size               : ${size} bytes`);
  console.log(`  taxiway-node       : ${stats.nodes} (with position: ${stats.nodesWithPos}, orphan: ${orphans})`);
  console.log(`  taxiway-segment    : ${stats.segments}`);
  console.log(`  node refs in segs  : ${stats.segNodeRefs}  (degenerate segs: ${stats.degenerate})`);

  if (problems.length === 0) {
    console.log('\n  OK — no broken taxiway references found.');
    continue;
  }

  const byKind = new Map();
  for (const pr of problems) {
    if (!byKind.has(pr.kind)) byKind.set(pr.kind, []);
    byKind.get(pr.kind).push(pr);
  }
  console.log(`\n  !! ${problems.length} PROBLEM(S) in ${byKind.size} category(ies):`);
  for (const [kind, list] of byKind) {
    console.log(`\n  --- ${kind} (${list.length}) ---`);
    for (const pr of list.slice(0, 40)) {
      console.log(`      seg ${pr.seg}  name="${pr.name}"\n          ${pr.detail}`);
    }
    if (list.length > 40) console.log(`      ... ${list.length - 40} more`);
  }
  totalProblems += problems.length;
}

process.exit(totalProblems ? 1 : 0);
