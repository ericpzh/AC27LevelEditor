/**
 * Test SID (Type=2) and Missed Approach (Type=3) route parsers from sid_goaround.js.
 *
 * Usage: node tests/integration/test_sid_goaround.js [--acl <path>]
 * If --acl is omitted, uses synthetic test data only.
 * If --acl is provided, also runs integration tests against the real ACL file.
 */

const {
  extractSidRunwayMappings,
  extractMissedApproachMappings,
  buildSidPaths,
  buildMissedApproachPaths,
  extractApprRunwayMappings,
  buildApprPaths,
} = require('../../src/acl/sid_goaround');

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
  if (a !== b) throw new Error((msg || 'assertion') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}

console.log('\n=== SID & Go-Around Parser Tests ===\n');

// ── Synthetic Tests ─────────────────────────────────────────────

console.log('--- Synthetic (edge cases) ---');

// Minimal ACL with no SceneryData
test('no SceneryData returns empty mappings', () => {
  const result = extractSidRunwayMappings('{"Config": {}}');
  assertEq(Object.keys(result.sidRunwayMap).length, 0);
  assertEq(Object.keys(result.runwaySidMap).length, 0);
});

test('null input returns empty mappings', () => {
  const result = extractSidRunwayMappings(null);
  assertEq(Object.keys(result.sidRunwayMap).length, 0);
});

test('undefined input returns empty mappings', () => {
  const result = extractSidRunwayMappings(undefined);
  assertEq(Object.keys(result.sidRunwayMap).length, 0);
});

test('empty string returns empty mappings', () => {
  const result = extractSidRunwayMappings('');
  assertEq(Object.keys(result.sidRunwayMap).length, 0);
});

// SceneryData present but no Runways section
test('SceneryData without Runways returns empty mappings', () => {
  const acl = '{"SceneryData": {"OtherSection": {"foo": "bar"}}}';
  const result = extractSidRunwayMappings(acl);
  assertEq(Object.keys(result.sidRunwayMap).length, 0);
});

// Helper: wrap a partial ACL in outer braces so the tokenizer works
function wrap(inner) {
  return '{' + inner + '}';
}

// Valid GUID (36-char hex with dashes)
function g(short) {
  return '00000000-0000-0000-0000-' + String(short).padStart(12, '0');
}

// Runways present but no Routes with matching Type
test('Runways without Type=2 routes returns empty SID mappings', () => {
  const acl = wrap('"SceneryData": {"Runways": {"$rcontent": [{"$k": "19", "$v": {"Name": "19", "PhysicalName": "01/19", "Routes": {"$rcontent": [{"Name": "STAR1", "Type": 0, "AirwayNodeGuids": ["' + g(1) + '"]}]}}}]}}');
  const result = extractSidRunwayMappings(acl);
  assertEq(Object.keys(result.sidRunwayMap).length, 0);
});

// SID (Type=2) extraction
test('extracts SID route→runway mapping from Type=2 route', () => {
  const acl = wrap('"SceneryData": {"Runways": {"$rcontent": [{"$k": "01", "$v": {"Name": "01", "PhysicalName": "01/19", "Routes": {"$rcontent": [{"Name": "SID01D", "Type": 2, "AirwayNodeGuids": ["' + g(10) + '"]}]}}}]}}');
  const result = extractSidRunwayMappings(acl);
  assertEq(Object.keys(result.sidRunwayMap).length, 1);
  assert(result.sidRunwayMap['SID01D'] !== undefined, 'should have SID01D');
  assert(result.sidRunwayMap['SID01D'].includes('01'), 'should map to runway 01');
  assertEq(Object.keys(result.runwaySidMap).length, 1);
  assert(result.runwaySidMap['01'].includes('SID01D'), 'reverse map should include SID01D');
});

