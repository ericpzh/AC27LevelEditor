/**
 * Survivor dangling-$iref gate — regression tests for the ZSJN_leisure_1
 * game-load crash (TaxiwaySegment2DFactory NullReferenceException).
 *
 * A node deleted in the Ground Painter (pk -> meta.deletedPks) is dropped from
 * the .acl, but SURVIVOR entries are copied verbatim — so a survivor segment
 * that still references the deleted node serialized a dangling numeric $iref
 * ($iref:2004/$iref:2040), which the game's taxiway factory null-derefs.
 *
 * The writer's survivor gate must repair (rewire to a live coordinate twin /
 * excise from the polyline) or drop the offending entry, and the final
 * validation pass must never let a taxiway-segment/stand dangling $iref reach
 * the encoded file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { decodeArchive } from '../../src/acl/gatcarc';
import { buildSceneryGraph } from '../../src/acl/scenery_graph';
import { patchSceneryBlob } from '../../src/acl/scenery_write';
import { levelPath, gameLevelExists } from '../helpers/gameRoot';

const LEVEL = levelPath('ZSJN', 'ZSJN_test.acl');
// Real-game fixture: skipped (rather than failing) where the game is not installed.
const describeWithLevel = gameLevelExists('ZSJN', 'ZSJN_test.acl') ? describe : describe.skip;

function loadLevel() {
  const text = decodeArchive(readFileSync(LEVEL));
  const { graph, meta } = buildSceneryGraph(text);
  if (!Array.isArray(meta.deletedPks)) meta.deletedPks = [];
  return { text, graph, meta };
}

/** Split the output's PKStaticEntities list into entry strings. */
function pkEntriesOf(text) {
  const pkKey = text.indexOf('"PKStaticEntities"');
  const rc = text.indexOf('"$rcontent"', pkKey);
  const open = text.indexOf('[', rc);
  let depth = 0, entries = [], start = -1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0) entries.push(text.slice(start, i + 1)); }
    else if (c === ']' && depth === 0) break;
  }
  return entries;
}

const segmentPk = (e) => (e.match(/"\$k":\s*"(taxiway-segment:[^"]+)"/) || [])[1];

