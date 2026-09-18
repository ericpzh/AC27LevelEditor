/**
 * Ground Painter — taxiway auto-slice split keeps the pavement visual path ONE
 * OsmId (regression for the "Taxiway visual path '50095' is discontinuous"
 * save error).
 *
 * When the painter draws a taxiway onto a runway's type-4 pavement strip, the
 * auto-slice splits that strip at the junction node. The two pieces were being
 * synthesized as brand-new taxiway segments with fresh negative OsmIds, so the
 * strip's own visual path lost its middle segment and the game rejected the save
 * as discontinuous. The split pieces must instead be re-emitted under the parent
 * strip's OsmId (as later ordinals).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { buildSceneryGraph } = require('../../src/acl/scenery_graph');
const { patchSceneryBlob } = require('../../src/acl/scenery_write');
const { createTokenizer } = require('../../src/acl/tokenizer');
const {
  buildPkIndex, getPkEntriesByType, resolveIref, extractVector3FromV4, extractIrefArray,
} = require('../../src/acl/v4_pk_index');

const FIXTURE = path.join(__dirname, '..', '_debug', 'ZSJN_leisure_1.decoded.txt');
const text = fs.readFileSync(FIXTURE, 'utf8');

// Force one segment's `IsUnselectable` so a split piece can be checked for
// visual-property inheritance.
function setUnselectable(t, pk, val) {
  const at = t.indexOf('"' + pk + '"');
  if (at < 0) return t;
  const blockStart = t.lastIndexOf('{', at);
  const ct = createTokenizer(t.substring(blockStart));
  const end = ct.findObjectEnd(0);
  const entry = t.substring(blockStart, blockStart + end);
  const patched = entry.replace(/"IsUnselectable":\s*(true|false)/, '"IsUnselectable": ' + val);
  return t.slice(0, blockStart) + patched + t.slice(blockStart + end);
}

// Real levels mark runway pavement strips unselectable; apply that to every
// segment of one OsmId (the state before a split).
function setOsmUnselectable(t, osm, val) {
  const idx = buildPkIndex(t);
  const pks = getPkEntriesByType(idx, 'taxiway-segment')
    .filter((s) => new RegExp('"OsmId":\\s*' + osm + '\\b').test(s.block))
    .map((s) => s.pk);
  let out = t;
  for (const pk of pks) out = setUnselectable(out, pk, val);
  return out;
}

// Every taxiway-segment of one OsmId must carry identical visual properties
// (Unity: "... have inconsistent visual properties"). `Name` IS part of that
// set; `Head` is NOT — a directed way legitimately stores a different head node
// per piece (shipped KDCA levels do), so comparing it would false-positive.
function osmVisualConsistency(aclText, osm) {
  const idx = buildPkIndex(aclText);
  const segs = getPkEntriesByType(idx, 'taxiway-segment')
    .filter((s) => new RegExp('"OsmId":\\s*' + osm + '\\b').test(s.block));
  const sig = (b) => {
    const g = (re) => { const m = b.match(re); return m ? m[1] : '(none)'; };
    return [
      g(/"Name":\s*"([^"]*)"/),
      g(/"Flags":\s*(-?\d+)/),
      g(/"Directed":\s*(true|false)/),
      g(/"IsHidden":\s*(true|false)/),
      g(/"IsUnselectable":\s*(true|false)/),
    ].join('|');
  };
  const sigs = new Set(segs.map((s) => sig(s.block)));
  return { ok: sigs.size <= 1, count: segs.length, sigs: [...sigs] };
}

// Rewrite one segment entry's top-level `Name` in the raw text (simulates the
// file a pre-invariant save produced).
function setSegName(t, pk, val) {
  const at = t.indexOf('"' + pk + '"');
  if (at < 0) return t;
  const blockStart = t.lastIndexOf('{', at);
  const ct = createTokenizer(t.substring(blockStart));
  const end = ct.findObjectEnd(0);
  const entry = t.substring(blockStart, blockStart + end);
  const patched = entry.replace(/"Name":\s*"[^"]*"/, '"Name": ' + JSON.stringify(val));
  return t.slice(0, blockStart) + patched + t.slice(blockStart + end);
}

// Walk one OsmId's taxiway-segment entries by ordinal and check each consecutive
// pair shares an endpoint node (the game's continuity criterion), and that the
// ordinals are contiguous from 0.
function chainContinuity(aclText, osm) {
  const idx = buildPkIndex(aclText);
  const segs = getPkEntriesByType(idx, 'taxiway-segment')
    .filter((s) => new RegExp('"OsmId":\\s*' + osm + '\\b').test(s.block));
  const byOrd = segs
    .map((s) => ({ ord: parseInt(s.pk.split(':')[2], 10), pk: s.pk, irefs: extractIrefArray(s.block, 'Nodes') }))
    .sort((a, b) => a.ord - b.ord);
  if (byOrd.length === 0) return { ok: false, reason: 'no segments' };
  for (let i = 0; i < byOrd.length; i++) if (byOrd[i].ord !== i) return { ok: false, reason: `non-contiguous ordinal ${byOrd[i].ord} at position ${i}` };
  for (let i = 0; i < byOrd.length - 1; i++) {
    const setA = new Set(byOrd[i].irefs);
    if (!byOrd[i + 1].irefs.some((n) => setA.has(n))) {
      return { ok: false, reason: `${byOrd[i].pk} -> ${byOrd[i + 1].pk} share no endpoint node` };
    }
  }
  return { ok: true };
}

describe('Ground Painter — taxiway auto-slice keeps pavement OsmId continuous', () => {
  it('split pieces of a type-4 pavement strip are re-emitted under the SAME OsmId (no fragment)', () => {
    const { graph, meta } = buildSceneryGraph(text);
    const near = (n, x, z) => n && Math.abs(n.x - x) < 1e-3 && Math.abs(n.z - z) < 1e-3;

    // The ZSJN 01/19 pavement is OSM 50095 (name "01/19", flags 4). Segment
    // 50095:7 spans node@(0.829,-5.47) -> node@(0.812,-18.04); split it at a
    // junction on its interior (0.822093,-10.832563) exactly as the auto-slice does.
    const segIdx = graph.segments.findIndex((s) => {
      if (s.name !== '01/19' || s.flags !== 4) return false;
      const idxs = s.nodeIdxs || [s.aIdx, s.bIdx];
      return near(graph.nodes[idxs[0]], 0.829433, -5.468824) &&
        near(graph.nodes[idxs[idxs.length - 1]], 0.812175, -18.041498);
    });
    expect(segIdx).toBeGreaterThanOrEqual(0);
    const origIdxs = graph.segments[segIdx].nodeIdxs;

    const junction = graph.nodes.length;
    graph.nodes.push({ x: 0.822093, z: -10.832563, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);

    const oldPk = meta.segOrigPk[segIdx];
    if (!meta.deletedPks) meta.deletedPks = [];
    meta.deletedPks.push(oldPk);

    // Split into two pieces sharing the junction node; carry parentOsm = 50095.
    const pieceA = [origIdxs[0], junction];
    const pieceB = [junction, ...origIdxs.slice(1)];
    graph.segments.splice(segIdx, 1);
    meta.segOrigPk.splice(segIdx, 1);
    graph.segments.push({ aIdx: pieceA[0], bIdx: pieceA[1], nodeIdxs: pieceA, flags: 4, directed: false, name: '01/19', parentOsm: 50095 });
    meta.segOrigPk.push(null);
    graph.segments.push({ aIdx: pieceA[1], bIdx: pieceB[pieceB.length - 1], nodeIdxs: pieceB, flags: 4, directed: false, name: '01/19', parentOsm: 50095 });
    meta.segOrigPk.push(null);

    const patched = patchSceneryBlob(text, graph, null, meta);
    expect(patched).not.toBe(text);

    // Both split pieces must fold into OSM 50095 → the path stays continuous.
    const cont = chainContinuity(patched, 50095);
    expect(cont.ok).toBe(true);

    // The two junction pieces must land as OSM 50095 entries, not fresh negatives.
    const idx2 = buildPkIndex(patched);
    const hasJunctionPiece50095 = getPkEntriesByType(idx2, 'taxiway-segment').some((s) => {
      const osm = s.block.match(/"OsmId":\s*(-?\d+)/);
      return osm && parseInt(osm[1], 10) === 50095 && extractIrefArray(s.block, 'Nodes').length >= 2 &&
        /"Name":\s*"01\/19"/.test(s.block);
    });
    expect(hasJunctionPiece50095).toBe(true);

    // No orphan pavement strip in a fresh negative OsmId.
    const orphan = getPkEntriesByType(idx2, 'taxiway-segment').filter((s) => {
      const osm = s.block.match(/"OsmId":\s*(-?\d+)/);
      return osm && osm[1] < 0 && /"Name":\s*"01\/19"/.test(s.block) && /"Flags":\s*4/.test(s.block);
    });
    expect(orphan.length).toBe(0);
  });

  it('a genuinely-new taxiway (no parentOsm) still gets its own fresh OsmId', () => {
    const { graph, meta } = buildSceneryGraph(text);
    const nA = graph.nodes.length, nB = graph.nodes.length + 1;
    graph.nodes.push({ x: 1000.5, z: 2000.25, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);
    graph.nodes.push({ x: 1010.75, z: 2010.5, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);
    graph.segments.push({ aIdx: nA, bIdx: nB, nodeIdxs: [nA, nB], flags: 2, directed: false, name: 'new-taxiway' });
    meta.segOrigPk.push(null);

    const patched = patchSceneryBlob(text, graph, null, meta);
    const idx2 = buildPkIndex(patched);
    const segs2 = getPkEntriesByType(idx2, 'taxiway-segment');
    const found = segs2.find((s) => /"Name":\s*"new-taxiway"/.test(s.block));
    expect(found).toBeTruthy();
    const osm = parseInt(found.block.match(/"OsmId":\s*(-?\d+)/)[1], 10);
    // Fresh taxiway is NOT forced into an existing pavement OsmId.
    expect(osm).not.toBe(50095);
  });

  it('split pieces inherit the parent pavement visual properties (no "inconsistent visual properties")', () => {
    // Mark the parent 01/19 pavement strip unselectable, the way real levels
    // (e.g. KDCA's "F" strip) mark runway pavement. The synthesized split piece
    // must inherit it — a hardcoded false default makes Unity reject the level:
    //   InvalidOperationException: Taxiway segments '...:0' and '...:5' for OSM
    //   way '...' have inconsistent visual properties.
    const near = (n, x, z) => n && Math.abs(n.x - x) < 1e-3 && Math.abs(n.z - z) < 1e-3;
    const findSeg = (g) => g.segments.findIndex((s) => {
      if (s.name !== '01/19' || s.flags !== 4) return false;
      const idxs = s.nodeIdxs || [s.aIdx, s.bIdx];
      return near(g.nodes[idxs[0]], 0.829433, -5.468824) &&
        near(g.nodes[idxs[idxs.length - 1]], 0.812175, -18.041498);
    });
    const text2 = setOsmUnselectable(text, 50095, 'true');

    const { graph, meta } = buildSceneryGraph(text2);
    const segIdx = findSeg(graph);
    expect(segIdx).toBeGreaterThanOrEqual(0);
    const origIdxs = graph.segments[segIdx].nodeIdxs;

    const junction = graph.nodes.length;
    graph.nodes.push({ x: 0.822093, z: -10.832563, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);

    const oldPk = meta.segOrigPk[segIdx];
    if (!meta.deletedPks) meta.deletedPks = [];
    meta.deletedPks.push(oldPk);

    const pieceA = [origIdxs[0], junction];
    const pieceB = [junction, ...origIdxs.slice(1)];
    graph.segments.splice(segIdx, 1);
    meta.segOrigPk.splice(segIdx, 1);
    graph.segments.push({ aIdx: pieceA[0], bIdx: pieceA[1], nodeIdxs: pieceA, flags: 4, directed: false, name: '01/19', parentOsm: 50095 });
    meta.segOrigPk.push(null);
    graph.segments.push({ aIdx: pieceA[1], bIdx: pieceB[pieceB.length - 1], nodeIdxs: pieceB, flags: 4, directed: false, name: '01/19', parentOsm: 50095 });
    meta.segOrigPk.push(null);

    const patched = patchSceneryBlob(text2, graph, null, meta);
    const cons = osmVisualConsistency(patched, 50095);
    expect(cons.ok, 'inconsistent visual signatures: ' + JSON.stringify(cons.sigs)).toBe(true);

    // The synthesized pieces must specifically carry IsUnselectable: true.
    const idx2 = buildPkIndex(patched);
    const inherited = getPkEntriesByType(idx2, 'taxiway-segment').filter((s) => {
      const osm = s.block.match(/"OsmId":\s*(-?\d+)/);
      return osm && parseInt(osm[1], 10) === 50095 && /"IsUnselectable":\s*true/.test(s.block);
    });
    expect(inherited.length).toBeGreaterThan(0);
  });

  it('heals a pre-existing Name inconsistency within one OSM way (KDCA_leisure_2 OSM -378884 fuzz regression)', () => {
    // The fuzz renamed ONE piece of a 22-segment way, so segment :2 carried a
    // different `Name` from its siblings and Unity aborted the level load:
    //   InvalidOperationException: Taxiway segments 'taxiway-segment:-378884:0'
    //   and '...:-378884:2' for OSM way '-378884' have inconsistent visual
    //   properties.
    // ZSJN OSM 50079 is a 29-piece unnamed way — rename one piece in the raw
    // text, then save with NO graph edits: the writer must still heal the group.
    const idx0 = buildPkIndex(text);
    const target = getPkEntriesByType(idx0, 'taxiway-segment')
      .find((s) => /^taxiway-segment:50079:0$/.test(s.pk));
    expect(target).toBeTruthy();

    const corrupted = setSegName(text, target.pk, 'T42');
    expect(osmVisualConsistency(corrupted, 50079).ok).toBe(false);

    const { graph, meta } = buildSceneryGraph(corrupted);
    const patched = patchSceneryBlob(corrupted, graph, null, meta);

    const after = osmVisualConsistency(patched, 50079);
    expect(after.ok, 'still inconsistent: ' + JSON.stringify(after.sigs)).toBe(true);
    // The non-empty renamed value wins group-wide.
    expect(after.sigs[0]).toContain('T42');
  });

  it('renaming one graph segment renames every piece of its OSM way', () => {
    const { graph, meta } = buildSceneryGraph(text);
    let segIdx = -1;
    for (let i = 0; i < graph.segments.length; i++) {
      const pk = meta.segOrigPk[i];
      if (pk && /^taxiway-segment:1421:\d+$/.test(pk)) { segIdx = i; break; }
    }
    expect(segIdx).toBeGreaterThanOrEqual(0);

    graph.segments[segIdx] = { ...graph.segments[segIdx], name: 'T99', nameEdited: true };
    const patched = patchSceneryBlob(text, graph, null, meta);

    const cons = osmVisualConsistency(patched, 1421);
    expect(cons.ok, 'inconsistent visual signatures: ' + JSON.stringify(cons.sigs)).toBe(true);
    expect(cons.sigs.length).toBe(1);
    expect(cons.sigs[0]).toContain('T99');

    // No sibling still carries the old name.
    const idx2 = buildPkIndex(patched);
    const stale = getPkEntriesByType(idx2, 'taxiway-segment').filter((s) => {
      const osm = s.block.match(/"OsmId":\s*(-?\d+)/);
      return osm && parseInt(osm[1], 10) === 1421 && /"Name":\s*"B"/.test(s.block);
    });
    expect(stale.length).toBe(0);
  });
});
