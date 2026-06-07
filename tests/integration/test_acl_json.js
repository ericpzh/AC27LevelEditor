/**
 * Test the ACL JSON pre-processor and serializer.
 *
 * Usage: node test/test_acl_json.js
 */

const {
  preprocessUnityJson,
  serializeUnityJson,
  _fixTrailingCommas,
  _fixSpecialFloats,
  _fixTypedValues,
} = require('../../src/acl/acl_json');

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

console.log('\n=== ACL JSON Tests ===\n');

// ── Trailing comma fix ────────────────────────────────────────────

console.log('--- Fix Trailing Commas ---');

test('removes trailing comma before }', () => {
  const result = _fixTrailingCommas('{"a": 1,}');
  assertEq(result, '{"a": 1}', 'should remove trailing comma');
});

test('removes trailing comma before ]', () => {
  const result = _fixTrailingCommas('[1, 2,]');
  assertEq(result, '[1, 2]', 'should remove trailing comma in array');
});

test('keeps comma when next token is not } or ]', () => {
  const result = _fixTrailingCommas('{"a": 1, "b": 2}');
  assertEq(result, '{"a": 1, "b": 2}', 'should keep valid commas');
});

test('does not remove comma inside string value', () => {
  const result = _fixTrailingCommas('{"a": "hello, world}"}');
  // The comma is inside a string, so it should be preserved.
  // The } after world is also inside the string, so the comma before it stays.
  assert(result.includes('hello, world'), 'should preserve string content');
});

test('handles multiple trailing commas', () => {
  const result = _fixTrailingCommas('{"a": 1, "b": [1, 2,], "c": 3,}');
  const parsed = JSON.parse(result);
  assertEq(parsed.a, 1);
  assertEq(parsed.b.length, 2);
  assertEq(parsed.c, 3);
});

// ── Special floats ────────────────────────────────────────────────

console.log('\n--- Fix Special Floats ---');

test('replaces NaN with 0', () => {
  const result = _fixSpecialFloats('{"a": NaN}');
  assert(result.includes('"a": 0'), 'should replace NaN with 0');
});

test('replaces Infinity with null', () => {
  const result = _fixSpecialFloats('{"a": Infinity}');
  assert(result.includes('"a": null'), 'should replace Infinity with null');
});

test('replaces -Infinity with null', () => {
  const result = _fixSpecialFloats('{"a": -Infinity}');
  assert(result.includes('"a": null'), 'should replace -Infinity with null');
});

// ── Typed-value transformation ────────────────────────────────────

console.log('\n--- Fix Typed Values ---');

test('transforms DateTime: {"$type": 3, ticks}', () => {
  const input = '{"LandingTime": {"$type": 3, 638781534000000000}}';
  const result = _fixTypedValues(input);
  // Should be valid JSON now
  const parsed = JSON.parse(result);
  assert(parsed.LandingTime.__v !== undefined, 'should have __v');
  assertEq(parsed.LandingTime.__v[0], '638781534000000000', 'should preserve int64 as string');
  assertEq(parsed.LandingTime.$type, 3, 'should preserve $type');
});

test('transforms DateTime with full type string', () => {
  const input = '{"OffBlockTime": {"$type": "3|System.DateTime, mscorlib", 638781534000000000}}';
  const result = _fixTypedValues(input);
  const parsed = JSON.parse(result);
  assert(parsed.OffBlockTime.__v !== undefined, 'should have __v');
  assertEq(parsed.OffBlockTime.__v[0], '638781534000000000');
  assertEq(parsed.OffBlockTime.$type, '3|System.DateTime, mscorlib');
});