const segmentPks = (text) => new Set([...text.matchAll(/"\$k":\s*"(taxiway-segment:[^"]+)"/g)].map((m) => m[1]));
const nodePks = (text) => new Set([...text.matchAll(/"\$k":\s*"(taxiway-node:[^"]+)"/g)].map((m) => m[1]));

/** Top-level $id of the taxiway-node entry with the given PK. */
function nodeIdInText(text, pk) {
  const k = text.indexOf(`"$k": "${pk}"`);
  expect(k).toBeGreaterThan(-1);
  return text.slice(k).match(/"\$id":\s*(\d+)/)[1];
}

/** $rcontent refs + declared $rlength of a segment entry's Nodes list. */
function nodesList(entry) {
  const nodesKey = entry.indexOf('"Nodes"');
  const seg = entry.slice(nodesKey);
  const rc = seg.indexOf('"$rcontent"');
  const open = seg.indexOf('[', rc);
  const close = seg.indexOf(']', open);
  const refs = [...seg.slice(open + 1, close).matchAll(/\$iref:\s*(\d+)/g)].map((m) => parseInt(m[1], 10));
  const rl = seg.slice(0, rc).match(/"\$rlength":\s*(\d+)/g).pop();
  return { refs, rlength: parseInt(rl.match(/\d+/)[0], 10) };
}

/** Flat scan: dangling $iref values owned by taxiway-segment entries. */
function segmentDangles(text) {
  const declared = new Set();
  for (const m of text.matchAll(/"\$id":\s*(\d+)/g)) declared.add(parseInt(m[1], 10));
  const dangles = new Map();
  for (const e of pkEntriesOf(text)) {
    const dead = new Set();
    for (const m of e.matchAll(/\$iref:\s*(\d+)/g)) {
      const id = parseInt(m[1], 10);
      if (!declared.has(id)) dead.add(id);
    }
    if (dead.size) dangles.set(segmentPk(e), dead);
  }
  return dangles;
}

function findCurvySurvivor(graph, meta) {
  for (let s = 0; s < graph.segments.length; s++) {
    if (meta.segOrigPk[s] == null) continue;
    const idxs = graph.segments[s].nodeIdxs;
    if (!idxs || idxs.length < 3) continue;
    const mid = idxs[Math.floor(idxs.length / 2)];
    if (meta.nodeOrigPk[mid] == null) continue;
    return { segIdx: s, midIdx: mid, midPk: meta.nodeOrigPk[mid] };
  }
  throw new Error('fixture level has no multi-node survivor segment');
}

describeWithLevel('survivor dangling-$iref gate', () => {
  it('excises a deleted midpoint from a survivor polyline and leaves no dangling ref', { timeout: 60000 }, () => {
    const { text, graph, meta } = loadLevel();
    const { segIdx, midIdx, midPk } = findCurvySurvivor(graph, meta);
    const segPk = meta.segOrigPk[segIdx];
    meta.deletedPks.push(midPk);

    const warnings = [];
    const out = patchSceneryBlob(text, graph, null, meta, { warnings });

    // The dead node entry is gone, the segment survives with one fewer node.
    expect(pkEntriesOf(out).some((e) => e.includes(`"$k": "${midPk}"`))).toBe(false);
    const segEntry = pkEntriesOf(out).find((e) => segmentPk(e) === segPk);
    expect(segEntry).toBeTruthy();
    const { refs, rlength } = nodesList(segEntry);
    const origSeg = pkEntriesOf(text).find((e) => segmentPk(e) === segPk);
    const orig = nodesList(origSeg);
    expect(refs.length).toBe(orig.refs.length - 1);
    expect(rlength).toBe(refs.length);
    // No dangling $iref anywhere in the serialized output.
    expect(segmentDangles(out).size).toBe(0);
    expect(warnings.some((w) => w.text.includes('excised'))).toBe(true);
  });

  it('drops a survivor segment whose endpoints were both deleted, with no dangling ref', { timeout: 60000 }, () => {
    // Round 1: draw a fresh 2-node stub (isolated coordinates, no twins) — the
    // save makes it a survivor entry in the output text.
    const { text, graph, meta } = loadLevel();
    graph.nodes.push({ x: 999, z: 999, type: 2, flags: 0 });
    graph.nodes.push({ x: 1000, z: 1000, type: 2, flags: 0 });
    const a = graph.nodes.length - 2, b = graph.nodes.length - 1;
    meta.nodeOrigPk.push(null, null);
    graph.segments.push({ aIdx: a, bIdx: b, nodeIdxs: [a, b], flags: 2, directed: false });
    meta.segOrigPk.push(null);
    const warnings1 = [];
    const text1 = patchSceneryBlob(text, graph, null, meta, { warnings: warnings1 });
    expect(segmentDangles(text1).size).toBe(0);

    // Round 2: ghost-delete both endpoint nodes. The survivor stub cannot be
    // rewired (no coordinate twins) and cannot be excised (only 2 refs) — the
    // gate must drop it.
    const g2 = buildSceneryGraph(text1);
    if (!Array.isArray(g2.meta.deletedPks)) g2.meta.deletedPks = [];
    const stubPk = [...segmentPks(text1)].filter((pk) => !segmentPks(text).has(pk));
    expect(stubPk.length).toBe(1);
    const endPks = [...nodePks(text1)].filter((pk) => !nodePks(text).has(pk));
    expect(endPks.length).toBe(2);
    g2.meta.deletedPks.push(...endPks);

    const warnings2 = [];
    const out = patchSceneryBlob(text1, g2.graph, null, g2.meta, { warnings: warnings2 });

    expect(pkEntriesOf(out).some((e) => segmentPk(e) === stubPk[0])).toBe(false);
    expect(segmentDangles(out).size).toBe(0);
    expect(warnings2.some((w) => w.text.includes('dropped taxiway-segment'))).toBe(true);
  });

  it('rewires a survivor segment to a live coordinate twin instead of dangling', { timeout: 60000 }, () => {
    // Round 1: create a node that duplicates an existing original node's
    // coordinate (the junction-twin situation the fillet creates), plus a
    // segment from the original node to a far-away node. After the save both
    // nodes and the segment are survivor entries in the output text.
    const { text, graph, meta } = loadLevel();
    const { segIdx, midIdx, midPk } = findCurvySurvivor(graph, meta);
    const orig = graph.nodes[midIdx];
    graph.nodes.push({ x: orig.x, z: orig.z, type: orig.type, flags: orig.flags }); // twin (new, pk null)
    graph.nodes.push({ x: 2000, z: 2000, type: 2, flags: 0 });                      // far anchor
    const farIdx = graph.nodes.length - 1;
    meta.nodeOrigPk.push(null, null);
    graph.segments.push({ aIdx: midIdx, bIdx: farIdx, nodeIdxs: [midIdx, farIdx], flags: 2, directed: false });
    meta.segOrigPk.push(null);

    const warnings1 = [];
    const text1 = patchSceneryBlob(text, graph, null, meta, { warnings: warnings1 });
    expect(segmentDangles(text1).size).toBe(0);
    const newSegPk = [...segmentPks(text1)].filter((pk) => !segmentPks(text).has(pk));
    expect(newSegPk.length).toBe(1);

    // Round 2: ghost-delete the ORIGINAL node. Both survivor segments that
    // referenced it (the curvy polyline and the new stub) must be rewired to
    // the live twin — never serialized as dangling refs.
    const g2 = buildSceneryGraph(text1);
    if (!Array.isArray(g2.meta.deletedPks)) g2.meta.deletedPks = [];
    g2.meta.deletedPks.push(midPk);

    const warnings2 = [];
    const text2 = patchSceneryBlob(text1, g2.graph, null, g2.meta, { warnings: warnings2 });

    // The dead node entry is gone; the stub survived and no longer references it.
    expect(pkEntriesOf(text2).some((e) => e.includes(`"$k": "${midPk}"`))).toBe(false);
    const stubEntry = pkEntriesOf(text2).find((e) => segmentPk(e) === newSegPk[0]);
    expect(stubEntry).toBeTruthy();
    const { refs } = nodesList(stubEntry);
    const deadId = parseInt(nodeIdInText(text1, midPk), 10);
    expect(refs).not.toContain(deadId);
    expect(refs.length).toBe(2);
    expect(new Set(refs).size).toBe(2);
    expect(segmentDangles(text2).size).toBe(0);
    expect(warnings2.some((w) => w.text.includes('rewired'))).toBe(true);
  });

  it('last-resort validation drops a pre-existing corrupt segment ref even with no deletions', { timeout: 60000 }, () => {
    const { text, graph, meta } = loadLevel();
    const { segIdx } = findCurvySurvivor(graph, meta);
    const segPk = meta.segOrigPk[segIdx];
    // Corrupt the snapshot directly: point one of the segment's node refs at a
    // nonexistent id (simulating an older broken save), with NO deletions.
    const segEntryRe = new RegExp('("\\$k": "' + segPk + '"[\\s\\S]*?\\$iref:\\s*)(\\d+)');
    const corrupt = text.replace(segEntryRe, (m, head, id) => head + (parseInt(id, 10) + 9000000));
    expect(corrupt).not.toBe(text);

    const warnings = [];
    const out = patchSceneryBlob(corrupt, graph, null, meta, { warnings });

    // The corrupt segment cannot be repaired (its ref points nowhere) and is
    // dropped instead of re-committed.
    expect(pkEntriesOf(out).some((e) => segmentPk(e) === segPk)).toBe(false);
    expect(segmentDangles(out).size).toBe(0);
    expect(warnings.some((w) => w.text.includes('last-resort removal'))).toBe(true);
  });
});
