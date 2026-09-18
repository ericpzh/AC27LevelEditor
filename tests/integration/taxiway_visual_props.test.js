/**
 * Taxiway OSM-way VISUAL-PROPERTY continuity (Unity: "... have inconsistent
 * visual properties").
 *
 * Unity requires every `taxiway-segment:<osm>:<ord>` sharing one OsmId to carry
 * the same visual signature — `Name` included. The KDCA_leisure_2 air-map fuzz
 * renamed ONE piece of OSM way -378884, leaving `:2` named "T42" while its 21
 * siblings stayed unnamed, and Unity aborted level load:
 *   InvalidOperationException: Taxiway segments 'taxiway-segment:-378884:0' and
 *   'taxiway-segment:-378884:2' for OSM way '-378884' have inconsistent visual
 *   properties.
 * `_renumberTaxiwaySegmentOrdinals` canonicalizes each group; `Head` is NOT part
 * of the signature (a directed way legitimately stores a different head node per
 * piece — shipped levels do, e.g. KDCA OSM -378622).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  _renumberTaxiwaySegmentOrdinals,
  _segVisualOf,
  _hasInconsistentSegVisual,
  _canonicalSegVisualMap,
} = require('../../src/acl/scenery_write');

function seg(osm, ord, refs, opts = {}) {
  const {
    name = '', flags = 2, directed = false, head = null,
    isHidden = false, isUnselectable = false,
  } = opts;
  const rc = refs.map((r) => '$iref:' + r).join(', ');
  return '{ "$k": "taxiway-segment:' + osm + ':' + ord + '", "$v": { "$id": 1, "$type": 6, '
    + '"PK": "taxiway-segment:' + osm + ':' + ord + '", "Name": ' + JSON.stringify(name) + ', "OsmId": ' + osm + ', '
    + '"Nodes": { "$id": 2, "$type": 7, "$rlength": ' + refs.length + ', "$rcontent": [ ' + rc + ' ] }, '
    + '"Flags": ' + flags + ', "Directed": ' + (directed ? 'true' : 'false')
    + ', "Head": ' + (head == null ? 'null' : '$iref:' + head)
    + ', "IsHidden": ' + (isHidden ? 'true' : 'false')
    + ', "IsUnselectable": ' + (isUnselectable ? 'true' : 'false') + ' } }';
}

function groupByOsm(entries) {
  const byOsm = new Map();
  for (const e of entries) {
    const m = /"OsmId"\s*:\s*(-?\d+)/.exec(e);
    if (!byOsm.has(m[1])) byOsm.set(m[1], []);
    byOsm.get(m[1]).push(_segVisualOf(e));
  }
  return byOsm;
}

// Unity's invariant: one OsmId ⇒ one visual signature.
function assertUniform(entries) {
  for (const [osm, vis] of groupByOsm(entries)) {
    const sigs = new Set(vis.map((v) => JSON.stringify(v)));
    expect(sigs.size, `OsmId ${osm} has inconsistent visual properties: ${[...sigs].join(' | ')}`).toBe(1);
  }
}

describe('taxiway OSM-way visual-property continuity', () => {
  it('unifies Name where one piece of a way was renamed (KDCA_leisure_2 -378884)', () => {
    const entries = [
      seg(-378884, 0, [1, 2]),
      seg(-378884, 1, [2, 3]),
      seg(-378884, 2, [3, 4], { name: 'T42' }),
      seg(-378884, 3, [4, 5]),
    ];
    expect(_hasInconsistentSegVisual(entries)).toBe(true);

    const out = _renumberTaxiwaySegmentOrdinals(entries);

    assertUniform(out);
    // The non-empty renamed value wins group-wide.
    expect(out.every((e) => _segVisualOf(e).name === 'T42')).toBe(true);
    expect(_hasInconsistentSegVisual(out)).toBe(false);
  });

  it('unifies Flags / Directed / IsHidden / IsUnselectable across the group', () => {
    const entries = [
      seg(-100, 0, [1, 2]),
      seg(-100, 1, [2, 3], { flags: 4, directed: true, isHidden: true, isUnselectable: true }),
    ];
    const out = _renumberTaxiwaySegmentOrdinals(entries);
    assertUniform(out);
    const sig = _segVisualOf(out[0]);
    for (const e of out) {
      const v = _segVisualOf(e);
      expect(v.flags).toBe(sig.flags);
      expect(v.directed).toBe(sig.directed);
      expect(v.isHidden).toBe(sig.isHidden);
      expect(v.isUnselectable).toBe(sig.isUnselectable);
    }
  });

  it('treats a group differing only by Head as consistent (Head is not visual)', () => {
    const entries = [
      seg(-200, 0, [1, 2], { directed: true, head: 1 }),
      seg(-200, 1, [2, 3], { directed: true, head: 2 }),
    ];
    expect(_hasInconsistentSegVisual(entries)).toBe(false);
    expect('head' in _segVisualOf(entries[0])).toBe(false);

    const out = _renumberTaxiwaySegmentOrdinals(entries);
    assertUniform(out);
  });

  it('builds a canonical signature per OsmId (used to seed split pieces)', () => {
    const entries = [
      seg(-300, 0, [1, 2], { name: 'A', flags: 2 }),
      seg(-300, 1, [2, 3], { name: 'A', flags: 2 }),
      seg(-300, 2, [3, 4], { name: 'B', flags: 4 }),
      seg(-301, 0, [5, 6], { name: '', flags: 8 }),
    ];
    const map = _canonicalSegVisualMap(entries);
    const c = map.get('-300');
    expect(c.name).toBe('A'); // mode wins, and non-empty beats the empty default
    expect(c.flags).toBe(2);
    expect(map.get('-301').flags).toBe(8);
    expect(map.size).toBe(2);
  });

  it('is a no-op for an already-uniform group', () => {
    const entries = [
      seg(50095, 0, [1, 2], { name: '01/19', flags: 4 }),
      seg(50095, 1, [2, 3], { name: '01/19', flags: 4 }),
    ];
    const out = _renumberTaxiwaySegmentOrdinals(entries);
    expect(out).toEqual(entries);
    assertUniform(out);
  });
});
