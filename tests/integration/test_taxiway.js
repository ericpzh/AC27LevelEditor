/**
 * Test taxiway centerline parser from taxiway.js.
 *
 * Usage: node tests/integration/test_taxiway.js [--acl <path>]
 * If --acl is omitted, uses synthetic test data only and the ZSJN fixture.
 */

const { parseTaxiwayPaths } = require('../../src/acl/taxiway');
const fs = require('fs');
const path = require('path');
const { readAclText } = require('../../src/acl/gatcarc');

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

// v4 entities live in StaticData.$blobdoc.PKStaticEntities.$rcontent as
// $k/$v entries, referencing each other via $iref → $id.
function pk(entries) {
  return wrap('"StaticData": {"$blobdoc": {"PKStaticEntities": {"$rcontent": [' + entries.join(',') + ']}}}');
}

function tn(id, x, z) {
  return '{"$k": "taxiway-node:' + id + '", "$v": {"$id": ' + id + ', "Position": {"$type": 5, ' + x + ', 0, ' + z + '}}}';
}

function seg(pkName, name, flags, nodeIds) {
  return '{"$k": "taxiway-segment:' + pkName + '", "$v": {"Name": "' + name + '", "Flags": ' + flags +
    ', "Nodes": {"$rcontent": ["$iref:' + nodeIds[0] + '", "$iref:' + nodeIds[1] + '"]}}}';
}

function stand(pkName, id, tailIref, noseIref) {
  // TailPosition/NosePosition are BARE $iref:N in the real v4 format (unquoted)
  return '{"$k": "stand:' + pkName + '", "$v": {"$id": ' + id + ', "TailPosition": $iref:' + tailIref +
    ', "NosePosition": $iref:' + noseIref + '}}';
}

// Synthetic TaxiwaySegments with valid node $irefs requires matching
// taxiway-node entries. Build a minimal valid structure.
test('parses taxiway paths from valid segments with matching nodes', () => {
  const acl = pk([
    tn(11, 100, 300),
    tn(22, 110, 310),
    seg('seg-1', 'A', 1, [11, 22]),
  ]);

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
  const acl = pk([
    tn(101, 0, 0), tn(102, 10, 0),
    tn(103, 20, 0), tn(104, 30, 0),
    tn(105, 40, 0), tn(106, 50, 0),
    seg('s1', 'STD', 1, [101, 102]),
    seg('s2', 'WIDE', 2, [103, 104]),
    seg('s3', 'SPEC', 4, [105, 106]),
  ]);

  const result = parseTaxiwayPaths(acl);
  assertEq(result.paths.length, 3, 'should have 3 paths');
  assertEq(result.paths[0].flags, 1);
  assertEq(result.paths[1].flags, 2);
  assertEq(result.paths[2].flags, 4);
});

test('segments touching stand nodes are marked isStandAccess', () => {
  const acl = pk([
    tn(1001, 0, 0),
    tn(1002, 10, 0),
    stand('300', 31, 1001, 1001),
    seg('seg-stand', 'STUB', 1, [1001, 1002]),
  ]);

  const result = parseTaxiwayPaths(acl);
  // Stand-access segment is included but marked
  assertEq(result.paths.length, 1);
  assertEq(result.paths[0].name, 'STUB');
  assertEq(result.paths[0].points.length, 2);
  assert(result.paths[0].isStandAccess === true, 'stand-access segment should have isStandAccess: true');
});

test('segments not touching stand nodes are kept', () => {
  const acl = pk([
    tn(2001, 0, 0),
    tn(2002, 10, 0),
    tn(2003, 100, 100),
    stand('300', 31, 2003, 2003),
    seg('taxi-seg', 'A_Taxi', 1, [2001, 2002]),
  ]);

  const result = parseTaxiwayPaths(acl);
  // Neither node1 nor node2 are stand nodes — segment is kept, not marked
  assertEq(result.paths.length, 1);
  assertEq(result.paths[0].name, 'A_Taxi');
  assert(!result.paths[0].isStandAccess, 'non-stand segment should not have isStandAccess');
});

// ── Integration Tests (v4 fixture — PKStaticEntities path) ─────

const fixtureV4Acl = path.join(__dirname, '..', 'fixtures', 'game-root',
  'GroundATC_Data', 'StreamingAssets', 'Airports', 'ZSJN', 'Levels', 'ZSJN_leisure_1.acl');

if (fs.existsSync(fixtureV4Acl)) {
  console.log('\n--- Integration (v4 fixture ACL: ZSJN_leisure_1) ---');
  const v4Text = readAclText(fixtureV4Acl);

  test('parseTaxiwayPaths on ZSJN v4 fixture returns paths', () => {
    const result = parseTaxiwayPaths(v4Text);
    const pathCount = result.paths.length;
    console.log('       Taxiway paths found (v4): ' + pathCount);
    assert(pathCount > 0, 'v4 fixture should have taxiway segments');
  });

  test('ZSJN v4 taxiway paths have valid structure', () => {
    const result = parseTaxiwayPaths(v4Text);
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

  test('ZSJN v4 taxiway paths mark stand-access segments', () => {
    const result = parseTaxiwayPaths(v4Text);
    const standAccessCount = result.paths.filter(tp => tp.isStandAccess === true).length;
    console.log('       Stand-access segments (v4): ' + standAccessCount);
    assert(standAccessCount > 0, 'v4 fixture should have stand-access segments');
  });
}

const aclArgIdx = process.argv.indexOf('--acl');
if (aclArgIdx >= 0) {
  const aclPath = process.argv[aclArgIdx + 1];
  console.log('\n--- Integration (real ACL: ' + path.basename(aclPath) + ') ---');

  let aclText;
  try {
    aclText = readAclText(aclPath);
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
