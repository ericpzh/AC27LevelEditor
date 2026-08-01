/**
 * Test: Save Roundtrip Diff Verification
 *
 * Validates the three fixes applied to the ACL save pipeline:
 *   Issue 1: RunwayTakeOffLength=0 preserved; missing values assert via
 *            requireSpecField (refusing fallback 2000) — no silent defaulting
 *   Issue 2: ModelOffset float3 uses tuple format (no named x/y/z keys)
 *   Issue 3: Empty string[] arrays use $iref sharing
 *
 * Usage: node tests/integration/test_save_roundtrip_diff.js [--acl <path>]
 *
 * Without --acl, runs unit tests on the builder/extractor functions.
 * With --acl, also runs full roundtrip against the specified file.
 */

const fs = require('fs');
const path = require('path');
const { readAclText, decodeArchive, encodeArchive } = require('../../src/acl/gatcarc');
const {
  extractSpecificationDB,
  buildApproachAircraftBlock,
  buildState5AircraftBlock,
} = require('../../src/acl/approach');

let PASS = 0, FAIL = 0;

function assert(cond, msg) {
  if (cond) { console.log('  \x1b[32m✓\x1b[0m ' + msg); PASS++; }
  else { console.log('  \x1b[31m✗ FAIL:\x1b[0m ' + msg); FAIL++; }
}

function assertEqual(actual, expected, msg) {
  const ok = actual === expected;
  if (ok) { console.log('  \x1b[32m✓\x1b[0m ' + msg + ` (${actual})`); PASS++; }
  else { console.log(`  \x1b[31m✗ FAIL:\x1b[0m ${msg} — expected ${expected}, got ${actual}`); FAIL++; }
}

// ═══════════════════════════════════════════════════════════════════
// T1: RunwayTakeOffLength — ?? fallback preserves 0, uses default for null
// ═══════════════════════════════════════════════════════════════════
console.log('═══ T1: RunwayTakeOffLength nullish coalescing ═══');

