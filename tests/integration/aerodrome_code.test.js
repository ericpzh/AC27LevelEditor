/** Runtime aircraft omit serialized specifications while retaining cache validation. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _buildActiveJetwayEntry, _buildStandaloneAircraftEntry, _IdMapper } = require('../../src/acl/flight_plans');
const { extractSpecificationDB } = require('../../src/acl/approach');
const { CANONICAL_SCOPE } = require('./_canonical_scope.cjs');

function makeSpec(overrides = {}) {
  return {
    Designator: 'A320',
    AerodromeCode: 67,
    WakeTurbulenceCategory: 77,
    WheelBase: 0.123,
    WingSpan: 0.3492,
    RunwayVRSpeed: 140,
    RunwayTakeOffLength: 1300,
    ModelOffset: { x: 0.19, y: -0.05, z: -0.2 },
    DockingPositions: [{ x: 1, y: 2, z: 3, w: 90 }],
    ...overrides,
  };
}

const SPEC_A320 = makeSpec();
const SPEC_B789 = makeSpec({ Designator: 'B789', AerodromeCode: 69, WakeTurbulenceCategory: 72 });

function makeApproachCache(spec) {
  return {
    designatorMap: new Map([[spec.Designator, spec.Designator]]),
    specDB: new Map([[spec.Designator, spec]]),
  };
}

function makeDepFlight(reg, aircraftType) {
  return {
    Stand: '09',
    isDeparture: true,
    OffBlockTime: '12:00:00',
    TakeoffTime: '12:30:00',
    _Registration: reg,
    Registration: reg,
    CallSign: 'TST' + reg.replace(/\W/g, ''),
    DepartureAirport: '',
    ArrivalAirport: 'ZBAA',
    Runway: '01',
    AircraftType: aircraftType,
    AirlineName: 'Test Air',
    Airway: '',
    Voice: 'EN',
    Language: 'EN',
  };
}

function makeCaches() {
  const alloc = { v: 1000 };
  const strArr = { canonicalId: null, canonicalEmitted: false, alloc };
  const recv = { canonicalId: null, canonicalEmitted: false, alloc };
  const wait = { canonicalId: null, canonicalEmitted: false, alloc };
  strArr.canonicalId = alloc.v++;
  recv.canonicalId = alloc.v++;
  wait.canonicalId = alloc.v++;
  return { alloc, strArr, recv, wait };
}

function buildJetway(spec, reg) {
  const { alloc, strArr, recv, wait } = makeCaches();
  const idMapper = new _IdMapper();
  const info = { entryId: 190, key: 'jetway:09', vBlock: '{}' };
  return _buildActiveJetwayEntry(
    info,
    makeDepFlight(reg, spec.Designator),
    makeApproachCache(spec),
    () => {},
    CANONICAL_SCOPE,                 // jwTypeMap — strict per-scope type table
    0,                               // baseDateTicks
    'ZSJN',
    recv, wait,
    new Map([[reg, 900]]),           // fpIdByReg
    null,                            // standPositions
    strArr,
    alloc,
    idMapper
  );
}

describe('Runtime aircraft serialization and spec validation', () => {
  it('jetway builder omits the aircraft specification', () => {
    const res = buildJetway(SPEC_B789, 'B-0900');
    expect(res.text).not.toContain('"Specification"');
    expect(res.text).toContain('"DockingAircraft"');
    expect(res.text).toContain('"DynamicsData"');
    expect(res.text).toMatch(/"_groundIdleTimerState"\s*:\s*\{[^}]*"AccumulatedTicks"\s*:\s*0\s*,[^}]*"StartedAtTick"\s*:\s*0\s*,[^}]*"IsRunning"\s*:\s*false/s);
  });

  it('jetway builder asserts when spec lacks AerodromeCode', () => {
    const incomplete = { ...SPEC_B789 };
    delete incomplete.AerodromeCode;
    expect(() => buildJetway(incomplete, 'B-0902')).toThrowError(/AerodromeCode/);
    expect(() => buildJetway(incomplete, 'B-0902')).toThrowError(/B-0902/);
    expect(() => buildJetway(incomplete, 'B-0902')).toThrowError(/refusing fallback 67/);
  });

  it('standalone builder asserts when spec lacks AerodromeCode (fires before position resolution)', () => {
    const incomplete = { ...SPEC_B789 };
    delete incomplete.AerodromeCode;
    const opts = {
      reg: 'B-0903',
      flight: makeDepFlight('B-0903', 'B789'),
      entryId: 500,
      towerChannelId: null,
      apprChannelId: null,
      isDeparture: true,
      approachCache: makeApproachCache(incomplete),
      fullText: '',
      saveSec: 0,
      icao: 'ZSJN',
      baseDateTicks: 0,
      // Type resolution is STRICT — the T table resolves all 26 canonical
      // names eagerly (before the spec asserts), so the scope map must declare
      // them all; otherwise the test would throw [TYPE-ASSERT] instead of
      // asserting the missing AerodromeCode.
      segTypeMap: CANONICAL_SCOPE,
      log: () => {},
      fpId: null,
      strArrCache: null,
      recvEventsCache: null,
      waitingCmdsCache: null,
    };
    expect(() => _buildStandaloneAircraftEntry(opts)).toThrowError(/AerodromeCode/);
    expect(() => _buildStandaloneAircraftEntry(opts)).toThrowError(/B-0903/);
    expect(() => _buildStandaloneAircraftEntry(opts)).toThrowError(/refusing fallback 67/);
  });

  it('extractSpecificationDB asserts when a source spec lacks AerodromeCode', () => {
    const text = `{
      "Specification": {
        "$id": 1,
        "$type": 2,
        "Designator": "B77W",
        "WakeTurbulenceCategory": 72,
        "WheelBase": 0.24,
        "ModelOffset": { "$type": 3, 0.1, -0.05, -0.2 },
        "WingSpan": 0.6,
        "DockingPositions": { "$id": 4, "$type": 5, "$rlength": 1, "$rcontent": [ { "$type": 6, 1, 2, 3, 90 } ] },
        "RunwayVRSpeed": 143,
        "RunwayTakeOffLength": 2000
      }
    }`;
    expect(() => extractSpecificationDB(text, 'handcrafted.acl')).toThrowError(/AerodromeCode/);
    expect(() => extractSpecificationDB(text, 'handcrafted.acl')).toThrowError(/B77W/);
    expect(() => extractSpecificationDB(text, 'handcrafted.acl')).toThrowError(/handcrafted\.acl/);
    expect(() => extractSpecificationDB(text, 'handcrafted.acl')).toThrowError(/refusing fallback 67/);
  });
});
