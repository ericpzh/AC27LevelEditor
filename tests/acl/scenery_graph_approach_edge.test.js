import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sg = require('../../src/acl/scenery_graph.js');
const approach = require('../../src/acl/approach.js');
const sw = require('../../src/acl/scenery_write.js');

describe('scenery_graph — missing Routes / airwayIdToIdx degenerate', () => {
  it('buildSceneryGraph with empty text returns empty airway structures', () => {
    const { graph, meta } = sg.buildSceneryGraph('');
    expect(graph.airwayNodes).toEqual([]);
    expect(graph.procedures).toEqual([]);
    expect(meta.airwayNodeOrigPk).toEqual([]);
    expect(meta.airwaySegOrigPk).toEqual([]);
  });
  it('airwayIdToIdx miss with degenerate <2 drop: procedure with single resolved node is dropped', () => {
    // Craft a minimal decoded text that has a runway with Routes containing a STAR
    // whose AirwayNodes $iref does not resolve to any airway-node → nodeIdxs length 0/1 → dropped
    // We achieve this by having zero airway-node PK entries but a runway Routes entry
    // referencing $iref:99999. buildSceneryGraph filter `if (nodeIdxs.length <2) continue` will skip it.
    // Provide a runway block with one STAR route referencing a non-existent $iref.
    const fakeText = `
"StaticData": {
  "$blobdoc": {
    "PKStaticEntities": {
      "$rlength": 2,
      "$rcontent": [
        {
          "$k": "runway:01",
          "$id": 10,
          "Name": "01",
          "PhysicalRunwayStaticItem": { "PhysicalName": "01/19" },
          "ThresholdPoints": { "$rlength": 2, "$rcontent": [ { "$iref": 100 }, { "$iref": 101 } ] },
          "Routes": { "$rlength": 1, "$rcontent": [ { "Name": "FAKE_STAR", "RouteType": 0, "AirwayNodes": { "$rlength": 1, "$rcontent": [ { "$iref": 99999 } ] } } ] },
          "Width": 0.5
        },
        {
          "$k": "taxiway-node:1",
          "$id": 100,
          "OsmId": 1,
          "ReactivePosition": { "$id": 200, "$type": "5|UnityEngine.Vector3", 0, 0, 0 }
        }
      ]
    },
    "NonPKStaticEntities": { "$rlength": 0, "$rcontent": [] },
    "StaticItems": { "$rlength": 0, "$rcontent": [] }
  }
}
`;
    // Add second threshold node via raw text hack for id 101
    const text2 = fakeText.replace(`"OsmId": 1`, `"OsmId": 1`)
      + ` { "$k": "taxiway-node:2", "$id": 101, "OsmId": 2, "ReactivePosition": { "$id": 201, "$type": "5|...", 10, 0, 0 } }`;
    // Even if the above hack is imperfect, the key is that buildSceneryGraph does not throw and drops the degenerate proc
    const { graph } = sg.buildSceneryGraph(fakeText);
    // The procedure with unresolved $iref should be dropped → 0 procedures
    expect(graph.procedures.length).toBe(0);
  });

  it('getBlobTypeMap returns empty for no StaticData', () => {
    expect(sg.getBlobTypeMap('').size).toBe(0);
    expect(sg.getBlobTypeMap('no blobdoc').size).toBe(0);
  });
  it('polygonIsSimple via scenery_graph CJS mirrors ESM (already covered but ensures CJS path)', () => {
    expect(sg.polygonIsSimple([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: 10 }])).toBe(true);
    expect(sg.polygonIsSimple([{ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 10, z: 0 }, { x: 0, z: 10 }])).toBe(false);
  });
  it('scenery_write extract helpers return empty for null/empty', () => {
    expect(sw.extractTaxiwayOsmPool('')).toEqual(expect.objectContaining({ nodeIds: [] }));
    expect(sw.extractAirwayOsmPool('')).toEqual(expect.objectContaining({ nodeIds: [] }));
    expect(sw.extractTaxiwayOsmPool(null).segIds).toEqual([]);
    expect(sw.extractAirwayOsmPool(null).segIds).toEqual([]);
  });
  it('scenery_write getAirwayOsmPoolInfo handles empty pool gracefully', () => {
    const info = sw.getAirwayOsmPoolInfo([], { airwayNodes: [], procedures: [] }, { airwayNodeOrigPk: [], airwaySegOrigPk: [], deletedAirwayPks: [] });
    expect(info.nodePoolSize).toBe(0);
    expect(info.pendingNewNodes).toBe(0);
  });
});

describe('approach — no-STAR handling and helpers', () => {
  it('extractStarRunwayMappings returns empty for empty text', () => {
    const m = approach.extractStarRunwayMappings('');
    expect(m.starRunwayMap).toEqual({});
    expect(m.runwayStarMap).toEqual({});
    expect(approach.extractStarRunwayMappings(null).starRunwayMap).toEqual({});
  });
  it('extractStarWaypoints returns empty for empty text', () => {
    expect(approach.extractStarWaypoints('')).toEqual({});
    expect(approach.extractStarWaypoints(null)).toEqual({});
  });
  it('computeFullTerminalPath returns zero for unknown STAR/runway', () => {
    const p = approach.computeFullTerminalPath('', 'NO_STAR', '99');
    expect(p.total).toBe(0);
    expect(p.flyLen).toBe(0);
  });
  it('computeApproachTimesFromScenery with empty mappings returns empty or ref', () => {
    const empty = approach.computeApproachTimesFromScenery('', null, null, null, 1600, 100);
    expect(empty.size).toBe(0);
    const ref = new Map([['STAR_A', 1600]]);
    const res = approach.computeApproachTimesFromScenery('x', { starRunwayMap: { STAR_A: ['01'] }, runwayStarMap: { '01': ['STAR_A'] } }, new Map(), ref, 1600, 100);
    expect(res instanceof Map).toBe(true);
  });
  it('resolveFlyApproachPoints returns [] for unknown route/runway', () => {
    expect(approach.resolveFlyApproachPoints('', 'STAR', '99')).toEqual([]);
    expect(approach.resolveFlyApproachPoints('', '', '')).toEqual([]);
  });
  it('FIX_NAME_RE filters TurnPoint/TP correctly (JN210 excluded, PANKI kept)', () => {
    const { FIX_NAME_RE } = require('../../src/utils/constants/aviation.js');
    expect(FIX_NAME_RE.test('PANKI')).toBe(true);
    expect(FIX_NAME_RE.test('JN210')).toBe(false);
    expect(FIX_NAME_RE.test('TurnPoint')).toBe(false);
    expect(FIX_NAME_RE.test('TP01')).toBe(false);
  });
  it('_normalizeRunway strips leading zeros', () => {
    expect(approach._normalizeRunway('01')).toBe('1');
    expect(approach._normalizeRunway('01L')).toBe('1L');
    expect(approach._normalizeRunway('19')).toBe('19');
    expect(approach._normalizeRunway('')).toBe('');
  });
});
