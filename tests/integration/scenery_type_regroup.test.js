/**
 * Ground Painter — PK static-entity type regroup.
 *
 * Regression test for the save path's group ordering: the game serializes
 * `PKStaticEntities.$rcontent` with entries grouped by entity type in a fixed
 * order (taxiway-node, taxiway-segment, airway-node, airway-segment, runway,
 * stand, taxi-navigation). The rebuild path used to keep survivors in place and
 * APPEND synthesized objects at the tail of the array, so a newly-drawn
 * taxiway-node landed AFTER every taxi-navigation entry, breaking the grouping
 * the game's reader assumes. `patchSceneryBlob` now regenerates the array in the
 * source file's type order (stable within a group via `_regroupPkByType`).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { buildSceneryGraph } = require('../../src/acl/scenery_graph');
const { patchSceneryBlob, _staticEntitiesRanges, _splitArrayEntries, _entryTypePrefix, _pkTypeOrder, _regroupPkByType } =
  require('../../src/acl/scenery_write');

const FIXTURE = path.join(__dirname, '..', '_debug', 'ZSJN_leisure_1.decoded.txt');
const text = fs.readFileSync(FIXTURE, 'utf8');

// Ordered list of the PK entry type prefixes currently present in `text`.
function pkTypeRuns(pkEntries) {
  const runs = [];
  for (const e of pkEntries) {
    const p = _entryTypePrefix(e);
    if (runs.length === 0 || runs[runs.length - 1].p !== p) runs.push({ p, n: 1 });
    else runs[runs.length - 1].n++;
  }
  return runs;
}

function pkEntriesOf(t) {
  const ranges = _staticEntitiesRanges(t);
  return _splitArrayEntries(t.substring(ranges.pkRc.start, ranges.pkRc.end));
}

describe('Ground Painter — PK static-entity type regroup', () => {
  it('no-touch patch is still byte-identical (early no-op path unchanged)', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    expect(patchSceneryBlob(text, g0, null, meta)).toBe(text);
  });

  it('the original file already serializes PK entries in canonical type order', () => {
    // Guards against the fixture changing shape: the regroup must agree with the
    // order the file itself declares (single contiguous run per type).
    const runs = pkTypeRuns(pkEntriesOf(text));
    expect(runs.map((r) => r.p)).toEqual([
      'taxiway-node', 'taxiway-segment', 'airway-node', 'airway-segment', 'runway', 'stand', 'taxi-navigation',
    ]);
  });

  it('adding a node + segment regroups them into their own type blocks (not the tail)', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    const nBase = g0.nodes.length, sBase = g0.segments.length;
    const nA = g0.nodes.length;
    g0.nodes.push({ x: 1000.5, z: 2000.25, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);
    const nB = g0.nodes.length;
    g0.nodes.push({ x: 1010.75, z: 2010.5, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);
    g0.segments.push({ aIdx: nA, bIdx: nB, name: 'new-seg', flags: 2, directed: false });
    meta.segOrigPk.push(null);

    const patched = patchSceneryBlob(text, g0, null, meta);
    const runs = pkTypeRuns(pkEntriesOf(patched));

    // Single contiguous block per type, in the file's canonical order — i.e. the
    // new taxiway-node entries joined the taxiway-node block rather than the tail.
    expect(runs.map((r) => r.p)).toEqual([
      'taxiway-node', 'taxiway-segment', 'airway-node', 'airway-segment', 'runway', 'stand', 'taxi-navigation',
    ]);
    const nodeRun = runs.find((r) => r.p === 'taxiway-node');
    const segRun = runs.find((r) => r.p === 'taxiway-segment');
    expect(nodeRun.n).toBe(nBase + 2);
    expect(segRun.n).toBe(sBase + 1);

    // The block counts must sum to the array length (no entry lost/duplicated).
    expect(runs.reduce((a, r) => a + r.n, 0)).toBe(pkEntriesOf(patched).length);

    // Re-parses: the two new nodes and the new segment are present, and every
    // ORIGINAL node index is stable (grouping appends new nodes after originals).
    const { graph: g1 } = buildSceneryGraph(patched);
    expect(g1.nodes.length).toBe(nBase + 2);
    expect(g1.segments.length).toBe(sBase + 1);
    const found = g1.segments.some((sg) => {
      const a = g1.nodes[sg.aIdx], b = g1.nodes[sg.bIdx];
      return a && b && Math.abs(a.x - 1000.5) < 1e-6 && Math.abs(a.z - 2000.25) < 1e-6 &&
        Math.abs(b.x - 1010.75) < 1e-6 && Math.abs(b.z - 2010.5) < 1e-6;
    });
    expect(found).toBe(true);
  });

  it('_regroupPkByType buckets by type and preserves within-group order', () => {
    const order = _pkTypeOrder(pkEntriesOf(text));
    // Deliberately unsorted group (the game does not key-order stands/runways):
    // a new stand joining the block must not reorder survivors.
    const stEntries = [];
    for (const e of pkEntriesOf(text)) {
      if (_entryTypePrefix(e) === 'stand') stEntries.push(e);
    }
    const tailAppend = stEntries.concat(['{ "$k": "stand:9999", "$v": { "$id": 1, "$type": "1|S, A" } }']);
    const regrouped = _regroupPkByType(tailAppend, order);
    // The new stand group (if any) is emitted after existing stands, in order.
    const stAfter = regrouped.filter((e) => _entryTypePrefix(e) === 'stand');
    expect(stAfter.slice(0, stEntries.length)).toEqual(stEntries);
    expect(stAfter[stAfter.length - 1]).toBe(tailAppend[tailAppend.length - 1]);
  });
});
