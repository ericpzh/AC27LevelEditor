/**
 * Runway Entries/Exits type-id distinctness + no-fallback assertions
 * (Ground Painter save path).
 *
 * The GATCARC4 writer requires every distinct type in a document to use a UNIQUE
 * id. A runway's Entries/Exits serialization has an ARRAY wrapper type
 * ("Runway+Entry[]"/"Runway+Exit[]") and an ELEMENT type ("Runway+Entry"/
 * "Runway+Exit") that must use DIFFERENT ids. Guessing a hardcoded fallback id
 * (e.g. 15 for both) caused saves to abort with:
 *   Type id 15 claimed by both "Runway+Entry[]" and "Runway+Entry"
 *
 * No fallback is allowed: if a type cannot be determined from the file, the code
 * ASSERTS instead of emitting a guessed $type. These tests pin that behaviour.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const { readAclText, encodeArchive } = require('../../src/acl/gatcarc');
const { buildSceneryGraph } = require('../../src/acl/scenery_graph');
const {
  patchSceneryBlob,
  _typeId,
  _sampleRunwayInnerType,
} = require('../../src/acl/scenery_write');

const ENTRY_ARR = '15|ContextCross.Models.Runway+Entry[], GroundATC.Core';
const ENTRY_EL = 'ContextCross.Models.Runway+Entry, GroundATC.Core';
const EXIT_ARR = '17|ContextCross.Models.Runway+Exit[], GroundATC.Core';
const EXIT_EL = 'ContextCross.Models.Runway+Exit, GroundATC.Core';

function readFixture(name) {
  const p = path.join(__dirname, '..', 'fixtures', 'game-root', 'GroundATC_Data', 'StreamingAssets', 'Airports', 'ZSJN', 'Levels', name);
  return readAclText(p);
}

function entryBlock(innerType) {
  return '"$v": { "Entries": { "$id": 1, "$type": "' + ENTRY_ARR + '", "$rlength": 1, "$rcontent": [ { "$id": 2, "$type": ' + innerType + ', "Name": "A1" } ] } }';
}

describe('Runway Entries/Exits type-id distinctness', () => {
  it('_typeId parses quoted and bare $type values', () => {
    expect(_typeId('"15|ContextCross.Models.Runway+Entry[], GroundATC.Core"')).toBe(15);
    expect(_typeId('16')).toBe(16);
    expect(_typeId('"14|ContextCross.Models.Runway+Entry[], GroundATC.Core"')).toBe(14);
    expect(_typeId('"0')).toBe(0);
    expect(_typeId(null)).toBe(null);
  });

  it('samples the existing element id (16), distinct from the array id (15)', () => {
    const inner = _sampleRunwayInnerType([entryBlock('"16|' + ENTRY_EL + '"')], '"' + ENTRY_ARR + '"', 'Entries', ENTRY_EL);
    expect(_typeId(inner)).toBe(16); // distinct from the array id 15
  });

  it('samples the existing exit element id, distinct from the exit array id', () => {
    const block = '"$v": { "Exits": { "$id": 1, "$type": "' + EXIT_ARR + '", "$rlength": 1, "$rcontent": [ { "$id": 2, "$type": "18|' + EXIT_EL + '", "Name": "E" } ] } }';
    const inner = _sampleRunwayInnerType([block], '"' + EXIT_ARR + '"', 'Exits', EXIT_EL);
    expect(_typeId(inner)).toBe(18); // distinct from the array id 17
  });

  it('returns NULL (no fallback) when no element type can be sampled', () => {
    // Empty runway set → the element type cannot be determined → null, never a guess.
    expect(_sampleRunwayInnerType([], '"' + ENTRY_ARR + '"', 'Entries', ENTRY_EL)).toBe(null);
  });

  it('editing entries/exits on the real fixture yields distinct array/inner ids and encodes', () => {
    const text = readFixture('ZSJN_leisure_1.acl');
    const { graph, meta } = buildSceneryGraph(text);
    const g = structuredClone(graph);
    g.runways[0].entries = [...(g.runways[0].entries || []), { name: 'Z1', holdingIdx: 1, lineUpIdx: 3, defineIdx: 1, runwayName: '01' }];
    g.runways[0].exits = [...(g.runways[0].exits || []), { name: 'Z2', exitIdx: 1, holdingIdx: 3, defineIdx: 1, isLeft: true, runwayName: '01' }];
    const newText = patchSceneryBlob(text, g, null, structuredClone(meta), { warnings: [] });
    expect(() => encodeArchive(newText)).not.toThrow();
    const idx = newText.indexOf('"runway:01"');
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = newText.slice(idx, idx + 3000);
    const arrT = block.match(/"Entries":\s*\{\s*"\$id":\s*\d+\s*,\s*"\$type":\s*("[^"]+"|\d+)/);
    const innerT = block.match(/"Entries"[\s\S]{0,900}?"\$rcontent"\s*:\s*\[\s*\{\s*"\$id":\s*\d+\s*,\s*"\$type":\s*("[^"]+"|\d+)/);
    expect(arrT).toBeTruthy();
    expect(innerT).toBeTruthy();
    expect(_typeId(arrT[1])).not.toBe(_typeId(innerT[1]));
  });

  it('removing a direction\'s only entry still encodes (no orphaned bare type ref)', () => {
    const text = readFixture('ZSJN_leisure_1.acl');
    const { graph, meta } = buildSceneryGraph(text);
    const g = structuredClone(graph);
    g.runways[0].entries = g.runways[0].entries.filter((e) => e.name !== 'A14');
    const newText = patchSceneryBlob(text, g, null, structuredClone(meta), { warnings: [] });
    expect(() => encodeArchive(newText)).not.toThrow();
    const segs = newText.split(/\r?\n\$\$\$ GATCARC4 CHECKPOINT FRAME \$\$\$\r?\n/);
    const level = segs.find((s) => s.indexOf('"runway:01"') >= 0) || '';
    expect(/"\$type":\s*"\d+\|ContextCross\.Models\.Runway\+Entry, GroundATC\.Core"/.test(level)).toBe(true);
  });

  it('round-trips the no-edit fixture through patch + encode', () => {
    const text = readFixture('ZSJN_leisure_1.acl');
    const { graph, meta } = buildSceneryGraph(text);
    const newText = patchSceneryBlob(text, graph, null, meta, { warnings: [] });
    expect(() => encodeArchive(newText)).not.toThrow();
  });

  it('ASSERTS (rather than falls back) when synthesizing a runway whose type cannot be sampled', () => {
    // The test fixture has no PhysicalRunwayStaticItem type; synthesizing a NEW
    // runway must fail loudly instead of guessing an id (the original collision).
    const text = readFixture('ZSJN_leisure_1.acl');
    const { graph, meta } = buildSceneryGraph(text);
    const g = structuredClone(graph);
    g.nodes = [...g.nodes, { x: 800, z: 0, type: 1, flags: 0 }, { x: 900, z: 0, type: 1, flags: 0 }];
    const na = g.nodes.length - 2, nb = g.nodes.length - 1;
    g.runways = [...g.runways, { thAIdx: na, thBIdx: nb, names: ['08', '26'], physicalName: '08/26', width: 0.5, entries: [{ name: 'NEWR', holdingIdx: na, lineUpIdx: nb, defineIdx: na, runwayName: '08' }], exits: [] }];
    expect(() => patchSceneryBlob(text, g, null, structuredClone(meta), { warnings: [] })).toThrow(/no fallback allowed/);
  });
});
