/**
 * Test the string-aware tokenizer against synthetic and real ACL data.
 *
 * Usage: node test/test_tokenizer.js [--root <game-root>]
 */

const { createTokenizer } = require('../../src/acl/tokenizer');
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

console.log('\n=== Tokenizer Tests ===\n');

// ── Synthetic tests ───────────────────────────────────────────────

console.log('--- Synthetic ---');

test('findSection finds simple string value', () => {
  const t = createTokenizer('{"Config": {"startTime": "06:00:00"}}');
  const r = t.findSection('Config');
  assert(r !== null, 'should find Config');
  assert(t.substring(r.valueStart, r.valueEnd) === '{"startTime": "06:00:00"}', 'wrong value');
});

test('findSection finds object value', () => {
  const t = createTokenizer('{"GameTime": {"CurrentDateTime": {"$type": 3, 638781534000000000}}}');
  const r = t.findSection('GameTime');
  assert(r !== null, 'should find GameTime');
  const val = t.substring(r.valueStart, r.valueEnd);
  assert(val.startsWith('{'), 'should be object');
  assert(val.includes('CurrentDateTime'), 'should contain CurrentDateTime');
});

test('findSection finds null value', () => {
  const t = createTokenizer('{"SomeKey": null}');
  const r = t.findSection('SomeKey');
  assert(r !== null, 'should find SomeKey');
  assert(t.substring(r.valueStart, r.valueEnd) === 'null', 'should be null');
});

test('findSection ignores keys inside string values', () => {
  // "FlightPlans" appears in a string value BEFORE the actual key
  const t = createTokenizer('{"data": "the FlightPlans key is below", "FlightPlans": {"real": true}}');
  const r = t.findSection('FlightPlans');
  assert(r !== null, 'should find the real FlightPlans key');
  const val = t.substring(r.valueStart, r.valueEnd);
  assert(val === '{"real": true}', 'should get the real value');
});

test('findSection handles escaped quotes in string values', () => {
  const t = createTokenizer('{"key1": "has \\"escaped\\" quotes", "RealKey": "realValue"}');
  const r = t.findSection('RealKey');
  assert(r !== null, 'should find RealKey after escaped quotes');
  const val = t.substring(r.valueStart, r.valueEnd);
  assert(val === '"realValue"', 'should get realValue');
});

test('findArrayEnd finds matching ] for empty array', () => {
  const t = createTokenizer('[]');
  const end = t.findArrayEnd(0);
  assert(end === 2, 'should end at position 2');
});

test('findArrayEnd finds matching ] for array with objects', () => {
  const t = createTokenizer('[{"a": 1}, {"b": 2}]');
  const end = t.findArrayEnd(0);
  assert(end === 20, 'should end at position 20');
});

test('findArrayEnd handles braces inside strings', () => {
  const t = createTokenizer('[{"key": "value with {braces} inside"}]');
  const end = t.findArrayEnd(0);
  assert(end !== null, 'should find end');
});

test('findArrayEnd handles escaped quotes inside strings', () => {
  const t = createTokenizer('[{"key": "has \\"quote\\" and {brace}"}]');
  const end = t.findArrayEnd(0);
  assert(end !== null, 'should find end');
});

test('findArrayEnd handles nested objects and arrays', () => {
  const t = createTokenizer('[{"arr": [1, 2, {"nested": true}]}, {"b": 2}]');
  const end = t.findArrayEnd(0);
  assert(end !== null, 'should find end');
  assert(end === t.getLength(), 'should consume entire string');
});

test('findObjectEnd finds matching }', () => {
  const t = createTokenizer('{"a": {"nested": "obj"}, "b": 2}');
  const end = t.findObjectEnd(0);
  assert(end === t.getLength(), 'should end at string length');
});

test('findObjectEnd handles strings with braces', () => {
  const t = createTokenizer('{"key": "value {with} braces"}');
  const end = t.findObjectEnd(0);
  assert(end === t.getLength(), 'should end at string length');
});

test('skipString finds closing quote', () => {
  const t = createTokenizer('"hello world"');
  const end = t.skipString(0);
  assert(end === 13, 'should end at position 13 (len=13, "hello world")');
});

test('skipString handles escaped quotes', () => {
  const t = createTokenizer('"hello \\"world\\""');
  const end = t.skipString(0);
  assert(end === 17, 'should end at position 17');
});