{
  // Test: RunwayTakeOffLength=0 MUST be preserved (not overridden to 2000)
  // Build a minimal ACL text containing Specification entries
  // Note: $k must be a GUID (hex digits + hyphens) for the regex in _parseAircraftEntries
  // Every other field is required — extractSpecificationDB asserts via
  // requireSpecField instead of silently defaulting (AerodromeCode fix).
  const specText = [
    '{',
    '  "WorldState": {',
    '    "Aircrafts": {',
    '      "$rcontent": [',
    '        {',
    '          "$k": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",',
    '          "$v": {',
    '            "Specification": {',
    '              "Designator": "TEST",',
    '              "AerodromeCode": 67,',
    '              "WakeTurbulenceCategory": 77,',
    '              "WheelBase": 0.123,',
    '              "WingSpan": 0.3492,',
    '              "RunwayVRSpeed": 140,',
    '              "RunwayTakeOffLength": 0,',
    '              "ModelOffset": { "x": 0.19, "y": -0.05, "z": -0.2 }',
    '            }',
    '          }',
    '        }',
    '      ]',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const db = extractSpecificationDB(specText);
  const spec = db.get('TEST');
  assert(spec !== undefined, 'Spec extracted for RunwayTakeOffLength=0 case');
  if (spec) {
    assertEqual(spec.RunwayTakeOffLength, 0, 'RunwayTakeOffLength=0 preserved (not 2000)');
  }
}

{
  // Test: Missing RunwayTakeOffLength asserts (refuses fallback 2000)
  // (all other required fields present; only RunwayTakeOffLength is absent)
  const specText = [
    '{',
    '  "WorldState": {',
    '    "Aircrafts": {',
    '      "$rcontent": [',
    '        {',
    '          "$k": "b2c3d4e5-f6a7-8901-bcde-f12345678901",',
    '          "$v": {',
    '            "Specification": {',
    '              "Designator": "TEST2",',
    '              "AerodromeCode": 67,',
    '              "WakeTurbulenceCategory": 77,',
    '              "WheelBase": 0.123,',
    '              "WingSpan": 0.3492,',
    '              "RunwayVRSpeed": 140,',
    '              "ModelOffset": { "x": 0.19, "y": -0.05, "z": -0.2 }',
    '            }',
    '          }',
    '        }',
    '      ]',
    '    }',
    '  }',
    '}',
  ].join('\n');
  let threw = false;
  try {
    extractSpecificationDB(specText);
  } catch (e) {
    threw = true;
    assert(e.message.includes('refusing fallback 2000'), 'Assert message names refused fallback 2000');
    assert(e.message.includes('TEST2'), 'Assert message names the designator');
  }
  assert(threw, 'Missing RunwayTakeOffLength asserts instead of defaulting to 2000');
}

// ═══════════════════════════════════════════════════════════════════
// T2: ModelOffset float3 uses tuple format (no named x/y/z)
// ═══════════════════════════════════════════════════════════════════
console.log('\n═══ T2: ModelOffset float3 tuple format ═══');

function buildMinimalApproachAircraft() {
  return buildApproachAircraftBlock({
    flightPlanGuid: '00000000-0000-0000-0000-000000000001',
    route: 'TEST',
    flyPoints: [],
    appPoints: [{ x: 0, y: 0, z: 0 }],
    progressRatio: 0,
    spec: {
      Designator: 'TEST',
      RunwayTakeOffLength: 1350,
      RunwayVRSpeed: 140,
      ModelOffset: { x: 0.1971, y: -0.0554, z: -0.1957 },
      WingSpan: 0.3484,
      WheelBase: 0.1566,
      AerodromeCode: 67,
      WakeTurbulenceCategory: 77,
      DockingPositions: [],
    },
    radioChannelGuid: '00000000-0000-0000-0000-000000000002',
    nextId: 5001,
    // typeNums are required since the per-file typeMap refactor (v4 pipeline).
    // ZSJN values from tests/fixtures/game-root/.../ZSJN-Morning_120min.acl.
    typeNums: {
      acType: 33, spec: 34, float3: 35, vec4Arr: 36, vec4: 37,
      dynInternal: 38, acRwy: 42, waitCmd: 43, recvEvt: 44,
      listVec3: 46, dynParams: 47,
    },
  });
}

{
  const result = buildMinimalApproachAircraft();
  assert(result.block.length > 0, 'buildApproachAircraftBlock produces output');

  // Find the ModelOffset section
  const moMatch = result.block.match(/"ModelOffset":\s*\{([^}]+)\}/s);
  assert(moMatch !== null, 'ModelOffset section found in output');

  if (moMatch) {
    const moContent = moMatch[1];
    // Must NOT have named x/y/z fields
    assert(!moContent.includes('"x"'), 'ModelOffset must NOT use named "x" field');
    assert(!moContent.includes('"y"'), 'ModelOffset must NOT use named "y" field');
    assert(!moContent.includes('"z"'), 'ModelOffset must NOT use named "z" field');
    // Must have the correct values as bare numbers
    assert(moContent.includes('0.1971'), 'ModelOffset contains x value 0.1971');
    assert(moContent.includes('-0.0554'), 'ModelOffset contains y value -0.0554');
    assert(moContent.includes('-0.1957'), 'ModelOffset contains z value -0.1957');
  }
}

// ═══════════════════════════════════════════════════════════════════
// T3: Empty string[] arrays use canonical-$id (inline per-array $id)
// ═══════════════════════════════════════════════════════════════════
console.log('\n═══ T3: Empty string[] canonical-$id design ═══');

// Extract a balanced-brace JSON object by key name
function extractObjectAt(text, key) {
  const start = text.indexOf('"' + key + '"');
  if (start < 0) return null;
  const open = text.indexOf('{', start);
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') d++;
    else if (text[i] === '}') { d--; if (d === 0) return text.substring(open, i + 1); }
  }
  return null;
}

