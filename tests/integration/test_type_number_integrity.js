/**
 * Type Number Integrity Test
 *
 * Verifies that the save/rebuild pipeline uses correct per-file type numbers.
 * After save, every $type declaration in the output must match the source .bak's
 * typeMap — no type number drift from hardcoded defaults.
 */
const fs = require('fs');
const path = require('path');
const { loadFlights, generateFullAcl, sortFlightsChronologically, extractTypeMap } = require('../../src/acl/parser');

const FIXTURE_ACL = path.join(__dirname, '..', 'fixtures', 'game-root', 'GroundATC_Data',
  'StreamingAssets', 'Airports', 'ZSJN', 'Levels', 'ZSJN-Morning_120min.acl');
const TEMP_ACL = path.join(__dirname, '_temp_type_integrity.acl');
const TEMP_BAK = path.join(__dirname, '_temp_type_integrity.acl.bak');

let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) { console.log('  ✓ ' + label); passed++; return true; }
  else { console.log('  ✗ ' + label); failed++; return false; }
}

function cleanup() {
  try { if (fs.existsSync(TEMP_ACL)) fs.unlinkSync(TEMP_ACL); } catch (_) {}
  try { if (fs.existsSync(TEMP_BAK)) fs.unlinkSync(TEMP_BAK); } catch (_) {}
}

console.log('Test: Type Number Integrity');
console.log('Fixture: ' + path.basename(FIXTURE_ACL) + '\n');

// [1] Copy fixture to temp, create .bak as source of truth
console.log('[1] Setting up temp files...');
fs.copyFileSync(FIXTURE_ACL, TEMP_ACL);
fs.copyFileSync(FIXTURE_ACL, TEMP_BAK);

// [2] Extract typeMap from .bak (source of truth)
console.log('[2] Extracting typeMap from .bak...');
const bakText = fs.readFileSync(TEMP_BAK, 'utf-8');
const bakTypeMap = extractTypeMap(bakText);
console.log('  .bak typeMap: ' + bakTypeMap.size + ' type declarations');
check(bakTypeMap.size > 0, '.bak typeMap is non-empty');

// [3] Load flights and sort
console.log('[3] Loading flights...');
const loaded = loadFlights(TEMP_ACL);
const flights = loaded && loaded.flights ? loaded.flights : [];
console.log('  Loaded ' + flights.length + ' flights');
check(flights.length > 0, 'flights loaded');

const sorted = sortFlightsChronologically(flights);
check(sorted.length === flights.length, 'sort preserved count');

// [4] Save via rebuild pipeline
console.log('[4] Running generateFullAcl (save)...');
generateFullAcl(TEMP_ACL, sorted, null, null, null, null, null, null, null, null, null, null);

// [5] Read saved output
console.log('[5] Analyzing saved output...');
const outText = fs.readFileSync(TEMP_ACL, 'utf-8');
console.log('  Output size: ' + (outText.length / 1024).toFixed(0) + ' KB');

// [6] Extract all full-form $type declarations from saved output
const outTypeDecls = new Map();
const typeDeclRegex = /"\$type":\s*"(\d+)\|([^"]+)"/g;
let m;
while ((m = typeDeclRegex.exec(outText)) !== null) {
  const num = parseInt(m[1], 10);
  const name = m[2];
  if (!outTypeDecls.has(num)) {
    outTypeDecls.set(num, name);
  }
}
console.log('  Output typeMap: ' + outTypeDecls.size + ' type declarations');
check(outTypeDecls.size > 0, 'output typeMap is non-empty');

// [7] Verify every type declaration in the output matches the .bak
console.log('[6] Verifying type numbers match .bak...');
let mismatches = 0;
for (const [num, name] of outTypeDecls) {
  const bakName = bakTypeMap.get(num);
  if (bakName === undefined) {
    console.log('  ✗ type ' + num + ' ("' + name + '"): in output but NOT in .bak');
    mismatches++;
  } else if (bakName !== name) {
    console.log('  ✗ type ' + num + ': output="' + name + '" vs bak="' + bakName + '"');
    mismatches++;
  }
}
check(mismatches === 0, 'all output type numbers match .bak (' + mismatches + ' mismatches)');

// [8] Verify known problematic types are correct
console.log('[7] Verifying specific type numbers...');
const listVec3Num = outTypeDecls.get(42);
if (listVec3Num && listVec3Num.includes('List')) {
  check(false, 'type 42 should NOT be List<Vector3> (is: ' + listVec3Num + ')');
} else {
  check(true, 'type 42 is not List<Vector3> (correct)');
}

const animStateNum = findTypeNum(outTypeDecls, 'AircraftAnimatorState');
const animSubNum = findTypeNum(outTypeDecls, 'AircraftAnimState');
const fpStateNum = findTypeNum(outTypeDecls, 'FlightPlanState');
console.log('  AircraftAnimatorState: type ' + animStateNum);
console.log('  AircraftAnimState:     type ' + animSubNum);
console.log('  FlightPlanState:       type ' + fpStateNum);
console.log('  List<Vector3>:         type ' + findTypeNum(outTypeDecls, 'List`1[[UnityEngine.Vector3'));

// ─── Cleanup ───────────────────────────────────────────────────
cleanup();

// ─── Summary ────────────────────────────────────────────────────
console.log('\n' + '='.repeat(50));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

// ─── Helpers ────────────────────────────────────────────────────

function findTypeNum(typeMap, search) {
  for (const [num, name] of typeMap) {
    if (name.includes(search)) return num;
  }
  return null;
}
