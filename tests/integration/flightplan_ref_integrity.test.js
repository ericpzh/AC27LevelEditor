/**
 * Regression: "Aircraft 'aircraft:<REG>' has no flight plan reference."
 *
 * Found by the Ground-Painter fuzz on ZGSZ_leisure_2 / KDCA_leisure_2. The
 * checkpoint frame's `aircraft:<REG>._flightPlan` `$iref` bound to a jetway
 * sub-object (`DockingAircraft`) instead of the aircraft's own
 * `flight-plan:<REG>` declaration, so the game resolved the plan to null and
 * aborted the level load.
 *
 * Root cause: the Ground Painter synthesized a runtime `jetway:*` entity for a
 * *static* jetway that had no runtime snapshot (the `addMissing` template,
 * PhysicalRunway-shaped). The flight rebuild then reused that fabricated id (and
 * its generated sub-ids), which could land in the `segFpIdByReg` flight-plan id
 * block — a duplicate `$id` that `renumberAclIds` resolved to the jetway
 * sub-object (last-declaration-wins), breaking `_flightPlan`.
 *
 * Fix: the jetway reconciler is drop-only (`addMissing` off) and never
 * fabricates a runtime Jetway. This suite pins both invariants after the REAL
 * save pipeline (patchSceneryBlob → generateFullAcl → writeAcl):
 *   1. a static jetway with no runtime entity does NOT get one fabricated, and
 *   2. every saved segment has unique `$id`s and every `aircraft:<REG>` that
 *      carries a `_flightPlan` `$iref` targets its own `flight-plan:<REG>`.
 *
 * Uses the untracked `tests/_debug/ZSJN_leisure_1.decoded.txt` fixture (a full
 * two-segment decoded level with a checkpoint frame) — same requirement as the
 * other Ground Painter save-path suites.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const parser = require('../../src/acl/parser');
const { readAclText, writeAcl, RE_FRAME_SENTINEL } = require('../../src/acl/gatcarc');
const { buildApproachCache } = require('../../src/acl/approach');
const { buildSceneryGraph } = require('../../src/acl/scenery_graph');
const {
  patchSceneryBlob,
  _staticEntitiesRanges,
  _splitArrayEntries,
  _entryPk,
  _jetwayKeysFromEntries,
} = require('../../src/acl/scenery_write');
const { createTokenizer } = require('../../src/acl/tokenizer');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../_debug/ZSJN_leisure_1.decoded.txt');

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeTmpLevel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-planref-'));
  tmpDirs.push(dir);
  const text0 = fs.readFileSync(FIXTURE, 'utf8');
  return { dir, acl: path.join(dir, 'ZSJN_leisure_1.acl'), text0 };
}

// Static jetway $k keys in the header StaticItems.
function staticJetwayKeys(text) {
  const r = _staticEntitiesRanges(text);
  if (!r || !r.siRc) return [];
  const entries = _splitArrayEntries(text.substring(r.siRc.start, r.siRc.end));
  return entries
    .filter((e) => (_entryPk(e) || '').startsWith('jetway:'))
    .map((e) => _entryPk(e));
}

// All `jetway:*` $k keys that have a runtime entity in the checkpoint frame.
function frameJetwayKeys(text) {
  const parts = text.split(RE_FRAME_SENTINEL);
  const frame = parts.length > 1 ? parts[parts.length - 1] : '';
  const keys = [];
  const re = /\{\s*"\$k":\s*"(jetway:[^"]+)"/g;
  let m;
  while ((m = re.exec(frame)) !== null) keys.push(m[1]);
  return [...new Set(keys)];
}

// Structurally remove a runtime-entry object from the checkpoint frame and
// decrement the RuntimeEntities $rlength. Emulates a newly-added static jetway
// that has no runtime snapshot yet.
function removeFrameEntry(text, key) {
  const m = text.match(RE_FRAME_SENTINEL);
  if (!m) return text;
  const header = text.slice(0, m.index + m[0].length);
  let frame = text.slice(m.index + m[0].length);
  const at = frame.indexOf('"$k": "' + key + '"');
  if (at < 0) return text;
  const objStart = frame.lastIndexOf('{', at);
  const ct = createTokenizer(frame);
  const objEnd = ct.findObjectEnd(objStart);
  if (objEnd == null) return text;
  let cutStart = objStart, cutEnd = objEnd;
  if (frame[objStart - 1] === ',') cutStart = objStart - 1;
  else if (frame[objEnd] === ',') cutEnd = objEnd + 1;
  frame = frame.slice(0, cutStart) + frame.slice(cutEnd);
  frame = frame.replace(
    /("RuntimeEntities"\s*:\s*\{\s*"\$rlength"\s*:\s*)(\d+)/,
    (s, lead, n) => lead + (parseInt(n, 10) - 1)
  );
  return header + frame;
}

function assertUniqueIds(segment, label) {
  const seen = new Map();
  const re = /"\$id"\s*:\s*(\d+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    const id = m[1];
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  expect(dupes, label + ': duplicate $id declarations').toEqual([]);
}

// The RuntimeEntities section is one Odin id scope (nested $blobdoc values have
// their own scopes, so ids restart there). Scope both checks to it.
function runtimeEntitiesSection(frame) {
  const t = createTokenizer(frame);
  const re = t.findSection('RuntimeEntities');
  return re ? frame.substring(re.valueStart, re.valueEnd) : '';
}

// The issue-2 invariant: every aircraft that references a plan must target its
// own `flight-plan:<REG>` declaration (never a jetway sub-object).
function assertPlanRefs(text) {
  const parts = text.split(RE_FRAME_SENTINEL);
  const frame = parts.length > 1 ? parts[parts.length - 1] : text;
  const section = runtimeEntitiesSection(frame);
  expect(section.length, 'frame must contain RuntimeEntities').toBeGreaterThan(0);
  assertUniqueIds(section, 'RuntimeEntities');

  const keyAt = [];
  const kre = /"\$k"\s*:\s*"([^"]+)"/g;
  let km;
  while ((km = kre.exec(section)) !== null) keyAt.push({ key: km[1], at: km.index });
  const enclosingKey = (pos) => {
    let k = '(none)';
    for (const e of keyAt) { if (e.at < pos) k = e.key; else break; }
    return k;
  };

  let checked = 0;
  const acRe = /"\$k"\s*:\s*"aircraft:([^"]+)"/g;
  let am;
  while ((am = acRe.exec(section)) !== null) {
    const reg = am[1];
    const entryStart = section.lastIndexOf('{', am.index);
    const et = createTokenizer(section.substring(entryStart));
    const entryEnd = et.findObjectEnd(0);
    const entry = section.substring(entryStart, entryStart + entryEnd);
    const pm = entry.match(/"_flightPlan"\s*:\s*\$iref:(\d+)/);
    if (!pm) continue; // inline plan or an $iref-shared aircraft object
    checked++;
    const targetId = pm[1];
    const declPos = section.indexOf('"$id": ' + targetId);
    expect(declPos, 'aircraft:' + reg + ' _flightPlan target $id:' + targetId + ' must be declared').toBeGreaterThanOrEqual(0);
    expect(
      enclosingKey(declPos),
      'aircraft:' + reg + ' _flightPlan must target flight-plan:' + reg
    ).toBe('flight-plan:' + reg);
  }
  expect(checked, 'expected at least one aircraft _flightPlan $iref in the frame').toBeGreaterThan(0);
}

describe('flight-plan reference integrity (ground-painter save)', () => {
  it('never fabricates a runtime Jetway for a static jetway without one', { timeout: 120000 }, () => {
    const { text0 } = makeTmpLevel();
    const [staticKey] = staticJetwayKeys(text0);
    expect(staticKey).toBeTruthy();

    // Static jetway present, runtime snapshot removed → pre-fix this state made
    // patchSceneryBlob re-synthesize a malformed runtime Jetway.
    const stripped = removeFrameEntry(text0, staticKey);
    expect(frameJetwayKeys(stripped)).not.toContain(staticKey);

    const { graph, meta } = buildSceneryGraph(text0);
    const patched = patchSceneryBlob(stripped, graph, null, meta);

    // Drop-only reconciler: the runtime jetway stays absent, so no fabricated
    // id block can collide with the flight-plan id range.
    expect(frameJetwayKeys(patched)).not.toContain(staticKey);
    expect(
      _jetwayKeysFromEntries(
        _splitArrayEntries(patched.substring(
          _staticEntitiesRanges(patched).siRc.start,
          _staticEntitiesRanges(patched).siRc.end
        ))
      ).has(staticKey)
    ).toBe(true); // the static item itself is untouched
  });

  it('saved frame has unique $id and every aircraft _flightPlan targets its own flight-plan', { timeout: 120000 }, () => {
    const { acl, text0 } = makeTmpLevel();

    // Emulate the fuzz topology that produced the collision: a static jetway
    // with no runtime entity, then run the real save pipeline.
    const [staticKey] = staticJetwayKeys(text0);
    const stripped = removeFrameEntry(text0, staticKey);
    const { graph, meta } = buildSceneryGraph(text0);
    const patched = patchSceneryBlob(stripped, graph, null, meta);

    writeAcl(acl, patched, { format: 'text', originalText: text0 });

    const data = parser.loadFlights(acl);
    const flights = parser.sortFlightsChronologically(JSON.parse(JSON.stringify(data.flights)));
    const approachCache = buildApproachCache(path.dirname(FIXTURE));
    parser.generateFullAcl(
      acl,
      flights,
      data.before,
      data.after,
      data.originalBlocks,
      data.sceneryMaps,
      approachCache,
      (parser._extractConfig(text0) || {}).startTime || null,
      null
    );

    const saved = readAclText(acl);
    assertPlanRefs(saved);
  });
});
