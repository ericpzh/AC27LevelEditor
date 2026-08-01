/**
 * Regression test: duplicate $id collisions in rebuilt jetway entries.
 *
 * The static `entryId + offset` scheme assigned $id values to jetway
 * sub-objects.  When two jetways have different entryIds, their offset
 * ranges overlap: in fails.acl, jetway:09 id(15) = 190 + 15 = 205 and
 * jetway:12 id(3) = 202 + 3 = 205.  A duplicate $id that is an $iref
 * target makes the game's JsonDataReader bind the FIRST declaration
 * (first-wins), so aircraft:B-5380A's $iref:205 resolved to a String[]
 * wrapper instead of the Aircraft → "Data layout mismatch; skipping past
 * node boundary when exiting array".
 *
 * The fix allocates every rebuilt sub-object $id from the segment's
 * dynamic allocator and registers old→new mappings in the IdMapper.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _buildActiveJetwayEntry, _makeJwTypeResolver, _IdMapper } = require('../../src/acl/flight_plans');

// Canonical names matched by the resolver (JW_TYPE_* in flight_plans.js).
const RP_INT32 = 'R3.ReactiveProperty`1[[System.Int32, mscorlib]], R3';
const RP_SINGLE = 'R3.ReactiveProperty`1[[System.Single, mscorlib]], R3';
const RP_AIRCRAFT = 'R3.ReactiveProperty`1[[ContextCross.Aircrafts.Aircraft, GroundATC.Core]], R3';
const JETWAY = 'ContextCross.Models.Jetway, GroundATC.Core';
const AIRCRAFT = 'ContextCross.Aircrafts.Aircraft, GroundATC.Core';

// The exact collision pair from fails.acl's checkpoint frame:
//   jetway:09 entryId=190, HoldShortAcknowledgedRunwayNames = id(15) = 205
//   jetway:12 entryId=202, Aircraft                    = id(3)  = 205
const COLLIDING_ENTRY_IDS = [190, 202];

// Minimal spec object with the fields the template reads.
// Every field is REQUIRED — _buildActiveJetwayEntry asserts (requireSpecField)
// instead of silently defaulting, so an incomplete spec must be fixed here.
const SPEC = {
  Designator: 'A320',
  AerodromeCode: 67,
  WakeTurbulenceCategory: 77,
  WheelBase: 0.123,
  WingSpan: 0.34,
  RunwayVRSpeed: 140,
  RunwayTakeOffLength: 1300,
  ModelOffset: { x: 0.1, y: 0, z: 0 },
  DockingPositions: [{ x: 1, y: 2, z: 3, w: 90 }],
};

// Minimal approach cache so spec resolution succeeds without reading vBlock.
const APPROACH_CACHE = {
  designatorMap: new Map([['A320', 'A320']]),
  specDB: new Map([['A320', SPEC]]),
};

function makeDepFlight(reg, stand) {
  return {
    Stand: String(stand),
    isDeparture: true,
    OffBlockTime: '12:00:00',
    TakeoffTime: '12:30:00',
    _Registration: reg,
    Registration: reg,
    CallSign: 'TST' + reg.replace(/\W/g, ''),
    DepartureAirport: '',
    ArrivalAirport: 'ZBAA',
    Runway: '01',
    AircraftType: 'A320',
    AirlineName: 'Test Air',
    Airway: '',
    Voice: 'EN',
    Language: 'EN',
  };
}

function buildEntry(entryId, reg, stand, alloc, strArrCache, recvCache, waitCache, fpIdByReg, idMapper) {
  const info = { entryId, key: 'jetway:' + stand, vBlock: '{}' };
  return _buildActiveJetwayEntry(
    info,
    makeDepFlight(reg, stand),
    APPROACH_CACHE,
    () => {},
    new Map(),          // jwTypeMap — fresh type numbers via _jwResolveType
    0,                  // baseDateTicks
    'ZSJN',
    recvCache,
    waitCache,
    fpIdByReg,
    null,               // standPositions — position defaults
    strArrCache,
    alloc,
    idMapper
  );
}

function collectIds(text) {
  return [...text.matchAll(/"\$id":\s*(\d+)/g)].map(m => parseInt(m[1], 10));
}

describe('_buildActiveJetwayEntry dynamic $id allocation', () => {
  it('produces no duplicate $ids across colliding jetway ranges', () => {
    // Replicate the pipeline: one shared allocator per segment, canonical
    // ids claimed before any entry is built.
    const alloc = { v: 1000 };
    const strArr = { canonicalId: null, canonicalEmitted: false, alloc };
    const recv = { canonicalId: null, canonicalEmitted: false, alloc };
    const wait = { canonicalId: null, canonicalEmitted: false, alloc };
    strArr.canonicalId = alloc.v++;
    recv.canonicalId = alloc.v++;
    wait.canonicalId = alloc.v++;
    const idMapper = new _IdMapper();

    const results = COLLIDING_ENTRY_IDS.map((entryId, i) =>
      buildEntry(
        entryId,
        i === 0 ? 'B-5380A' : 'B-6688',
        i === 0 ? '09' : '12',
        alloc, strArr, recv, wait,
        new Map([[i === 0 ? 'B-5380A' : 'B-6688', 900 + i]]),
        idMapper
      )
    );

    const combined = results.map(r => r.text).join('\n');
    const ids = collectIds(combined);

    // The old scheme produced $id:205 twice (190+15 and 202+3).
    expect(ids.filter(id => id === 205)).toHaveLength(0);
    // All ids unique.
    expect(new Set(ids).size).toBe(ids.length);
    // Both aircraft anchors distinct and present in their entries.
    expect(results[0].aircraftId).not.toBe(results[1].aircraftId);
    expect(results[0].text).toContain('"$id": ' + results[0].aircraftId);
    expect(results[1].text).toContain('"$id": ' + results[1].aircraftId);
  });

  it('remaps the collided $iref:205 to the Aircraft id (last registration wins)', () => {
    const alloc = { v: 1000 };
    const strArr = { canonicalId: null, canonicalEmitted: false, alloc };
    const recv = { canonicalId: null, canonicalEmitted: false, alloc };
    const wait = { canonicalId: null, canonicalEmitted: false, alloc };
    strArr.canonicalId = alloc.v++;
    recv.canonicalId = alloc.v++;
    wait.canonicalId = alloc.v++;
    const idMapper = new _IdMapper();

    // jetway:09 (entryId 190) registers old id(15)=205 first;
    // jetway:12 (entryId 202) registers old id(3)=205 second.
    buildEntry(190, 'B-5380A', '09', alloc, strArr, recv, wait, new Map([['B-5380A', 900]]), idMapper);
    const second = buildEntry(202, 'B-6688', '12', alloc, strArr, recv, wait, new Map([['B-6688', 901]]), idMapper);

    // The collided old id 205 must resolve to the Aircraft of the second
    // jetway — the object aircraft:REG entries meant by $iref:205.
    expect(idMapper.resolve(205)).toBe(second.aircraftId);

    // A preserved entry referencing the old id gets rewritten to the new one.
    const remapped = idMapper.remapIrefs('"$v": $iref:205');
    expect(remapped.count).toBe(1);
    expect(remapped.text).toBe('"$v": $iref:' + second.aircraftId);
  });

  it('allocates ids past every static id, flight-plan id, and canonical claim', () => {
    const alloc = { v: 1000 };
    const strArr = { canonicalId: null, canonicalEmitted: false, alloc };
    const recv = { canonicalId: null, canonicalEmitted: false, alloc };
    const wait = { canonicalId: null, canonicalEmitted: false, alloc };
    strArr.canonicalId = alloc.v++;
    recv.canonicalId = alloc.v++;
    wait.canonicalId = alloc.v++;
    const idMapper = new _IdMapper();

    const result = buildEntry(190, 'B-5380A', '09', alloc, strArr, recv, wait, new Map([['B-5380A', 950]]), idMapper);
    const ids = collectIds(result.text);

    // Only the entry's own root id (190) and the precomputed _flightPlan id
    // (950) stay in the static range; every other sub-object id must come
    // from the dynamic allocator (≥1000) and never fall back into the
    // colliding entryId+offset range (191-228).
    const rootIds = ids.filter(id => id === 190);
    const fpIds = ids.filter(id => id === 950);
    const dynamicIds = ids.filter(id => id !== 190 && id !== 950);
    expect(rootIds).toHaveLength(1);
    expect(fpIds).toHaveLength(1);
    expect(dynamicIds.length).toBeGreaterThan(0);
    for (const id of dynamicIds) expect(id).toBeGreaterThanOrEqual(1000);
  });
});

describe('DockingDoorIndex $type resolution (per-scope type ids)', () => {
  // fails.acl's frame scope registers R3.ReactiveProperty<Int32> at id 29 and
  // id 6 is plain Aircraft — the old hardcoded id-6 assumption wrote
  // "$type": "6|ContextCross.Aircrafts.Aircraft, GroundATC.Core" for
  // DockingDoorIndex, which the game misreads.
  const FAILS_SCOPE = new Map([
    [3, JETWAY],
    [4, RP_SINGLE],
    [5, RP_AIRCRAFT],
    [6, AIRCRAFT],
    [29, RP_INT32],
  ]);

  function buildWithScope(scope) {
    const alloc = { v: 1000 };
    const strArr = { canonicalId: null, canonicalEmitted: false, alloc };
    const recv = { canonicalId: null, canonicalEmitted: false, alloc };
    const wait = { canonicalId: null, canonicalEmitted: false, alloc };
    strArr.canonicalId = alloc.v++;
    recv.canonicalId = alloc.v++;
    wait.canonicalId = alloc.v++;
    return _buildActiveJetwayEntry(
      { entryId: 190, key: 'jetway:09', vBlock: '{}' },
      makeDepFlight('B-5380A', '09'),
      APPROACH_CACHE,
      () => {},
      scope,
      0,
      'ZSJN',
      recv,
      wait,
      new Map([['B-5380A', 950]]),
      null,
      strArr,
      alloc,
      new _IdMapper()
    ).text;
  }

  function dockingDoorType(text) {
    const m = text.match(/"DockingDoorIndex":\s*\{\s*"\$id":\s*\d+,\s*"\$type":\s*("[^"]*"|\d+)/);
    return m ? m[1] : null;
  }

  it('resolves DockingDoorIndex to R3.ReactiveProperty<Int32> when id 6 is a different type', () => {
    const text = buildWithScope(FAILS_SCOPE);
    // The game's expected emission in this scope (id 29), NOT id 6 = Aircraft.
    expect(dockingDoorType(text)).toBe('"29|' + RP_INT32 + '"');
    // Sibling fields keep their correct scope ids 3/4/5.
    expect(text).toContain('"$type": "3|' + JETWAY + '"');
    expect(text).toContain('"$type": "4|' + RP_SINGLE + '"');
    expect(text).toContain('"$type": "5|' + RP_AIRCRAFT + '"');
  });

  it('mints a fresh id above the segment max when RP<Int32> is undeclared in the scope', () => {
    const scopeNoInt32 = new Map(FAILS_SCOPE);
    scopeNoInt32.delete(29);
    const type = dockingDoorType(buildWithScope(scopeNoInt32));
    // Full-form self-declaring emission (never a bare dangling ref), with an
    // id above the segment's max declared id (6).
    const m = type && type.match(/^"(\d+)\|R3\.ReactiveProperty`1\[\[System\.Int32, mscorlib\]\], R3"$/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1], 10)).toBeGreaterThan(6);
  });

  it('keeps the canonical emission (id 6 = RP<Int32>) byte-identical on ZSJN-Morning-style scopes', () => {
    const text = buildWithScope(new Map([
      [3, JETWAY],
      [4, RP_SINGLE],
      [5, RP_AIRCRAFT],
      [6, RP_INT32],
    ]));
    expect(dockingDoorType(text)).toBe('"6|' + RP_INT32 + '"');
  });

  it('shares one fresh-id counter across calls on a single resolver', () => {
    const resolve = _makeJwTypeResolver(FAILS_SCOPE);
    const a = resolve('Some.Missing.TypeA, GroundATC.Core');
    const b = resolve('Some.Missing.TypeB, GroundATC.Core');
    const idOf = (s) => parseInt(s.match(/^"(\d+)\|/)[1], 10);
    expect(idOf(a)).toBeGreaterThan(29); // above this scope's max declared id
    expect(idOf(b)).toBe(idOf(a) + 1);
    // Known names resolve to their scope id, full form.
    expect(resolve(RP_INT32)).toBe('"29|' + RP_INT32 + '"');
  });
});