test('getTopLevelKeys returns keys at depth 1', () => {
  const t = createTokenizer('{"a": 1, "b": {"nested": true}, "c": 3}');
  const keys = t.getTopLevelKeys(0, t.getLength());
  assert(keys.length === 3, 'should have 3 keys');
  assert(keys[0] === 'a', 'first should be a');
  assert(keys[1] === 'b', 'second should be b');
  assert(keys[2] === 'c', 'third should be c');
});

// ── Tests with real data patterns ─────────────────────────────────

console.log('\n--- Real Pattern Tests ---');

test('findSection finds Config in ACL-like structure', () => {
  const acl = `
{
  "SceneryData": { "big": "object" },
  "WorldState": {
    "Aircrafts": { "arr": [] },
    "FlightPlans": { "entries": [] }
  },
  "GameTime": { "time": "data" },
  "Config": {
    "startTime": "06:00:00",
    "endTime": "18:00:00",
    "flightScheduleFile": "test.flightschedule",
    "runwayTimelineFile": "test.runway"
  }
}`;
  const t = createTokenizer(acl);

  const cfg = t.findSection('Config');
  assert(cfg !== null, 'should find Config');

  const ws = t.findSection('WorldState');
  assert(ws !== null, 'should find WorldState');

  const scenery = t.findSection('SceneryData');
  assert(scenery !== null, 'should find SceneryData');

  const gt = t.findSection('GameTime');
  assert(gt !== null, 'should find GameTime');
});

test('findSection handles multiple sections with same prefix', () => {
  const acl = '{"RunwayTimeline": {"a": 1}, "RunwayTimelineFile": "something"}';
  const t = createTokenizer(acl);
  const r = t.findSection('RunwayTimeline');
  assert(r !== null, 'should find RunwayTimeline');
  assert(t.substring(r.valueStart, r.valueEnd) === '{"a": 1}', 'should get correct value');
});

test('findArrayEnd handles the $rcontent array pattern', () => {
  // This is the FlightPlans $rcontent pattern
  const acl = `[
  { "$k": "guid-1", "$v": { "Registration": "B-1234" } },
  { "$k": "guid-2", "$v": { "Registration": "B-5678" } }
]`;
  const t = createTokenizer(acl);
  const end = t.findArrayEnd(0);
  assert(end === acl.length, 'should consume entire array');
});

// ── Tests against real files (if game root available) ─────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && i + 1 < args.length) {
      opts.root = path.resolve(args[i + 1]);
      i++;
    }
  }
  return opts;
}

const opts = parseArgs();

if (opts.root) {
  console.log('\n--- Real ACL Files (root: ' + opts.root + ') ---');

  // Find ACL files in the game root
  const airportsDir = path.join(opts.root, 'GroundATC_Data', 'StreamingAssets', 'Airports');
  if (fs.existsSync(airportsDir)) {
    const airports = fs.readdirSync(airportsDir);
    for (const icao of airports) {
      const levelsDir = path.join(airportsDir, icao, 'Levels');
      if (!fs.existsSync(levelsDir)) continue;

      const files = fs.readdirSync(levelsDir).filter(f => f.endsWith('.acl'));
      for (const file of files.slice(0, 2)) { // Test first 2 files per airport
        const filePath = path.join(levelsDir, file);
        test('Real file sections: ' + icao + '/' + file, () => {
          const text = require('../../src/acl/gatcarc').readAclText(filePath);
          const t = createTokenizer(text);

          // Verify key sections exist
          const scenery = t.findSection('SceneryData');
          assert(scenery !== null, 'SceneryData not found');

          const ws = t.findSection('WorldState');
          assert(ws !== null, 'WorldState not found');

          // Find sub-sections within WorldState
          const wsText = t.substring(ws.valueStart, ws.valueEnd);
          const wsT = createTokenizer(wsText);
          const fp = wsT.findSection('FlightPlans');
          assert(fp !== null, 'FlightPlans not found in WorldState');

          console.log('      ' + file + ': sections OK (len=' + text.length + ')');
        });
      }
    }
  }
} else {
  console.log('\n(No --root specified, skipping real-file tests)');
}

// ── Summary ───────────────────────────────────────────────────────

console.log('\n=== Results: ' + passed + '/' + (passed + failed) + ' passed ===\n');

if (failed > 0) {
  process.exit(1);
}
