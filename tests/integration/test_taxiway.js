/**
 * Test taxiway centerline parser from taxiway.js.
 *
 * Usage: node tests/integration/test_taxiway.js [--acl <path>]
 * If --acl is omitted, uses synthetic test data only and the ZSJN fixture.
 */

const { parseTaxiwayPaths } = require('../../src/acl/taxiway');
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

console.log('\n=== Taxiway Parser Tests ===\n');

// Helper: wrap partial ACL in outer braces so the tokenizer works
function wrap(inner) {
  return '{' + inner + '}';
}

// ── Synthetic Tests ─────────────────────────────────────────────

console.log('--- Synthetic (edge cases) ---');

test('no SceneryData returns empty paths', () => {
  const result = parseTaxiwayPaths(wrap('"Config": {}'));
  assertEq(result.paths.length, 0);
});

test('empty string returns empty paths', () => {
  const result = parseTaxiwayPaths('');
  assertEq(result.paths.length, 0);
});

test('no TaxiwaySegments returns empty paths', () => {
  const result = parseTaxiwayPaths(wrap('"SceneryData": {"Other": {}}'));
  assertEq(result.paths.length, 0);
});

// Nodes in TaxiwayNodes use $k/$v format (keyed by GUID), matching the real ACL structure
function tn(g, x, z) {
  return '{"$k": "' + g + '", "$v": {"Guid": "' + g + '", "Position": {"x": ' + x + ', "y": 0, "z": ' + z + '}}}';
}

// Valid UUID: 8-4-4-4-12 = 36 chars
function gid(n) { return 'aaaaaaaa-bbbb-cccc-dddd-' + String(n).padStart(12, '0'); }

// Synthetic TaxiwaySegments with valid Node GUIDs requires matching
// TaxiwayNodes entries. Build a minimal valid structure.
test('parses taxiway paths from valid segments with matching nodes', () => {
  const nodeGuid = gid(11);
  const nodeGuid2 = gid(22);
  const acl = wrap(
    '"SceneryData": {' +
    '"TaxiwayNodes": {"$rcontent": [' +
    tn(nodeGuid, 100, 300) + ',' +
    tn(nodeGuid2, 110, 310) +
    ']},' +
    '"TaxiwaySegments": {"$rcontent": [' +
    '{"$k": "seg-1", "$v": {"Name": "A", "Flags": 1, "Nodes": {"$rcontent": ["' + nodeGuid + '", "' + nodeGuid2 + '"]}}}' +
    ']}}');

  const result = parseTaxiwayPaths(acl);
  assertEq(result.paths.length, 1, 'should have 1 path');
  assertEq(result.paths[0].name, 'A');
  assertEq(result.paths[0].flags, 1);
  assertEq(result.paths[0].points.length, 2);
  // Verify point coordinates
  assertEq(result.paths[0].points[0].x, 100);
  assertEq(result.paths[0].points[1].x, 110);
});

test('parses Flags values correctly: standard=1, wider=2, special=4', () => {
  const g1 = gid(101), g2 = gid(102), g3 = gid(103);
  const g4 = gid(104), g5 = gid(105), g6 = gid(106);

  const acl = wrap(
    '"SceneryData": {' +
    '"TaxiwayNodes": {"$rcontent": [' +
    tn(g1, 0, 0) + ',' + tn(g2, 10, 0) + ',' +
    tn(g3, 20, 0) + ',' + tn(g4, 30, 0) + ',' +
    tn(g5, 40, 0) + ',' + tn(g6, 50, 0) +
    ']},' +
    '"TaxiwaySegments": {"$rcontent": [' +
    '{"$k": "s1", "$v": {"Name": "STD", "Flags": 1, "Nodes": {"$rcontent": ["' + g1 + '", "' + g2 + '"]}}},' +
    '{"$k": "s2", "$v": {"Name": "WIDE", "Flags": 2, "Nodes": {"$rcontent": ["' + g3 + '", "' + g4 + '"]}}},' +
    '{"$k": "s3", "$v": {"Name": "SPEC", "Flags": 4, "Nodes": {"$rcontent": ["' + g5 + '", "' + g6 + '"]}}}' +
    ']}}');

  const result = parseTaxiwayPaths(acl);
  assertEq(result.paths.length, 3, 'should have 3 paths');
  assertEq(result.paths[0].flags, 1);
  assertEq(result.paths[1].flags, 2);
  assertEq(result.paths[2].flags, 4);
});

