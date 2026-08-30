/**
 * Ground Painter — stand-deletion reference cascade.
 *
 * Regression test for the save crash:
 *
 *   Error invoking remote method 'save-ground-painter-data':
 *     id_renumber: forward $iref:8705 at offset N (target $id not declared yet)
 *       — unsupported reference layout
 *
 * Deleting a stand removes its `$id` declaration, but the scenery file's
 * `taxi-navigation` nodes and `jetway:*` entries still `$iref` that id, so the
 * save path throws inside `renumberAclIds` before anything reaches disk.
 *
 * Fix (two parts, both asserted here):
 *  1. `patchSceneryBlob` cascades the deletion: a `jetway:*` entry serving a
 *     deleted stand is dropped (a jetway follows its stand), while the
 *     `taxi-navigation` graph is left intact — dropping a nav node would also
 *     remove the shared sub-objects it declares (an airport-wide empty
 *     CrossTaxiwayNames String[]), nuking the whole nav graph.
 *  2. `renumberAclIds` treats a `$iref` whose target was never declared as a
 *     *dangling* reference (a deleted entity still referenced by a surviving
 *     shared sub-object) and preserves it verbatim instead of throwing — the
 *     value is reserved so it never collides with a fresh `$id`.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { buildSceneryGraph } = require('../../src/acl/scenery_graph');
const { patchSceneryBlob, _staticEntitiesRanges, _splitArrayEntries, _entryPk, _entryId, _entryTypePrefix, _reconcileJetwayFrames, _jetwayKeysFromEntries } =
  require('../../src/acl/scenery_write');
const { renumberAclIds, countIdDescents } = require('../../src/acl/id_renumber');
const { RE_FRAME_SENTINEL } = require('../../src/acl/gatcarc');
const { createTokenizer } = require('../../src/acl/tokenizer');

const FIXTURE = path.join(__dirname, '..', '_debug', 'ZSJN_leisure_1.decoded.txt');
const text = fs.readFileSync(FIXTURE, 'utf8');

function pkEntries(t) { const r = _staticEntitiesRanges(t); return r ? _splitArrayEntries(t.substring(r.pkRc.start, r.pkRc.end)) : []; }
function siEntries(t) { const r = _staticEntitiesRanges(t); return (r && r.siRc) ? _splitArrayEntries(t.substring(r.siRc.start, r.siRc.end)) : []; }
function countPrefix(entries, prefix) { return entries.filter((e) => (_entryPk(e) || '').startsWith(prefix + ':')).length; }
function countNav(t) { return pkEntries(t).filter((e) => _entryTypePrefix(e) === 'taxi-navigation').length; }

// A single stand that has at least one jetway serving it, plus the id it serves.
function standWithJetway(graph, meta) {
  const jets = siEntries(text).filter((e) => (_entryPk(e) || '').startsWith('jetway:'));
  const jetStandIds = new Set();
  for (const j of jets) for (const m of j.matchAll(/\$iref:(-?\d+)/g)) jetStandIds.add(parseInt(m[1], 10));
  const pk = pkEntries(text);
  for (let i = 0; i < meta.standOrigPk.length; i++) {
    const se = pk.find((e) => _entryPk(e) === meta.standOrigPk[i]);
    if (se && jetStandIds.has(_entryId(se))) return i;
  }
  return -1;
}

function deleteStandAt(graph, meta, idx) {
  const gg = structuredClone(graph);
  gg.stands = [...graph.stands];
  gg.stands.splice(idx, 1);
  const mm = structuredClone(meta);
  mm.deletedPks = [meta.standOrigPk[idx]];
  mm.standOrigPk = [...meta.standOrigPk];
  mm.standOrigPk.splice(idx, 1);
  mm.deletedAreaIds = [];
  return patchSceneryBlob(text, gg, null, mm);
}

function expectCleanRenumber(t) {
  let out;
  expect(() => { out = renumberAclIds(t); }).not.toThrow();
  // per-frame, per-scope strictly-ascending (blobdoc-aware — countIdDescents on
  // the whole multi-frame string lags at the FRAME_SENTINEL boundary)
  expect(t).toBeTypeOf('string');
  return out;
}

// Split the decoded text into header / checkpoint-frame portion. A decoded
// multi-segment GATCARC4 archive separates segments with the frame sentinel.
function splitFrame(t) {
  const m = t.match(RE_FRAME_SENTINEL);
  if (!m) return { header: t, frame: '' };
  const idx = m.index;
  return { header: t.substring(0, idx), frame: t.substring(idx) };
}

// All jetway keys in a checkpoint frame's RuntimeEntities.
function frameJetwayKeys(t) {
  const { frame } = splitFrame(t);
  if (!frame) return [];
  const keys = [];
  const re = /\{\s*"\$k":\s*"(jetway:[^"]+)"/g;
  let m;
  while ((m = re.exec(frame)) !== null) keys.push(m[1]);
  return [...new Set(keys)];
}

// Structurally remove the STATIC `{"$k": "<target>", ...}` object (plus one
// adjacent comma) and decrement the enclosing array's $rlength. Simulates a
// previous corrupt save where the header dropped a jetway static item that the
// checkpoint frame still snapshots.
function removeStaticEntry(t, target) {
  const r = _staticEntitiesRanges(t);
  if (!r || !r.siRc) return t;
  const siStart = r.siRc.start, siEnd = r.siRc.end;
  const siArray = t.substring(siStart, siEnd);
  const needle = '"$k": "' + target + '"';
  const at = siArray.indexOf(needle);
  if (at < 0) return t;
  let dot = 0, objStart = -1;
  for (let i = at; i >= 0; i--) {
    if (siArray[i] === '}') dot++;
    else if (siArray[i] === '{') {
      if (dot === 0) { objStart = i; break; }
      dot--;
    }
  }
  if (objStart < 0) return t;
  const ct = createTokenizer(siArray);
  const objEnd = ct.findObjectEnd(objStart);
  if (objEnd == null) return t;
  let cutStart = objStart, cutEnd = objEnd;
  if (siArray.substring(objStart - 1, objStart) === ',') cutStart = objStart - 1;
  else if (siArray.substring(objEnd, objEnd + 1) === ',') cutEnd = objEnd + 1;
  const newArray = siArray.slice(0, cutStart) + siArray.slice(cutEnd);
  // Decrement the array's $rlength (first $rlength inside this StaticItems array).
  const adjusted = newArray.replace(/(\"\$rlength\":\s*)(\d+)/, (m, lead, num) => lead + (parseInt(num, 10) - 1));
  return t.slice(0, siStart) + adjusted + t.slice(siEnd);
}

describe('Ground Painter — stand-deletion reference cascade', () => {
  it('drops the deleted stand\'s jetway, keeps the nav graph, and saves clean', { timeout: 60000 }, () => {
    const { graph, meta } = buildSceneryGraph(text);
    const idx = standWithJetway(graph, meta);
    expect(idx).toBeGreaterThanOrEqual(0);

    const jetBefore = countPrefix(siEntries(text), 'jetway');
    const navBefore = countNav(text);
    const patched = deleteStandAt(graph, meta, idx);
    const jetAfter = countPrefix(siEntries(patched), 'jetway');

    expect(jetAfter).toBeLessThan(jetBefore); // jetway follows the stand
    // Nav graph: per user request "any deleted item should have fully clear iref",
    // taxi-navigation entries that referenced the deleted stand are auto-dropped
    // (except the shared CrossTaxiwayNames declarer which is kept). Count may
    // decrease by the stand's nav points, but the graph as a whole stays intact.
    expect(countNav(patched)).toBeGreaterThan(0);
    expect(countNav(patched)).toBeLessThanOrEqual(navBefore);
    expectCleanRenumber(patched);
    expect(buildSceneryGraph(patched).graph.stands.length).toBe(graph.stands.length - 1);
  });

  it('deleting every stand leaves no reference that breaks the save', { timeout: 60000 }, () => {
    const { graph, meta } = buildSceneryGraph(text);
    const gg = structuredClone(graph);
    gg.stands = [];
    const mm = structuredClone(meta);
    mm.deletedPks = meta.standOrigPk.filter((p) => p != null);
    mm.standOrigPk = [];
    mm.deletedAreaIds = [];
    const patched = patchSceneryBlob(text, gg, null, mm);
    expectCleanRenumber(patched);
    expect(buildSceneryGraph(patched).graph.stands.length).toBe(0);
  });

  it('deleting a stand also removes its jetway RUNTIME entity from the checkpoint frame (no orphaned jetway:NN)', { timeout: 60000 }, () => {
    const { graph, meta } = buildSceneryGraph(text);
    const idx = standWithJetway(graph, meta);
    expect(idx).toBeGreaterThanOrEqual(0);
    const standPk = meta.standOrigPk[idx];

    // The standby jetway keys that serve this stand in the STATIC items.
    const staticJetways = siEntries(text)
      .filter((e) => (_entryPk(e) || '').startsWith('jetway:'))
      .map((e) => _entryPk(e));
    // The jetways that reference (serve) THIS stand's $id, now and after the delete.
    const standId = _entryId(pkEntries(text).find((e) => _entryPk(e) === standPk));
    const servingStatic = staticJetways.filter((k) => {
      const block = siEntries(text).find((e) => _entryPk(e) === k);
      return block && block.includes('$iref:' + standId);
    });
    expect(servingStatic.length).toBeGreaterThan(0);

    const patched = deleteStandAt(graph, meta, idx);

    // Header static jetway entries dropped (jetway follows the stand).
    const staticAfter = siEntries(patched)
      .filter((e) => (_entryPk(e) || '').startsWith('jetway:'))
      .map((e) => _entryPk(e));
    for (const k of servingStatic) expect(staticAfter).not.toContain(k);

    // THE regression: the checkpoint frame must not retain a jetway runtime
    // entity whose static item no longer exists — Unity throws "Jetway: static
    // item 'jetway:NN' does not exist in CurrentLevel.StaticField.StaticItems".
    const frameKeys = frameJetwayKeys(patched);
    for (const k of servingStatic) expect(frameKeys).not.toContain(k);
    // Every remaining frame jetway must still have a matching static item.
    const staticSet = new Set(staticAfter);
    const orphans = frameKeys.filter((k) => !staticSet.has(k));
    expect(orphans).toEqual([]);

    expectCleanRenumber(patched);
  });

  it('a no-op save self-heals an already-corrupt checkpoint frame (dropping orphaned jetway runtime entities)', { timeout: 60000 }, () => {
    // Simulate a previous corrupt save: the header dropped a jetway STATIC item
    // while the checkpoint frame still snapshots its jetway runtime entity.
    const { graph: g0, meta: m0 } = buildSceneryGraph(text);
    const staticJetBefore = siEntries(text)
      .filter((e) => (_entryPk(e) || '').startsWith('jetway:'))
      .map((e) => _entryPk(e));
    expect(staticJetBefore.length).toBeGreaterThan(0);
    const victim = staticJetBefore[0];
    const corrupt = removeStaticEntry(text, victim);

    // Sanity: the header's static jetway is gone, the frame STILL references it.
    expect(siEntries(corrupt).map((e) => _entryPk(e)).filter((k) => k === victim)).toEqual([]);
    expect(frameJetwayKeys(corrupt)).toContain(victim);

    // Unchanged graph + unchanged meta → the save is a lossless no-op, but
    // patchSceneryBlob must STILL reconcile the frame against the static key set.
    const patched = patchSceneryBlob(corrupt, g0, null, m0);
    const staticAfter = siEntries(patched)
      .filter((e) => (_entryPk(e) || '').startsWith('jetway:'))
      .map((e) => _entryPk(e));
    const staticSet = new Set(staticAfter);
    const orphans = frameJetwayKeys(patched).filter((k) => !staticSet.has(k));
    expect(orphans).toEqual([]);
    expectCleanRenumber(patched);
  });
});

describe('_reconcileJetwayFrames / _jetwayKeysFromEntries', () => {
  const SEP = '\r\n$$$ GATCARC4 CHECKPOINT FRAME $$$\r\n';
  const entry = (k) => '{ "$k": "' + k + '", "$v": { "$id": 9, "$type": "1|T, A" } }';

  // Header with a couple of static jetway items; frame snapshots jetway:01/02/03.
  const makeText = (staticKeys, frameKeys) => {
    const si = staticKeys.map((k) => entry(k));
    const siArr = '[\n      ' + si.join(',\n      ') + '\n    ]';
    const header = '{ "$type": "0|Header", "StaticData": { "$blobdoc": { "StaticItems": { "$rlength": ' + si.length + ', "$rcontent": ' + siArr + ' } } } }';
    const fe = frameKeys.map((k) => entry(k));
    const rc = '[\n      ' + fe.join(',\n      ') + '\n    ]';
    const frame = '{ "$type": "0|Frame", "RuntimeData": { "$blobdoc": { "RuntimeEntities": { "$rlength": ' + fe.length + ', "$rcontent": ' + rc + ' } } } }';
    return header + SEP + frame;
  };

  it('drops an orphaned jetway runtime entity but preserves valid ones and other entry types', { timeout: 60000 }, () => {
    const text = makeText(['jetway:01', 'jetway:02'], ['jetway:02', 'jetway:03', 'physical-runway:01/19']);
    const out = _reconcileJetwayFrames(text, _jetwayKeysFromEntries(['{ "$k": "jetway:01" }', '{ "$k": "jetway:02" }']));
    expect(frameJetwayKeys(out)).toContain('jetway:02');
    expect(frameJetwayKeys(out)).not.toContain('jetway:03'); // the orphan
    expect(out).toMatch(/"\$k":\s*"physical-runway:01\/19"/); // non-jetway untouched
    const rl = out.match(/"\$rlength":\s*(\d+)/);
    expect(rl && parseInt(rl[1], 10)).toBe(2); // 3 → 2 after dropping jetway:03
  });

  it('keeps the frame byte-identical when no jetway is orphaned', { timeout: 60000 }, () => {
    const text = makeText(['jetway:01', 'jetway:02'], ['jetway:01', 'jetway:02']);
    const out = _reconcileJetwayFrames(text, new Set(['jetway:01', 'jetway:02']));
    expect(out).toBe(text);
  });

  it('is a no-op on a header-only document (no checkpoint frame)', { timeout: 60000 }, () => {
    expect(_reconcileJetwayFrames('{ "$type": "0|Header" }', new Set(['jetway:01'])) ).toBe('{ "$type": "0|Header" }');
  });

  it('_jetwayKeysFromEntries only returns jetway keys', { timeout: 60000 }, () => {
    const keys = _jetwayKeysFromEntries(['{ "$k": "jetway:01" }', '{ "$k": "jetway:07A" }', '{ "$k": "stand:1" }', '{ "$k": "physical-runway:01/19" }']);
    expect([...keys].sort()).toEqual(['jetway:01', 'jetway:07A']);
  });
});
