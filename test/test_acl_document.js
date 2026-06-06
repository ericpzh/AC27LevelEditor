/**
 * Test the AclDocument model against synthetic ACL-like data.
 *
 * Usage: node test/test_acl_document.js [--root <game-root>]
 */

const { AclDocument } = require('../src/acl/acl_document');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS:', name);
  } catch (e) {
    failed++;
    console.log('  FAIL:', name);
    console.log('       ', e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}

console.log('\n=== AclDocument Tests ===\n');

// ── Synthetic tests ───────────────────────────────────────────────

console.log('--- Section Indexing ---');

test('indexes known top-level sections', () => {
  const acl = `{
  "SceneryData": { "runways": [] },
  "WorldState": {
    "Aircrafts": { "$rcontent": [], "$rlength": 0 },
    "AircraftAnimators": { "$rcontent": [], "$rlength": 0 },
    "FlightPlans": { "$rcontent": [], "$rlength": 0 }
  },
  "GameTime": { "CurrentDateTime": { "$type": 3, 0 } },
  "Config": {
    "startTime": "06:00:00",
    "endTime": "18:00:00",
    "flightScheduleFile": "",
    "runwayTimelineFile": ""
  },
  "WeatherFrames": { "frames": [] },
  "WindFrames": { "frames": [] },
  "RunwayTimeline": { "entries": [] }
}`;
  const doc = new AclDocument(acl);

  assert(doc.hasSection('SceneryData'), 'should have SceneryData');
  assert(doc.hasSection('WorldState'), 'should have WorldState');
  assert(doc.hasSection('Aircrafts'), 'should have Aircrafts (sub-section)');
  assert(doc.hasSection('AircraftAnimators'), 'should have AircraftAnimators');
  assert(doc.hasSection('FlightPlans'), 'should have FlightPlans');
  assert(doc.hasSection('GameTime'), 'should have GameTime');
  assert(doc.hasSection('Config'), 'should have Config');
  assert(doc.hasSection('WeatherFrames'), 'should have WeatherFrames');
  assert(doc.hasSection('WindFrames'), 'should have WindFrames');
  assert(doc.hasSection('RunwayTimeline'), 'should have RunwayTimeline');
});

test('getConfig returns parsed values', () => {
  const acl = `{
  "Config": {
    "startTime": "06:00:00",
    "endTime": "18:00:00",
    "flightScheduleFile": "test.flightschedule",
    "runwayTimelineFile": "test.runway"
  }
}`;
  const doc = new AclDocument(acl);
  const cfg = doc.getConfig();
  assert(cfg !== null, 'should have config');
  assertEq(cfg.startTime, '06:00:00');
  assertEq(cfg.endTime, '18:00:00');
  assertEq(cfg.flightScheduleFile, 'test.flightschedule');
  assertEq(cfg.runwayTimelineFile, 'test.runway');
});

test('getGameTime returns parsed time values', () => {
  const acl = `{
  "GameTime": {
    "BaseTime": { "$type": 3, 638781400000000000 },
    "CurrentDateTime": { "$type": 3, 638781534000000000 }
  }
}`;
  const doc = new AclDocument(acl);
  const gt = doc.getGameTime();
  assert(gt !== null, 'should have gametime');
  assert(gt.secSinceMidnight !== undefined, 'should have secSinceMidnight');
  assert(gt.timeString !== undefined, 'should have timeString');
  console.log('      ticks=' + String(gt.ticks) + ' time=' + gt.timeString);
});

test('getFlightPlanEntries returns parsed entries', () => {
  const acl = `{
  "WorldState": {
    "FlightPlans": {
      "$type": "52|...",
      "$rlength": 2,
      "$rcontent": [
        { "$k": "guid-1", "$v": { "$type": "37|...", "Registration": "B-1234", "AircraftType": "A320" } },
        { "$k": "guid-2", "$v": { "Registration": "B-5678", "AircraftType": "B738" } }
      ]
    }
  }
}`;
  const doc = new AclDocument(acl);
  const entries = doc.getFlightPlanEntries();
  assert(entries !== null, 'should have entries');
  assertEq(entries.length, 2, 'should have 2 entries');
  assertEq(entries[0].k, 'guid-1');
  assertEq(entries[0].v.Registration, 'B-1234');
  assertEq(entries[1].k, 'guid-2');
  assertEq(entries[1].v.Registration, 'B-5678');
});

test('getTypeMap extracts type declarations', () => {
  const acl = `{
  "SomeSection": {
    "$type": "56|ContextCross.States.FlightPlanState, GroundATC.Core",
    "data": {}
  },
  "OtherSection": {
    "$type": "35|ContextCross.States.AircraftState, GroundATC.Core",
    "inner": {
      "$type": "16|UnityEngine.Vector3, UnityEngine.CoreModule",
      "x": 1
    }
  }
}`;
  const doc = new AclDocument(acl);
  const typeMap = doc.getTypeMap();
  assert(typeMap.size >= 2, 'should have at least 2 types');
  assertEq(typeMap.get(56), 'ContextCross.States.FlightPlanState, GroundATC.Core');
  assertEq(typeMap.get(35), 'ContextCross.States.AircraftState, GroundATC.Core');
});

// ── Mutation tests ────────────────────────────────────────────────

console.log('\n--- Mutation ---');

test('toAclString returns original text when unmodified', () => {
  const acl = '{"Config": {"startTime": "06:00:00"}}';
  const doc = new AclDocument(acl);
  const result = doc.toAclString();
  assertEq(result, acl, 'unmodified doc should return original text');
});

test('setSection updates a section', () => {
  const acl = '{\n  "Config": {\n    "startTime": "06:00:00",\n    "endTime": "18:00:00"\n  }\n}';
  const doc = new AclDocument(acl);
  doc.setSection('Config', { startTime: '07:00:00', endTime: '19:00:00' });
  const result = doc.toAclString();
  assert(result.includes('"07:00:00"'), 'should contain updated startTime');
  assert(result.includes('"19:00:00"'), 'should contain updated endTime');
  assert(!result.includes('"06:00:00"'), 'should NOT contain old startTime');
});

test('setSectionRaw replaces section with raw text', () => {
  const acl = '{"WorldState": {"Aircrafts": {"$rcontent": [], "$rlength": 0}}}';
  const doc = new AclDocument(acl);
  doc.setSectionRaw('Aircrafts', '{"$rcontent": [{"a": 1}], "$rlength": 1}');
  const result = doc.toAclString();
  assert(result.includes('"$rcontent": [{"a": 1}]'), 'should contain raw replacement');
  assert(result.includes('"$rlength": 1'), 'should contain updated length');
});

test('isModified tracks changes', () => {
  const acl = '{"Config": {"startTime": "06:00:00"}, "WeatherFrames": []}';
  const doc = new AclDocument(acl);
  assert(!doc.isModified('Config'), 'should not be modified initially');
  assert(!doc.isModified('WeatherFrames'), 'should not be modified initially');

  doc.setSection('Config', { startTime: '07:00:00' });
  assert(doc.isModified('Config'), 'Config should be modified');
  assert(!doc.isModified('WeatherFrames'), 'WeatherFrames should not be modified');
});

test('getSection returns parsed object', () => {
  const acl = '{"Config": {"startTime": "06:00:00", "endTime": "18:00:00"}}';
  const doc = new AclDocument(acl);
  const cfg = doc.getSection('Config');
  assertEq(cfg.startTime, '06:00:00');
  assertEq(cfg.endTime, '18:00:00');
});

test('getSectionRaw returns raw text', () => {
  const acl = '{"Config": {"startTime": "06:00:00"}}';
  const doc = new AclDocument(acl);
  const raw = doc.getSectionRaw('Config');
  assert(raw.includes('"startTime": "06:00:00"'), 'should contain raw text');
});

test('getSectionRange returns correct positions', () => {
  const acl = '{"Config": {"startTime": "06:00:00"}}';
  const doc = new AclDocument(acl);
  const range = doc.getSectionRange('Config');
  assert(range !== null, 'should have range');
  const val = acl.substring(range.start, range.end);
  assertEq(val, '{"startTime": "06:00:00"}');
});

// ── Integration: round-trip ──────────────────────────────────────

console.log('\n--- Integration ---');

test('full round-trip: load → modify → serialize → verify', () => {
  const acl = `{
  "SceneryData": { "runways": { "RW01": "guid-01" } },
  "WorldState": {
    "Aircrafts": { "$rcontent": [], "$rlength": 0 },
    "FlightPlans": {
      "$rlength": 1,
      "$rcontent": [
        { "$k": "fp-1", "$v": { "Registration": "B-1234", "AircraftType": "A320" } }
      ]
    }
  },
  "Config": {
    "startTime": "06:00:00",
    "endTime": "12:00:00",
    "flightScheduleFile": "",
    "runwayTimelineFile": ""
  }
}`;

  // Load
  const doc = new AclDocument(acl);

  // Read
  const cfg = doc.getConfig();
  assertEq(cfg.startTime, '06:00:00');

  const entries = doc.getFlightPlanEntries();
  assertEq(entries.length, 1);
  assertEq(entries[0].v.Registration, 'B-1234');

  // Modify
  doc.setSection('Config', {
    startTime: '07:00:00',
    endTime: '13:00:00',
    flightScheduleFile: '',
    runwayTimelineFile: '',
  });

  // Serialize
  const result = doc.toAclString();

  // Verify the result contains expected modifications
  assert(result.includes('"07:00:00"'), 'should contain new startTime');
  assert(result.includes('"13:00:00"'), 'should contain new endTime');

  // Verify unmodified sections preserved
  assert(result.includes('"B-1234"'), 'should preserve flight data');
  assert(result.includes('"guid-01"'), 'should preserve scenery data');

  // Verify the result can be parsed again
  const doc2 = new AclDocument(result);
  const cfg2 = doc2.getConfig();
  assertEq(cfg2.startTime, '07:00:00');
});

// ── Summary ───────────────────────────────────────────────────────

console.log('\n=== Results: ' + passed + '/' + (passed + failed) + ' passed ===\n');

if (failed > 0) {
  process.exit(1);
}
