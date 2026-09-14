/**
 * Visual-path continuity (`Taxiway visual path 'N' is discontinuous`).
 *
 * Unity concatenates a taxiway visual path's segments in ordinal order and
 * requires last(:i) === first(:i+1). Fuzz/split ops can store split pieces in
 * the wrong order/orientation, and a fillet stub that inherited the parent
 * OsmId can branch the group (degree-3 node) so no linear order exists.
 * `_renumberTaxiwaySegmentOrdinals` must order + orient each path and decompose
 * branched groups into separate paths.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _renumberTaxiwaySegmentOrdinals } = require('../../src/acl/scenery_write');
const { extractIrefArray } = require('../../src/acl/v4_pk_index');

function seg(osm, ord, refs) {
  const rc = refs.map((r) => '$iref:' + r).join(', ');
  return '{ "$k": "taxiway-segment:' + osm + ':' + ord + '", "$v": { "$id": 1, "$type": 6, '
    + '"PK": "taxiway-segment:' + osm + ':' + ord + '", "OsmId": ' + osm + ', '
    + '"Nodes": { "$id": 2, "$type": 7, "$rlength": ' + refs.length + ', "$rcontent": [ ' + rc + ' ] }, '
    + '"Flags": 2, "Directed": false } }';
}
function groups(entries) {
  const byOsm = new Map();
  for (const e of entries) {
    const pk = e.match(/"\$k"\s*:\s*"taxiway-segment:(-?\d+):(\d+)"/);
    const refs = extractIrefArray(e, 'Nodes');
    if (!byOsm.has(pk[1])) byOsm.set(pk[1], []);
    byOsm.get(pk[1]).push({ ord: parseInt(pk[2], 10), refs });
  }
  for (const l of byOsm.values()) l.sort((a, b) => a.ord - b.ord);
  return byOsm;
}
function assertContinuous(list) {
  for (let i = 1; i < list.length; i++) {
    const prevLast = list[i - 1].refs[list[i - 1].refs.length - 1];
    expect(list[i].refs[0]).toBe(prevLast);
  }
}

describe('taxiway visual-path continuity', () => {
  it('reorders + reverses a 2-piece path whose pieces both end at the split node', () => {
    const out = _renumberTaxiwaySegmentOrdinals([seg(50079, 0, [336, 6232]), seg(50079, 1, [6606, 6232])]);
    const g = groups(out);
    const list = g.get('50079');
    expect(list).toHaveLength(2);
    assertContinuous(list);
  });

  it('decomposes a branched group into separate continuous paths', () => {
    // chain 1-2-3 plus a stub attached at node 2 (degree 3)
    const out = _renumberTaxiwaySegmentOrdinals([seg(1421, 0, [1, 2]), seg(1421, 1, [2, 3]), seg(1421, 2, [9, 2])]);
    const g = groups(out);
    // The stub must have moved off OsmId 1421 onto its own path.
    expect(g.size).toBe(2);
    for (const list of g.values()) assertContinuous(list);
    const sizes = [...g.values()].map((l) => l.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it('keeps a simple ordered linear path unchanged', () => {
    const out = _renumberTaxiwaySegmentOrdinals([seg(50095, 0, [1, 2]), seg(50095, 1, [2, 3])]);
    const g = groups(out);
    expect(g.size).toBe(1);
    assertContinuous(g.get('50095'));
  });
});
