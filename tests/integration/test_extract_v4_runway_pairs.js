/**
 * Test extractV4RunwayPairs — v4 runway pair extraction from static SceneryData.
 *
 * Each v4 runway object (e.g. "$k": "runway:01") carries a PhysicalName like
 * "01/19"; the two runway objects sharing a PhysicalName form a reciprocal
 * pair (01|19 and 19|01). This replaces timeline-change scanning for v4,
 * which found nothing on airports that never defined runway changes
 * (KJFK, KDCA) and hid the runway change editor.
 *
 * Usage:
 *   node tests/integration/test_extract_v4_runway_pairs.js [--root <game-root>]
 *
 * The ZSJN fixture case runs offline; KJFK/KDCA cases require the game root
 * (default: the Airport Control 25 Playtest dir next to this repo) and are
 * skipped gracefully when the files are missing.
 */

const fs = require('fs');
const path = require('path');
const parser = require('../../src/acl/parser');
const { readAclText } = require('../../src/acl/gatcarc');

const { extractV4RunwayPairs } = parser;

// ── CLI ──────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--root' && i + 1 < process.argv.length) args.root = path.resolve(process.argv[++i]);
  if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node tests/integration/test_extract_v4_runway_pairs.js [--root <game-root>]');
    process.exit(0);
  }
}

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'game-root', 'GroundATC_Data', 'StreamingAssets', 'Airports');
const gameRoot = args.root || path.resolve(__dirname, '..', '..', '..');
const gameAirportsDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports');

// ── Helpers ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

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
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || '') + '\n    expected: ' + JSON.stringify(b) + '\n    got:      ' + JSON.stringify(a));
  }
}

function pairKey(p) { return p.source + '|' + p.dest; }

function findLevelFile(airportsDir, icao, name) {
  const p = path.join(airportsDir, icao, 'Levels', name);
  if (fs.existsSync(p)) return p;
  return null;
}

console.log('\n=== extractV4RunwayPairs Tests ===\n');

// ── T1: ZSJN v4 fixture (offline) ────────────────────────────────

test('T1: ZSJN v4 fixture extracts 01/19 reciprocal pair', () => {
  const aclPath = findLevelFile(FIXTURE_DIR, 'ZSJN', 'ZSJN_leisure_1.acl');
  assert(aclPath, 'fixture ZSJN_leisure_1.acl not found');
  const text = readAclText(aclPath);
  assert(text.includes('StaticData'), 'fixture must be v4 (StaticData present)');
  const pairs = extractV4RunwayPairs(text);
  assertEq(pairs.map(pairKey), ['01|19', '19|01'], 'ZSJN runway pairs');
});

// ── T2: KJFK (game root) ─────────────────────────────────────────

const kjfkPath = findLevelFile(gameAirportsDir, 'KJFK', 'KJFK_runwaychange.acl');
if (kjfkPath) {
  test('T2: KJFK extracts 4 physical-runway groups (8 reciprocal pairs)', () => {
    const text = readAclText(kjfkPath);
    assert(text.includes('StaticData'), 'KJFK_09-11.acl must be v4 (StaticData present)');
    const pairs = extractV4RunwayPairs(text);
    assertEq(pairs.length, 8, 'KJFK must produce 8 pairs (4 groups × 2 directions)');
    const keys = new Set(pairs.map(pairKey));
    for (const k of ['4L|22R', '22R|4L', '13R|31L', '31L|13R', '4R|22L', '22L|4R', '13L|31R', '31R|13L']) {
      assert(keys.has(k), 'missing KJFK pair ' + k);
    }
  });
} else {
  skipped++;
  console.log('  SKIP: T2 KJFK — game root not found at ' + path.join(gameAirportsDir, 'KJFK'));
}

// ── T3: KDCA (game root) ─────────────────────────────────────────

const kdcaPath = findLevelFile(gameAirportsDir, 'KDCA', 'KDCA_Endless.acl');
if (kdcaPath) {
  test('T3: KDCA extracts 3 physical-runway groups (6 reciprocal pairs)', () => {
    const text = readAclText(kdcaPath);
    assert(text.includes('StaticData'), 'KDCA_Endless.acl must be v4 (StaticData present)');
    const pairs = extractV4RunwayPairs(text);
    assertEq(pairs.length, 6, 'KDCA must produce 6 pairs (3 groups × 2 directions)');
    const keys = new Set(pairs.map(pairKey));
    for (const k of ['01|19', '19|01', '04|22', '22|04', '15|33', '33|15']) {
      assert(keys.has(k), 'missing KDCA pair ' + k);
    }
  });
} else {
  skipped++;
  console.log('  SKIP: T3 KDCA — game root not found at ' + path.join(gameAirportsDir, 'KDCA'));
}

// ── T4: empty/garbage input ──────────────────────────────────────

test('T4: empty/garbage input returns empty array', () => {
  assertEq(extractV4RunwayPairs(''), [], 'empty string');
  assertEq(extractV4RunwayPairs('{ "StaticData": { "$blobdoc": {} } }'), [], 'blobdoc without PK entities');
});

// ── T5: dedup — shared PhysicalName yields exactly 2 pairs ───────

test('T5: both ends of a physical runway are deduplicated into exactly 2 pairs', () => {
  const aclPath = findLevelFile(FIXTURE_DIR, 'ZSJN', 'ZSJN_leisure_1.acl');
  assert(aclPath, 'fixture ZSJN_leisure_1.acl not found');
  const text = readAclText(aclPath);
  const pairs = extractV4RunwayPairs(text);
  // No duplicate source|dest entries even though "runway:01" AND "runway:19"
  // both declare PhysicalName "01/19"
  assertEq(pairs.length, new Set(pairs.map(pairKey)).size, 'no duplicate pairs');
  assertEq(pairs.length, 2, 'exactly one physical runway group in ZSJN');
});

// ── Summary ──────────────────────────────────────────────────────

console.log('\n' + (failed === 0
  ? '✓ ALL ' + passed + ' TESTS PASSED' + (skipped ? ' (' + skipped + ' skipped)' : '')
  : '✗ ' + failed + ' TEST(S) FAILED'));
process.exit(failed === 0 ? 0 : 1);