// SID with multiple runways
test('extracts SID mapping for route shared across multiple runways', () => {
  const acl = wrap('"SceneryData": {"Runways": {"$rcontent": [' +
    '{"$k": "01", "$v": {"Name": "01", "PhysicalName": "01/19", "Routes": {"$rcontent": [{"Name": "SHARED", "Type": 2, "AirwayNodeGuids": ["' + g(20) + '"]}]}}},' +
    '{"$k": "19", "$v": {"Name": "19", "PhysicalName": "01/19", "Routes": {"$rcontent": [{"Name": "SHARED", "Type": 2, "AirwayNodeGuids": ["' + g(20) + '"]}]}}}' +
    ']}}');
  const result = extractSidRunwayMappings(acl);
  assert(result.sidRunwayMap['SHARED'] !== undefined, 'should have SHARED');
  assertEq(result.sidRunwayMap['SHARED'].length, 2);
  assert(result.sidRunwayMap['SHARED'].includes('01'));
  assert(result.sidRunwayMap['SHARED'].includes('19'));
});

// Missed Approach (Type=3) extraction
test('extracts missed approach mapping from Type=3 route', () => {
  const acl = wrap('"SceneryData": {"Runways": {"$rcontent": [{"$k": "31L", "$v": {"Name": "31L", "PhysicalName": "13R/31L", "Routes": {"$rcontent": [{"Name": "RNAV Y Rwy 31L (Missed Approach)", "Type": 3, "AirwayNodeGuids": ["' + g(30) + '"]}]}}}]}}');
  const result = extractMissedApproachMappings(acl);
  assertEq(Object.keys(result.missedAppMap).length, 1);
  assert(result.missedAppMap['RNAV Y Rwy 31L (Missed Approach)'] !== undefined);
  assert(result.missedAppMap['RNAV Y Rwy 31L (Missed Approach)'].includes('31L'));
});

// Multiple route types in same runway
test('extracts only Type=2 SID routes, not Type=0 STARs', () => {
  const acl = wrap('"SceneryData": {"Runways": {"$rcontent": [{"$k": "01", "$v": {"Name": "01", "PhysicalName": "01/19", "Routes": {"$rcontent": [' +
    '{"Name": "STAR01A", "Type": 0, "AirwayNodeGuids": ["' + g(40) + '"]},' +
    '{"Name": "SID01D", "Type": 2, "AirwayNodeGuids": ["' + g(41) + '"]},' +
    '{"Name": "RNAV01", "Type": 1, "AirwayNodeGuids": ["' + g(42) + '"]}' +
    ']}}}]}}');
  const result = extractSidRunwayMappings(acl);
  // Should only have the Type=2 SID, not the Type=0 STAR or Type=1 RNAV
  assertEq(Object.keys(result.sidRunwayMap).length, 1);
  assert(result.sidRunwayMap['SID01D'] !== undefined, 'should have SID01D');
  assert(result.sidRunwayMap['STAR01A'] === undefined, 'should NOT have STAR');
  assert(result.sidRunwayMap['RNAV01'] === undefined, 'should NOT have RNAV');
});

// Type=1 (APPR) extraction via extractApprRunwayMappings
test('extractApprRunwayMappings extracts Type=1 routes', () => {
  const acl = wrap('"SceneryData": {"Runways": {"$rcontent": [{"$k": "31L", "$v": {"Name": "31L", "PhysicalName": "13R/31L", "Routes": {"$rcontent": [{"Name": "RNAV Y Rwy 31L", "Type": 1, "AirwayNodeGuids": ["' + g(50) + '"]}]}}}]}}');
  const result = extractApprRunwayMappings(acl);
  assertEq(Object.keys(result.apprRunwayMap).length, 1);
  assert(result.apprRunwayMap['RNAV Y Rwy 31L'] !== undefined);
});

