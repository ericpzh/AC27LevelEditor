/**
 * Diagnostic test: JFK5.JFK STAR parsing against real KJFK v4 data.
 *
 * Usage: node tests/integration/test_real_kjfk_jfk5.js
 *
 * Verifies that per-runway STAR resolution is correct for JFK5.JFK in
 * KJFK_09-11.demo.acl.json (v4 format).
 */

const {
  extractStarRunwayMappings,
  resolveFlyApproachPoints,
  buildStarPaths,
} = require('../../src/acl/approach');
const {
  extractSidRunwayMappings,
  buildSidPaths,
  extractApprRunwayMappings,
  buildApprPaths,
} = require('../../src/acl/sid_goaround');
const { readAclText } = require('../../src/acl/gatcarc');
const { detectSchemaVersion } = require('../../src/acl/parser');

const KJFK_FILE = 'D:/SteamLibrary/steamapps/common/Airport Control 25 Playtest/GroundATC_Data/StreamingAssets/Airports/KJFK/Levels/KJFK_09-11.demo.acl';

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

function assertEquals(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '') + ' expected ' + expected + ', got ' + actual);
  }
}

// ── Load the real KJFK data ──────────────────────────────────────

console.log('Loading KJFK v4 data...');
let aclText;
try {
  aclText = readAclText(KJFK_FILE);
} catch (e) {
  console.error('FAIL: Cannot read KJFK file:', e.message);
  console.error('Is the file present at:', KJFK_FILE, '?');
  process.exit(1);
}

const isV4 = detectSchemaVersion(aclText) === 4;
console.log('Schema detected:', isV4 ? 'v4' : 'v2/v3');
if (!isV4) {
  console.log('NOTE: File is v2/v3 — tests will validate v2/v3 path');
}

console.log('');

// ── 1. extractStarRunwayMappings ─────────────────────────────────

test('extractStarRunwayMappings: SIE.CAMRM5 maps to 3 runways', () => {
  const { starRunwayMap } = extractStarRunwayMappings(aclText, isV4);
  const runways = starRunwayMap['SIE.CAMRM5'];
  assert(runways, 'SIE.CAMRM5 not found in starRunwayMap');
  assertEquals(runways.length, 3,
    'expected 3 runways, got ' + runways.length + ': ' + runways.join(','));
  // Verify specific runways (SIE.CAMRM5 is a STAR on these arrival runways)
  const expected = ['4L', '4R', '13L'];
  for (const rwy of expected) {
    assert(runways.includes(rwy), 'missing runway ' + rwy + ' in SIE.CAMRM5 mapping');
  }
});

// ── 2. resolveFlyApproachPoints per runway ───────────────────────

// SIE.CAMRM5 has 6 AirwayNodes on each of its 3 runways
const expectedNodeCounts = {
  '4L': 6,
  '4R': 6,
  '13L': 6,
};

for (const [runway, expected] of Object.entries(expectedNodeCounts)) {
  test('resolveFlyApproachPoints: SIE.CAMRM5 @ ' + runway + ' → ' + expected + ' points', () => {
    const points = resolveFlyApproachPoints(aclText, 'SIE.CAMRM5', runway, isV4);
    assertEquals(points.length, expected,
      'expected ' + expected + ' points for runway ' + runway + ', got ' + points.length);
    // Verify points have valid x,y,z
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      assert(typeof p.x === 'number' && !isNaN(p.x),
        'point ' + i + ' has invalid x: ' + p.x);
      assert(typeof p.z === 'number' && !isNaN(p.z),
        'point ' + i + ' has invalid z: ' + p.z);
    }
  });
}

// ── 3. JFK5.JFK IS in SID data (RouteType=2 = SID) ───────────────

test('extractSidRunwayMappings: JFK5.JFK is in SID data', () => {
  const { sidRunwayMap } = extractSidRunwayMappings(aclText, isV4);
  assert(sidRunwayMap['JFK5.JFK'],
    'JFK5.JFK should be in SID mappings (it has RouteType=2)');
});

test('buildSidPaths: JFK5.JFK is in SID paths', () => {
  const { sidRunwayMap } = extractSidRunwayMappings(aclText, isV4);
  const sidPaths = buildSidPaths(aclText, sidRunwayMap, isV4);
  assert(sidPaths['JFK5.JFK'],
    'JFK5.JFK should be in SID paths');
});

// ── 4. JFK5.JFK is NOT in APPR data ───────────────────────────────

test('extractApprRunwayMappings: JFK5.JFK is NOT in APPR data', () => {
  const { apprRunwayMap } = extractApprRunwayMappings(aclText, isV4);
  assert(!apprRunwayMap['JFK5.JFK'],
    'JFK5.JFK should NOT be in APPR mappings (RouteType=2 is SID, not Approach)');
});

// ── 5. buildStarPaths ────────────────────────────────────────────

test('buildStarPaths: SIE.CAMRM5 has per-runway variants', () => {
  const { starRunwayMap } = extractStarRunwayMappings(aclText, isV4);
  const starPaths = buildStarPaths(aclText, new Map(), starRunwayMap, isV4);
  const camrn = starPaths['SIE.CAMRM5'];
  assert(camrn, 'SIE.CAMRM5 not found in starPaths');
  assert(Array.isArray(camrn), 'starPaths SIE.CAMRM5 should be an array');

  // Each variant should have runway and points
  const seenRunways = new Set();
  for (const variant of camrn) {
    assert(variant.runway, 'variant missing runway');
    assert(Array.isArray(variant.points), 'variant missing points array');
    assert(variant.points.length >= 2, 'variant has < 2 points');
    seenRunways.add(variant.runway);

    // Verify point count matches expected
    const exp = expectedNodeCounts[variant.runway];
    if (exp !== undefined) {
      assertEquals(variant.points.length, exp,
        variant.runway + ' variant: expected ' + exp + ' points, got ' + variant.points.length);
    }
  }

  // All 3 runways should have a variant
  assertEquals(seenRunways.size, 3,
    'expected 3 runway variants, got ' + seenRunways.size);
  for (const rwy of Object.keys(expectedNodeCounts)) {
    assert(seenRunways.has(rwy), 'missing ' + rwy + ' variant in starPaths');
  }
});

// ── Summary ──────────────────────────────────────────────────────

console.log('');
console.log('Results:', passed, 'passed,', failed, 'failed');
if (failed > 0) process.exit(1);
