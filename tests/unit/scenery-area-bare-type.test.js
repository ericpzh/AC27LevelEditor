/**
 * Area detection with a BARE numeric `$type`.
 *
 * Odin registers a type inline (`"$type": "41|ContextCross.Models.Area, ..."`)
 * on its FIRST text occurrence and emits a bare `"$type": 41` reference for
 * every later one. The Ground Painter allocates a fresh type id when it
 * synthesizes the first Area into a file that had none, so the registration
 * lands on that single entry and sibling areas reference it bare.
 *
 * Regression: after a delete-all + re-add save on ZSJN_leisure_1 the game
 * rendered the new area but the editor showed none, because both area readers
 * (`scenery_graph.js:_isAreaEntity`, `scenery.js:_parseAreas`) only accepted
 * the name substring or the hardcoded 30/31.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _isAreaEntity, getBlobTypeMap, buildSceneryGraph } = require('../../src/acl/scenery_graph');
const { _parseAreas } = require('../../src/acl/scenery');

const AREA_NAME = 'ContextCross.Models.Area, GroundATC.Core';

describe('_isAreaEntity — bare $type resolution', () => {
  it('accepts the inline name form and the legacy 30/31 ids', () => {
    expect(_isAreaEntity('{ "$type": "41|' + AREA_NAME + '", "AreaType": 2 }')).toBe(true);
    expect(_isAreaEntity('{ "$type": "31|' + AREA_NAME + '", "AreaType": 2 }')).toBe(true);
    expect(_isAreaEntity('{ "$type": 30, "AreaType": 2 }')).toBe(true);
    expect(_isAreaEntity('{ "$type": 31, "AreaType": 2 }')).toBe(true);
  });

  it('resolves a bare id through the blobdoc type table', () => {
    const map = new Map([[41, 'ContextCross.Models.Area']]);
    expect(_isAreaEntity('{ "$type": 41, "AreaType": 2 }', map)).toBe(true);
    // Quoted bare reference form.
    expect(_isAreaEntity('{ "$type": "41", "AreaType": 2 }', map)).toBe(true);
  });

  it('rejects a bare id that maps to a non-Area type, or with no table', () => {
    expect(_isAreaEntity('{ "$type": 41, "AreaType": 2 }', new Map([[41, 'ContextCross.Models.Stand']]))).toBe(false);
    expect(_isAreaEntity('{ "$type": 41, "AreaType": 2 }', null)).toBe(false);
    expect(_isAreaEntity('{ "$type": 41, "AreaType": 2 }', new Map())).toBe(false);
    expect(_isAreaEntity('{ "$type": 12, "AreaType": 2 }', new Map([[12, 'SomethingElse']]))).toBe(false);
  });
});

/** Minimal ACL carrying two Area entries: the first registers a fresh type id,
 *  the second references it bare — the exact shape a delete-all + re-add yields. */
function makeAreaText() {
  const vec = (x, z) => '{ "$type": "5|UnityEngine.Vector3, UnityEngine.CoreModule", ' + x + ', 0, ' + z + ' }';
  const listFor = (id, pts) =>
    '{ "$id": ' + (id + 2) + ', "$type": "43|System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib", ' +
    '"$rlength": ' + pts.length + ', "$rcontent": [ ' + pts.map(([x, z]) => vec(x, z)).join(', ') + ' ] }';
  const area = (id, typeRef, areaType, pts, inlineListId) =>
    '{ "$id": ' + id + ', "$type": ' + typeRef + ', ' +
    '"NodePositions": { "$id": ' + (id + 1) + ', "$type": "42|R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib]], R3", ' +
    listFor(id, pts) + ' }, ' +
    '"AreaType": ' + areaType + ', "Enabled": true }';
  const p1 = [[6000, 6000], [6100, 6000], [6100, 6100], [6000, 6100]];
  const p2 = [[7000, 7000], [7100, 7000], [7100, 7100], [7000, 7100]];
  // Entry 1 carries the inline registration for a FRESH id (41); entry 2 reuses
  // it bare.
  const areas = [
    area(900, '"41|' + AREA_NAME + '"', 2, p1),
    area(903, '41', 1, p2),
  ];
  const npkArr = '[\n      ' + areas.join(',\n      ') + '\n    ]';
  // Seed the scope table so id 33 means a DIFFERENT type (the original collision).
  const pkEntries = ['{ "$k": "taxiway-node:1", "$v": { "$id": 1, "$type": "2|N, A", "PK": "taxiway-node:1", "OsmId": 1, "Name": null, "Type": 2, "Flags": 0 } }'];
  return '{ "$type": "0|Header, A",\n' +
    '  "StaticData": { "$blobdoc": {\n' +
    '    "$type": "0|B, A",\n' +
    '    "PKStaticEntities": { "$rlength": ' + pkEntries.length + ', "$rcontent": [ ' + pkEntries.join(', ') + ' ] },\n' +
    '    "NonPKStaticEntities": { "$rlength": ' + areas.length + ', "$rcontent": ' + npkArr + ' },\n' +
    '    "StaticItems": { "$rlength": 0, "$rcontent": [] }\n' +
    '  } }\n' +
    '}';
}

describe('area readers — file with a bare-$type area', () => {
  it('getBlobTypeMap resolves the fresh id to the Area type', () => {
    const map = getBlobTypeMap(makeAreaText());
    expect(map.get(41)).toContain('ContextCross.Models.Area');
  });

  it('buildSceneryGraph reads BOTH areas (inline registration + bare reference)', () => {
    const { graph } = buildSceneryGraph(makeAreaText());
    expect(graph.areas.map((a) => a.areaType)).toEqual([2, 1]);
    expect(graph.areas[1].points).toHaveLength(4);
  });

  it('scenery.js _parseAreas groups both areas by AreaType', () => {
    const grouped = _parseAreas(makeAreaText());
    expect((grouped[2] || []).length).toBe(1);
    expect((grouped[1] || []).length).toBe(1);
  });

  it('a bare id that maps to a non-Area type is not mistaken for an area', () => {
    // Swap the registration name for a non-Area type: neither reader may claim it.
    const text = makeAreaText().replace(AREA_NAME, 'ContextCross.Models.Stand');
    expect(buildSceneryGraph(text).graph.areas).toHaveLength(0);
    expect(Object.keys(_parseAreas(text))).toHaveLength(0);
  });
});