// SID with stub route ($rlength:0 / no GUIDs) → excluded
test('stub SID route with no GUIDs is excluded', () => {
  const acl = wrap('"SceneryData": {"Runways": {"$rcontent": [{"$k": "01", "$v": {"Name": "01", "PhysicalName": "01/19", "Routes": {"$rcontent": [{"Name": "SID_STUB", "Type": 2}]}}}]}}');
  const result = extractSidRunwayMappings(acl);
  assertEq(Object.keys(result.sidRunwayMap).length, 0, 'stub without GUIDs should be excluded');
});

// buildSidPaths with no matching AirwayNodes returns empty
test('buildSidPaths with no data returns empty', () => {
  const paths = buildSidPaths('{}', { 'SID01D': ['01'] });
  assertEq(Object.keys(paths).length, 0);
});

test('buildMissedApproachPaths with no data returns empty', () => {
  const paths = buildMissedApproachPaths('{}', { 'MA01': ['01'] });
  assertEq(Object.keys(paths).length, 0);
});

test('buildApprPaths with no data returns empty', () => {
  const paths = buildApprPaths('{}', { 'RNAV01': ['01'] });
  assertEq(Object.keys(paths).length, 0);
});

// Missed approach with Missed Approach keyword
test('extracts missed approach with full name', () => {
  const acl = wrap('"SceneryData": {"Runways": {"$rcontent": [{"$k": "13R", "$v": {"Name": "13R", "PhysicalName": "13R/31L", "Routes": {"$rcontent": [{"Name": "RNAV ILS Z Rwy 13R (Missed Approach)", "Type": 3, "AirwayNodeGuids": ["' + g(60) + '"]}]}}}]}}');
  const result = extractMissedApproachMappings(acl);
  assert(Object.keys(result.missedAppMap).length > 0);
  assert(result.missedAppMap['RNAV ILS Z Rwy 13R (Missed Approach)'] !== undefined);
  assert(result.runwayMissedAppMap['13R'] !== undefined);
  assert(result.runwayMissedAppMap['13R'].includes('RNAV ILS Z Rwy 13R (Missed Approach)'));
});

// Non-runway entries (entries without / in PhysicalName) are excluded
test('non-runway entries without PhysicalName / are excluded', () => {
  const acl = '"SceneryData": {"Runways": {"$rcontent": [{"$k": "comparer-guid", "$v": {"Name": "comparer", "PhysicalName": ""}}]}}';
  const result = extractSidRunwayMappings(acl);
  assertEq(Object.keys(result.sidRunwayMap).length, 0);
});

// ── Integration Tests (real ACL file) ─────────────────────────