{
  const result = buildMinimalApproachAircraft();

  // Count standalone inline empty string[] definitions ($rlength: 0, $rcontent: [])
  const inlinePattern = /"\$rlength":\s*0,\s*"\$rcontent":\s*\[\s*\]/g;
  const inlineMatches = result.block.match(inlinePattern);
  const inlineCount = inlineMatches ? inlineMatches.length : 0;
  // The block may have multiple empty arrays (DockingPositions, WaitingForCommands, etc.)
  assert(inlineCount >= 1, 'At least one inline empty array definition exists');

  // Canonical-$id design: the 5 AircraftRunwayCoordinateState string[] fields are
  // emitted inline with per-array $id — NO $iref sharing (as of the per-file typeMap refactor)
  const coord = extractObjectAt(result.block, 'AircraftRunwayCoordinateState');
  assert(coord !== null, 'AircraftRunwayCoordinateState object found');

  if (coord) {
    // No $iref references inside the coordinator
    const coordIrefCount = (coord.match(/\$iref:(\d+)/g) || []).length;
    assert(coordIrefCount === 0, `No $iref references in coordinator (got ${coordIrefCount})`);

    // Exactly 6 $id entries: coordinator itself + 5 per-array inline definitions
    const coordIds = [...coord.matchAll(/"\$id":\s*(\d+)/g)].map(m => parseInt(m[1]));
    assert(coordIds.length === 6, `Coordinator has 6 $id entries (coordinator + 5 per-array), got ${coordIds.length}`);

    // All $id values unique — each array has its own canonical id
    assert(new Set(coordIds).size === coordIds.length,
      `All ${coordIds.length} $id values in coordinator are unique (canonical-$id design)`);

    // All 5 runway-coordinator string[] fields present and inline empty
    const coordFields = [
      'TaxiPathUnPassedIntersectionRunwayNames',
      'TaxiBlockingRunwayNames',
      'RunwayFenceCurrentEnterRunways',
      'RunwayGuardCurrentEnterRunways',
      'CrossRunwayPermissions',
    ];
    for (const field of coordFields) {
      assert(coord.includes(`"${field}":`), `Coordinator field ${field} present`);
    }
    const inlineArrCount = (coord.match(/"\$rlength":\s*0,\s*"\$rcontent":\s*\[\s*\]/g) || []).length;
    assert(inlineArrCount === 5, `5 inline empty string[] arrays in coordinator (got ${inlineArrCount})`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// T4: v4 spec extraction (if a v4 .acl file is available)
// ═══════════════════════════════════════════════════════════════════
console.log('\n═══ T4: v4 spec extraction ═══');

// Parse --acl argument
let aclPath = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--acl' && i + 1 < process.argv.length) {
    aclPath = process.argv[i + 1];
  }
}

// Try default workspace test file
if (!aclPath) {
  const defaultPath = path.join(__dirname, '..', '..', '..',
    'GroundATC_Data', 'StreamingAssets', 'Airports', 'ZSJN', 'Levels', 'test', 'works.acl');
  if (fs.existsSync(defaultPath)) aclPath = defaultPath;
}

if (aclPath && fs.existsSync(aclPath)) {
  console.log('  Using: ' + path.basename(aclPath));
  const text = readAclText(aclPath);

  const db = extractSpecificationDB(text);
  assert(db.size > 0, `extractSpecificationDB finds specs (got ${db.size})`);

  let allPositive = true;
  let defaultCount = 0;
  for (const [des, spec] of db) {
    if (spec.RunwayTakeOffLength === 2000 && des !== 'UNKNOWN') {
      // 2000 might be correct for some types, but flag it
      defaultCount++;
    }
    if (spec.RunwayTakeOffLength <= 0 || spec.RunwayTakeOffLength > 5000) {
      allPositive = false;
    }
  }
  assert(allPositive, 'All RunwayTakeOffLength values are in valid range (1-5000)');

  // Verify ModelOffset values are not the default {0.19, -0.05, -0.20} for all
  let nonDefaultMO = 0;
  for (const [des, spec] of db) {
    const mo = spec.ModelOffset;
    if (mo && (Math.abs(mo.x - 0.19) > 0.001 || Math.abs(mo.y + 0.05) > 0.001 || Math.abs(mo.z + 0.20) > 0.001)) {
      nonDefaultMO++;
    }
  }
  assert(nonDefaultMO >= db.size * 0.5, `Majority of ModelOffset values are non-default (${nonDefaultMO}/${db.size})`);
} else {
  console.log('  SKIP: no v4 .acl file available (use --acl <path> to provide one)');
}

// ═══════════════════════════════════════════════════════════════════
console.log(`\n\x1b[1m=== ${PASS} passed, ${FAIL} failed ===\x1b[0m`);
process.exit(FAIL === 0 ? 0 : 1);
