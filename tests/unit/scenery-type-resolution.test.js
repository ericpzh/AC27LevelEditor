/**
 * Unit tests for the scope-local `$type` resolution helpers and the runway
 * Entry/Exit element prune added to `scenery_write.js`.
 *
 * Context (regressions these lock in):
 *  - `Type id 33 claimed by both "List<Vector3>" and "Dictionary<string, IStaticItem>"`
 *    — the encoder aborts when a hardcoded fallback type id collides with a
 *    different type the file actually declares. Fallbacks must resolve against
 *    the file's own `$blobdoc` table, and unknown names must take a fresh id
 *    above the scope max.
 *  - Deleting every taxiway serving a runway used to drop the whole survivor
 *    runway (its `Entries`/`Exits` refs went dangling). It must instead prune the
 *    dead Entry/Exit ELEMENTS and keep the runway.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  _scopeMaxTypeId,
  _resolveTypeOrFresh,
  _sampleAreaShapes,
  _sampleStandShapes,
  _sampleRouteShapes,
  _pruneRunwayEntryExitElements,
} = require('../../src/acl/scenery_write');

describe('_scopeMaxTypeId', () => {
  it('returns the highest of both inline ("N|Name") and bare (N) $type forms', () => {
    const text = '{ "$type": "4|A, B", "x": { "$type": 41, "y": { "$type": "55|C, D" } } }';
    expect(_scopeMaxTypeId(text)).toBe(55);
  });

  it('returns 0 for an empty scope', () => {
    expect(_scopeMaxTypeId('')).toBe(0);
    expect(_scopeMaxTypeId(null)).toBe(0);
    expect(_scopeMaxTypeId('{}')).toBe(0);
  });
});

describe('_resolveTypeOrFresh', () => {
  const NAMES = ['ContextCross.Models.Area, GroundATC.Core'];

  it('prefers the file\'s own table entry for the canonical name', () => {
    const docTypes = new Map([['ContextCross.Models.Area, GroundATC.Core', '"41|ContextCross.Models.Area, GroundATC.Core"']]);
    const fresh = { next: 100 };
    expect(_resolveTypeOrFresh(docTypes, NAMES, fresh, '"31|ContextCross.Models.Area, GroundATC.Core"'))
      .toBe('"41|ContextCross.Models.Area, GroundATC.Core"');
    // A table hit must NOT consume a fresh id.
    expect(fresh.next).toBe(100);
  });

  it('allocates a fresh id above the scope max when the name is undeclared (never the colliding hardcoded id)', () => {
    const fresh = { next: 42 };
    const v = _resolveTypeOrFresh(new Map(), NAMES, fresh, '"31|ContextCross.Models.Area, GroundATC.Core"');
    expect(v).toBe('"42|ContextCross.Models.Area, GroundATC.Core"');
    expect(fresh.next).toBe(43);
  });

  it('falls back to the legacy hardcoded id only when no scope info is threaded', () => {
    expect(_resolveTypeOrFresh(null, NAMES, null, '"31|ContextCross.Models.Area, GroundATC.Core"'))
      .toBe('"31|ContextCross.Models.Area, GroundATC.Core"');
  });
});

describe('_sampleAreaShapes', () => {
  // Minimal Area entity: the inner List object has its `$id` wrapper BEFORE
  // `$type`, which is exactly the shape that used to degrade listType to null.
  const AREA =
    '{ "$id": 900, "$type": "31|ContextCross.Models.Area, GroundATC.Core", ' +
    '"NodePositions": { "$id": 901, "$type": "32|R3.ReactiveProperty, R3", ' +
    '{ "$id": 902, "$type": "33|System.Collections.Generic.List, mscorlib", "$rlength": 3, ' +
    '"$rcontent": [ { "$type": "5|UnityEngine.Vector3, UnityEngine.CoreModule", 1, 0, 2 } ] } }, ' +
    '"AreaType": 2, "Enabled": true }';

  it('samples every type from an existing Area (inline ids win)', () => {
    const s = _sampleAreaShapes([AREA], null, null);
    expect(s.areaType).toBe('"31|ContextCross.Models.Area, GroundATC.Core"');
    expect(s.rpType).toBe('"32|R3.ReactiveProperty, R3"');
    expect(s.listType).toBe('"33|System.Collections.Generic.List, mscorlib"');
    expect(s.vecType).toBe('"5|UnityEngine.Vector3, UnityEngine.CoreModule"');
  });

  it('resolves undeclared types from the file table when no Area is present (no $type: 0, no collision)', () => {
    const docTypes = new Map([
      ['ContextCross.Models.Area, GroundATC.Core', '"41|ContextCross.Models.Area, GroundATC.Core"'],
      ['R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib]], R3', '"42|RP-R3"'],
      ['System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib', '"43|ListV3"'],
      ['UnityEngine.Vector3, UnityEngine.CoreModule', '"5|Vec3"'],
    ]);
    const s = _sampleAreaShapes([], docTypes, { next: 60 });
    expect(s.areaType).toBe('"41|ContextCross.Models.Area, GroundATC.Core"');
    expect(s.rpType).toBe('"42|RP-R3"');
    expect(s.listType).toBe('"43|ListV3"');
    expect(s.vecType).toBe('"5|Vec3"');
  });

  it('mints fresh ids (above the scope max) for names the file never declares, without emitting "$type": 0', () => {
    const fresh = { next: 41 };
    const s = _sampleAreaShapes([], new Map(), fresh);
    for (const v of [s.areaType, s.rpType, s.listType, s.vecType]) {
      expect(v).not.toBe('0');
      expect(v).not.toMatch(/^"0\|/);
    }
    // Four distinct ids consumed from the shared allocator.
    expect(fresh.next).toBe(45);
    const ids = [s.areaType, s.rpType, s.listType, s.vecType].map((v) => parseInt(v.match(/"(\d+)\|/)[1], 10));
    expect(new Set(ids).size).toBe(4);
    expect(Math.min(...ids)).toBe(41);
  });
});

describe('_sampleStandShapes', () => {
  const STAND =
    '{ "$k": "stand:1", "$v": { "$id": 10, "$type": "26|ContextCross.Models.Stand, GroundATC.Core", ' +
    '"PushbackLimitPositions": { "$id": 11, "$type": "27|R3.ReactiveProperty, R3", "$rlength": 0, "$rcontent": [] }, ' +
    '"ParkingType": 1, "EgressType": 0, "Name": "A1", "Identifier": "1" } }';

  it('samples an existing stand (inline ids win)', () => {
    const s = _sampleStandShapes([STAND], null, null);
    expect(s.standType).toBe('"26|ContextCross.Models.Stand, GroundATC.Core"');
    expect(s.pbArrayType).toBe('"27|R3.ReactiveProperty, R3"');
  });

  it('uses the file table for an undeclared stand type instead of the hardcoded 20/21', () => {
    // The ZSJN shape: id 20 already means Runway+Route in the scope table.
    const docTypes = new Map([
      ['ContextCross.Models.Stand, GroundATC.Core', '"26|ContextCross.Models.Stand, GroundATC.Core"'],
      ['R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib]], R3', '"27|RP-ListV3"'],
    ]);
    const s = _sampleStandShapes([], docTypes, { next: 90 });
    expect(s.standType).toBe('"26|ContextCross.Models.Stand, GroundATC.Core"');
    expect(s.pbArrayType).toBe('"27|RP-ListV3"');
  });

  it('mints a fresh id only for the undeclared half, above the scope max', () => {
    const docTypes = new Map([['ContextCross.Models.Stand, GroundATC.Core', '"26|Stand"']]);
    const fresh = { next: 50 };
    const s = _sampleStandShapes([], docTypes, fresh);
    expect(s.standType).toBe('"26|Stand"');
    expect(s.pbArrayType).toBe('"50|R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib]], R3"');
    expect(fresh.next).toBe(51);
  });
});

describe('_sampleRouteShapes', () => {
  // Route sub-objects must also resolve through the scope table / a fresh id —
  // hardcoded 18/19/20 collide when the file's table uses those numbers for
  // other types (the class that broke ZSJN areas/stands).
  const NAMES = {
    routes: 'ContextCross.Models.Runway+Route[], GroundATC.Core',
    route: 'ContextCross.Models.Runway+Route, GroundATC.Core',
    airway: 'ContextCross.Models.AirwayNode[], GroundATC.Core',
  };
  const docTypes = new Map([
    [NAMES.routes, '"61|' + NAMES.routes + '"'],
    [NAMES.route, '"62|' + NAMES.route + '"'],
    [NAMES.airway, '"63|' + NAMES.airway + '"'],
  ]);

  it('prefers the file table for a level with no runway', () => {
    const s = _sampleRouteShapes([], docTypes, { next: 100 });
    expect(s.routesType).toBe('"61|' + NAMES.routes + '"');
    expect(s.routeType).toBe('"62|' + NAMES.route + '"');
    expect(s.airwayNodesType).toBe('"63|' + NAMES.airway + '"');
  });

  it('mints distinct fresh ids (above the scope max) when the table lacks the names', () => {
    const fresh = { next: 70 };
    const s = _sampleRouteShapes([], new Map(), fresh);
    const ids = [s.routesType, s.routeType, s.airwayNodesType].map((v) => {
      const m = v.match(/"(\d+)\|/);
      expect(m).toBeTruthy();
      return parseInt(m[1], 10);
    });
    expect(new Set(ids).size).toBe(3);
    expect(Math.min(...ids)).toBe(70);
    expect(s.routesType).toContain(NAMES.routes);
    expect(s.routeType).toContain(NAMES.route);
  });

  it('keeps the legacy canonical ids only when no scope info is threaded', () => {
    const s = _sampleRouteShapes([], null, null);
    expect(s.routesType).toBe('"18|ContextCross.Models.Runway+Route[], GroundATC.Core"');
    expect(s.routeType).toBe('"19|ContextCross.Models.Runway+Route, GroundATC.Core"');
    expect(s.airwayNodesType).toBe('"20|ContextCross.Models.AirwayNode[], GroundATC.Core"');
  });
});

describe('_pruneRunwayEntryExitElements', () => {
  // A runway block with 2 entries (ids 100,101 taxiway nodes) and 1 exit
  // (id 300). Structural ThresholdPoints point at 1/2 and are never touched.
  function runwayBlock() {
    const entry = (id, name, hold, line) =>
      '{ "$id": ' + id + ', "$type": "15|Runway+Entry, A", "Name": "' + name + '", ' +
      '"HoldingPosition": $iref:' + hold + ', "LineUpPosition": $iref:' + line + ', "DefinePoint": $iref:' + hold + ' }';
    const exit = (id, name, ex, hold) =>
      '{ "$id": ' + id + ', "$type": "16|Runway+Exit, A", "Name": "' + name + '", ' +
      '"ExitPosition": $iref:' + ex + ', "HoldingPosition": $iref:' + hold + ', "DefinePoint": $iref:' + hold + ', "IsLeft": false }';
    return '{ "$k": "runway:19", "$v": { "$id": 10, "$type": "13|ContextCross.Models.Runway, A", ' +
      '"Name": "19", "PhysicalRunwayStaticItem": { "$id": 11, "$type": "14|Item, A", "PhysicalName": "01/19" }, ' +
      '"Entries": { "$id": 12, "$type": "17|Runway+Entry[], A", "$rlength": 2, "$rcontent": [ ' +
      entry(20, 'A', 100, 101) + ', ' + entry(21, 'B', 200, 201) + ' ] }, ' +
      '"Exits": { "$id": 13, "$type": "18|Runway+Exit[], A", "$rlength": 1, "$rcontent": [ ' +
      exit(22, 'C', 300, 301) + ' ] }, ' +
      '"ThresholdPoints": { "$id": 14, "$type": "21|TaxiwayNode[], A", "$rlength": 2, "$rcontent": [ $iref:1, $iref:2 ] } } }';
  }

  const rlength = (block, sec) => {
    const i = block.indexOf('"' + sec + '"');
    const seg = block.slice(i);
    const m = seg.match(/"\$rlength":\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  const irefsIn = (block, sec) => {
    const i = block.indexOf('"' + sec + '"');
    const seg = block.slice(i);
    const rc = seg.indexOf('"$rcontent"');
    const open = seg.indexOf('[', rc);
    let depth = 0, end = -1;
    for (let k = open; k < seg.length; k++) {
      if (seg[k] === '[') depth++;
      else if (seg[k] === ']') { depth--; if (depth === 0) { end = k; break; } }
    }
    return [...seg.slice(open + 1, end).matchAll(/\$iref:\s*(\d+)/g)].map((m) => parseInt(m[1], 10));
  };

  it('drops only the Entry elements whose taxiway node was deleted, recomputing $rlength', () => {
    const res = _pruneRunwayEntryExitElements(runwayBlock(), new Set([100]));
    expect(res.pruned).toBe(1);
    // Entry A (held on deleted 100) is gone; Entry B survives.
    expect(res.entry).not.toContain('"Name": "A"');
    expect(res.entry).toContain('"Name": "B"');
    expect(rlength(res.entry, 'Entries')).toBe(1);
    expect(irefsIn(res.entry, 'Entries')).toEqual(expect.arrayContaining([200, 201]));
    expect(irefsIn(res.entry, 'Entries')).not.toContain(100);
    // The Exits wrapper is untouched.
    expect(rlength(res.entry, 'Exits')).toBe(1);
    expect(res.entry).toContain('"Name": "C"');
    // Structural threshold refs survive.
    expect(irefsIn(res.entry, 'ThresholdPoints')).toEqual([1, 2]);
  });

  it('prunes an Exit element too, and can empty a wrapper', () => {
    const res = _pruneRunwayEntryExitElements(runwayBlock(), new Set([300]));
    expect(res.pruned).toBe(1);
    expect(rlength(res.entry, 'Exits')).toBe(0);
    expect(irefsIn(res.entry, 'Exits')).toEqual([]);
    // Entries untouched.
    expect(rlength(res.entry, 'Entries')).toBe(2);
  });

  it('is a no-op when no dead ref is present (pruned 0, block unchanged)', () => {
    const block = runwayBlock();
    const res = _pruneRunwayEntryExitElements(block, new Set([9999]));
    expect(res.pruned).toBe(0);
    expect(res.entry).toBe(block);
  });
});