test('transforms Vector3: {"$type": "16|...", x, 0, z}', () => {
  const input = '{"Position": {"$type": "16|UnityEngine.Vector3, UnityEngine.CoreModule", 10.5, 0, 20.3}}';
  const result = _fixTypedValues(input);
  const parsed = JSON.parse(result);
  assert(parsed.Position.__v !== undefined, 'should have __v');
  assertEq(parsed.Position.__v.length, 3, 'should have 3 values');
  assertEq(parsed.Position.__v[0], 10.5);
  assertEq(parsed.Position.__v[1], 0);
  assertEq(parsed.Position.__v[2], 20.3);
});

test('transforms Vector3 with short-form type', () => {
  const input = '{"Position": {"$type": 16, 10.5, 0, 20.3}}';
  const result = _fixTypedValues(input);
  const parsed = JSON.parse(result);
  assert(parsed.Position.__v !== undefined, 'should have __v');
  assertEq(parsed.Position.$type, 16);
  assertEq(parsed.Position.__v[0], 10.5);
  assertEq(parsed.Position.__v[1], 0);
  assertEq(parsed.Position.__v[2], 20.3);
});

test('transforms object with $id before $type', () => {
  const input = '{"$id": 123, "$type": 3, 638781534000000000}';
  const result = _fixTypedValues(input);
  const parsed = JSON.parse(result);
  assertEq(parsed.$id, 123);
  assertEq(parsed.$type, 3);
  assertEq(parsed.__v[0], '638781534000000000');
});

test('does not transform regular object with $type', () => {
  // This has $type but followed by regular key-value pairs (no bare values)
  const input = '{"$type": "56|ContextCross.States.FlightPlanState, GroundATC.Core", "Registration": "B-1234"}';
  const result = _fixTypedValues(input);
  const parsed = JSON.parse(result);
  assertEq(parsed.$type, '56|ContextCross.States.FlightPlanState, GroundATC.Core');
  assertEq(parsed.Registration, 'B-1234');
  assert(parsed.__v === undefined, 'should NOT have __v for regular object');
});

test('handles negative int64 ticks', () => {
  const input = '{"LandingTime": {"$type": 3, -1234567890123456789}}';
  const result = _fixTypedValues(input);
  const parsed = JSON.parse(result);
  assertEq(parsed.LandingTime.__v[0], '-1234567890123456789');
});

// ── Full pre-processor integration ────────────────────────────────

console.log('\n--- Full Pre-processor ---');

test('preprocesses a complete FlightPlan entry', () => {
  const input = `{
  "$k": "abc-123",
  "$v": {
    "$id": 1,
    "$type": "37|ContextCross.States.FlightPlanState, GroundATC.Core",
    "Registration": "B-1234",
    "AircraftType": "A320",
    "DepartureLeg": {
      "$id": 2,
      "$type": "57|ContextCross.States.DepartureLeg, GroundATC.Core",
      "OffBlockTime": {"$type": 3, 638781534000000000},
      "TakeoffTime": {"$type": 3, 638781540000000000}
    }
  }
}`;
  const result = preprocessUnityJson(input);
  const parsed = JSON.parse(result);

  assertEq(parsed.$k, 'abc-123');
  assertEq(parsed.$v.Registration, 'B-1234');
  assertEq(parsed.$v.DepartureLeg.OffBlockTime.__v[0], '638781534000000000');
  assertEq(parsed.$v.DepartureLeg.TakeoffTime.__v[0], '638781540000000000');
});

test('preprocesses Config-like data with trailing commas and NaN', () => {
  const input = '{"startTime": "06:00:00", "endTime": "18:00:00", "extra": NaN,}';
  const result = preprocessUnityJson(input);
  const parsed = JSON.parse(result);
  assertEq(parsed.startTime, '06:00:00');
  assertEq(parsed.endTime, '18:00:00');
  assertEq(parsed.extra, 0);
});

test('handles string values that contain $type-like text', () => {
  const input = '{"description": "the $type is important", "real": {"$type": 3, 12345}}';
  const result = preprocessUnityJson(input);
  const parsed = JSON.parse(result);
  assertEq(parsed.description, 'the $type is important');
  assertEq(parsed.real.__v[0], 12345);
});