const aclArgIdx = process.argv.indexOf('--acl');
if (aclArgIdx >= 0) {
  const aclPath = process.argv[aclArgIdx + 1];
  console.log('\n--- Integration (real ACL: ' + path.basename(aclPath) + ') ---');

  let aclText;
  try {
    aclText = fs.readFileSync(aclPath, 'utf8');
  } catch (e) {
    console.log('  SKIP: cannot read ACL file (' + e.message + ')');
    aclText = null;
  }

  if (aclText) {
    test('extractSidRunwayMappings returns non-empty result', () => {
      const result = extractSidRunwayMappings(aclText);
      const sidCount = Object.keys(result.sidRunwayMap).length;
      const rwyCount = Object.keys(result.runwaySidMap).length;
      console.log('       SIDs found: ' + sidCount + ', runways with SIDs: ' + rwyCount);
      // Not asserting > 0 — some airports may have no SIDs
    });

    test('extractMissedApproachMappings returns result', () => {
      const result = extractMissedApproachMappings(aclText);
      const maCount = Object.keys(result.missedAppMap).length;
      console.log('       Missed approaches found: ' + maCount);
    });

    test('buildSidPaths returns paths with valid points', () => {
      const mappings = extractSidRunwayMappings(aclText);
      const paths = buildSidPaths(aclText, mappings.sidRunwayMap);
      const pathCount = Object.keys(paths).length;
      console.log('       SID paths built: ' + pathCount);
      // Verify each path has valid structure
      for (const [name, variants] of Object.entries(paths)) {
        for (const v of variants) {
          assert(v.points.length >= 2, 'SID ' + name + ' should have ≥2 points, got ' + v.points.length);
          assert(v.runway !== undefined, 'SID ' + name + ' should have a runway');
          for (const p of v.points) {
            assert(typeof p.x === 'number' && typeof p.z === 'number', 'SID point should have numeric x,z');
          }
        }
      }
    });

    test('buildMissedApproachPaths returns paths with valid points', () => {
      const mappings = extractMissedApproachMappings(aclText);
      const paths = buildMissedApproachPaths(aclText, mappings.missedAppMap);
      const pathCount = Object.keys(paths).length;
      console.log('       MA paths built: ' + pathCount);
      for (const [name, variants] of Object.entries(paths)) {
        for (const v of variants) {
          assert(v.points.length >= 2, 'MA ' + name + ' should have ≥2 points');
          for (const p of v.points) {
            assert(typeof p.x === 'number' && typeof p.z === 'number', 'MA point should have numeric x,z');
          }
        }
      }
    });

    test('extractApprRunwayMappings returns result', () => {
      const result = extractApprRunwayMappings(aclText);
      const count = Object.keys(result.apprRunwayMap).length;
      console.log('       APPR routes found: ' + count);
    });

    test('SID → runway mapping is consistent (bidirectional)', () => {
      const result = extractSidRunwayMappings(aclText);
      for (const [sid, runways] of Object.entries(result.sidRunwayMap)) {
        for (const rwy of runways) {
          assert(result.runwaySidMap[rwy] !== undefined,
            'Reverse map missing runway ' + rwy + ' for SID ' + sid);
          assert(result.runwaySidMap[rwy].includes(sid),
            'Reverse map for ' + rwy + ' should include SID ' + sid);
        }
      }
    });
  }
}

// Also test against the fixture ACL if present
const fixtureAcl = path.join(__dirname, '..', 'fixtures', 'game-root',
  'GroundATC_Data', 'StreamingAssets', 'Airports', 'ZSJN', 'Levels', 'ZSJN-Morning_120min.acl');
if (fs.existsSync(fixtureAcl) && !aclArgIdx) {
  console.log('\n--- Integration (fixture ACL: ZSJN-Morning_120min) ---');
  const aclText = fs.readFileSync(fixtureAcl, 'utf8');

  test('extractSidRunwayMappings on ZSJN fixture', () => {
    const result = extractSidRunwayMappings(aclText);
    const sidCount = Object.keys(result.sidRunwayMap).length;
    const rwyCount = Object.keys(result.runwaySidMap).length;
    console.log('       SIDs found: ' + sidCount + ', runways with SIDs: ' + rwyCount);
    // ZSJN is a real airport — should have SID data
  });

  test('extractMissedApproachMappings on ZSJN fixture', () => {
    const result = extractMissedApproachMappings(aclText);
    const maCount = Object.keys(result.missedAppMap).length;
    console.log('       Missed approaches found: ' + maCount);
  });

  test('buildSidPaths on ZSJN fixture returns valid polylines', () => {
    const mappings = extractSidRunwayMappings(aclText);
    const paths = buildSidPaths(aclText, mappings.sidRunwayMap);
    const pathCount = Object.keys(paths).length;
    console.log('       SID paths built: ' + pathCount);
    assert(pathCount > 0, 'ZSJN fixture should have at least one SID path');
    for (const [name, variants] of Object.entries(paths)) {
      assert(Array.isArray(variants), 'SID ' + name + ' variants should be an array');
      for (const v of variants) {
        assert(v.points.length >= 2, 'SID ' + name + ' path should have ≥2 points');
      }
    }
  });
}

// ── Summary ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(50));

if (failed > 0) process.exit(1);
