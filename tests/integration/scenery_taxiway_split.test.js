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
const {
  buildPkIndex, getPkEntriesByType, resolveIref, extractVector3FromV4, extractIrefArray,
} = require('../../src/acl/v4_pk_index');

const FIXTURE = path.join(__dirname, '..', '_debug', 'ZSJN_leisure_1.decoded.txt');
const text = fs.readFileSync(FIXTURE, 'utf8');

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
});