// ── Serializer ────────────────────────────────────────────────────

console.log('\n--- Serializer ---');

test('serializes simple object', () => {
  const obj = { name: 'test', value: 42 };
  const result = serializeUnityJson(obj);
  const parsed = JSON.parse(preprocessUnityJson(result));
  assertEq(parsed.name, 'test');
  assertEq(parsed.value, 42);
});

test('serializes object with __v (DateTime pattern)', () => {
  const obj = { $type: 3, __v: ['638781534000000000'] };
  const result = serializeUnityJson(obj);
  // Should output bare value: {"$type": 3, 638781534000000000}
  assert(result.includes('638781534000000000'), 'should contain unquoted ticks');
  assert(!result.includes('"__v"'), 'should NOT contain __v key');
  assert(!result.includes('"638781534000000000"'), 'should NOT quote the int64');
});

test('serializes object with __v (Vector3 pattern)', () => {
  const obj = {
    $type: '16|UnityEngine.Vector3, UnityEngine.CoreModule',
    __v: [10.5, 0, 20.3],
  };
  const result = serializeUnityJson(obj);
  assert(result.includes('10.5'), 'should contain x value');
  assert(result.includes('20.3'), 'should contain z value');
  assert(!result.includes('"__v"'), 'should NOT contain __v key');
  // Should be parseable after pre-processing
  const reparsed = JSON.parse(preprocessUnityJson(result));
  assertEq(reparsed.__v[0], 10.5);
});

test('serializer round-trip: DateTime', () => {
  const input = '{"time": {"$type": 3, 638781534000000000}}';
  const cleaned = preprocessUnityJson(input);
  const parsed = JSON.parse(cleaned);
  const serialized = serializeUnityJson(parsed);
  const roundTripped = JSON.parse(preprocessUnityJson(serialized));
  assertEq(roundTripped.time.__v[0], '638781534000000000');
});

test('serializer round-trip: Vector3', () => {
  const input = '{"pos": {"$type": "16|UnityEngine.Vector3, UnityEngine.CoreModule", 10.5, 0, 20.3}}';
  const cleaned = preprocessUnityJson(input);
  const parsed = JSON.parse(cleaned);
  const serialized = serializeUnityJson(parsed);
  const roundTripped = JSON.parse(preprocessUnityJson(serialized));
  assertEq(roundTripped.pos.__v[0], 10.5);
  assertEq(roundTripped.pos.__v[1], 0);
  assertEq(roundTripped.pos.__v[2], 20.3);
});

test('serializes array with $rcontent', () => {
  const obj = {
    $type: '52|SomeType, Assembly',
    $rlength: 2,
    $rcontent: [
      { $k: 'guid-1', $v: { Registration: 'B-1234' } },
      { $k: 'guid-2', $v: { Registration: 'B-5678' } },
    ],
  };
  const result = serializeUnityJson(obj);
  assert(result.includes('"$rcontent"'), 'should have $rcontent');
  assert(result.includes('"$rlength"'), 'should have $rlength');
  assert(result.includes('"$k"'), 'should have $k entries');
  // Should be parseable
  const reparsed = JSON.parse(preprocessUnityJson(result));
  assertEq(reparsed.$rcontent.length, 2);
});

test('serializer orders $id and $type first', () => {
  const obj = { name: 'test', $type: '37|...', $id: 42, value: 100 };
  const result = serializeUnityJson(obj);
  const idIdx = result.indexOf('"$id"');
  const typeIdx = result.indexOf('"$type"');
  const nameIdx = result.indexOf('"name"');
  assert(idIdx < nameIdx, '$id should come before name');
  assert(typeIdx < nameIdx, '$type should come before name');
});

// ── Summary ───────────────────────────────────────────────────────

console.log('\n=== Results: ' + passed + '/' + (passed + failed) + ' passed ===\n');

if (failed > 0) {
  process.exit(1);
}