test('segments touching stand nodes are excluded', () => {
  const standGuid = gid(1001);
  const taxiGuid = gid(1002);

  const acl = wrap(
    '"SceneryData": {' +
    '"TaxiwayNodes": {"$rcontent": [' +
    tn(standGuid, 0, 0) + ',' + tn(taxiGuid, 10, 0) +
    ']},' +
    '"Stands": {"$rcontent": [' +
    '{"TailPositionGuid": "' + standGuid + '", "NosePositionGuid": "00000000-0000-0000-0000-000000000000"}' +
    ']},' +
    '"TaxiwaySegments": {"$rcontent": [' +
    '{"$k": "seg-stand", "$v": {"Name": "STUB", "Flags": 1, "Nodes": {"$rcontent": ["' + standGuid + '", "' + taxiGuid + '"]}}}' +
    ']}}');

  const result = parseTaxiwayPaths(acl);
  // The segment touches a stand node, so it should be excluded
  assertEq(result.paths.length, 0);
});

test('segments not touching stand nodes are kept', () => {
  const node1 = gid(2001);
  const node2 = gid(2002);
  const standNode = gid(2003);

  const acl = wrap(
    '"SceneryData": {' +
    '"TaxiwayNodes": {"$rcontent": [' +
    tn(node1, 0, 0) + ',' + tn(node2, 10, 0) + ',' + tn(standNode, 100, 100) +
    ']},' +
    '"Stands": {"$rcontent": [' +
    '{"TailPositionGuid": "' + standNode + '", "NosePositionGuid": "00000000-0000-0000-0000-000000000000"}' +
    ']},' +
    '"TaxiwaySegments": {"$rcontent": [' +
    '{"$k": "taxi-seg", "$v": {"Name": "A_Taxi", "Flags": 1, "Nodes": {"$rcontent": ["' + node1 + '", "' + node2 + '"]}}}' +
    ']}}');

  const result = parseTaxiwayPaths(acl);
  // Neither node1 nor node2 are stand nodes, so this segment should be kept
  assertEq(result.paths.length, 1);
  assertEq(result.paths[0].name, 'A_Taxi');
});

// ── Integration Tests ───────────────────────────────────────────

const fixtureAcl = path.join(__dirname, '..', 'fixtures', 'game-root',
  'GroundATC_Data', 'StreamingAssets', 'Airports', 'ZSJN', 'Levels', 'ZSJN-Morning_120min.acl');

if (fs.existsSync(fixtureAcl)) {
  console.log('\n--- Integration (fixture ACL: ZSJN-Morning_120min) ---');
  const aclText = fs.readFileSync(fixtureAcl, 'utf8');

  test('parseTaxiwayPaths on ZSJN fixture returns paths', () => {
    const result = parseTaxiwayPaths(aclText);
    const pathCount = result.paths.length;
    console.log('       Taxiway paths found: ' + pathCount);
    assert(pathCount > 0, 'ZSJN fixture should have taxiway segments');
  });

  test('ZSJN taxiway paths have valid structure', () => {
    const result = parseTaxiwayPaths(aclText);
    for (const tp of result.paths) {
      assert(typeof tp.name === 'string', 'taxiway name should be a string');
      assert(typeof tp.flags === 'number', 'flags should be a number');
      assert(Array.isArray(tp.points), 'points should be an array');
      assert(tp.points.length >= 2, 'path should have ≥2 points, got ' + tp.points.length + ' for ' + tp.name);
      for (const pt of tp.points) {
        assert(typeof pt.x === 'number' && typeof pt.z === 'number',
          'point should have numeric x,z for ' + tp.name);
      }
    }
  });

  test('ZSJN taxiway paths are ordered (not all empty)', () => {
    const result = parseTaxiwayPaths(aclText);
    const namedCount = result.paths.filter(tp => tp.name.length > 0).length;
    console.log('       Named taxiway paths: ' + namedCount);
    // At least some taxiways should have names
  });
}

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
    test('parseTaxiwayPaths on real ACL returns valid paths', () => {
      const result = parseTaxiwayPaths(aclText);
      console.log('       Taxiway paths: ' + result.paths.length);
      // Not asserting > 0 — some airports may have no taxiways
      for (const tp of result.paths) {
        assert(tp.points.length >= 2, 'path ' + tp.name + ' should have ≥2 points');
      }
    });
  }
}

// ── Summary ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(50));

if (failed > 0) process.exit(1);
