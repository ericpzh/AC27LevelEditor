/**
 * Ground Painter — stand / taxiway naming persistence.
 *
 * Covers the write-back of a user-entered Name for both stands and taxiway
 * segments:
 *  - no-touch remains byte-identical (nothing set → nothing patched);
 *  - an existing (survivor) stand / taxiway rename is written back and re-parses;
 *  - an untouched survivor is NOT re-written (a `name` present without the
 *    `nameEdited` flag must not produce a patch — this is what keeps the
 *    identifier-fallback and default-empty state out of the file);
 *  - a new stand with a user Name is synthesized with that Name;
 *  - the low-level Name patch inserts into a Name-less segment in the canonical
 *    position (between PK and OsmId) and treats `"Name": null` as empty.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { buildSceneryGraph } = require('../../src/acl/scenery_graph');
const { patchSceneryBlob, _patchEntryName, _entryNameValue } = require('../../src/acl/scenery_write');

const FIXTURE = path.join(__dirname, '..', '_debug', 'ZSJN_leisure_1.decoded.txt');
const text = fs.readFileSync(FIXTURE, 'utf8');

describe('Ground Painter — stand / taxiway naming', () => {
  it('no-touch stays byte-identical (no names edited)', () => {
    const { graph, meta } = buildSceneryGraph(text);
    expect(patchSceneryBlob(text, graph, null, meta)).toBe(text);
  });

  it('renames a survivor stand Name and re-parses', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    const idx = meta.standOrigPk.findIndex((pk) => pk != null);
    expect(idx).toBeGreaterThanOrEqual(0);
    const g = { ...g0, stands: g0.stands.map((s) => ({ ...s })) };
    g.stands[idx] = { ...g.stands[idx], name: 'STAND-ALPHA', nameEdited: true };
    const out = patchSceneryBlob(text, g, null, meta);
    expect(out).not.toBe(text);
    const { graph: g1 } = buildSceneryGraph(out);
    expect(g1.stands.some((s) => s.name === 'STAND-ALPHA')).toBe(true);
  });

  it('renames a survivor taxiway Name and re-parses', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    const idx = meta.segOrigPk.findIndex((pk) => pk != null);
    expect(idx).toBeGreaterThanOrEqual(0);
    const g = { ...g0, segments: g0.segments.map((s) => ({ ...s })) };
    g.segments[idx] = { ...g.segments[idx], name: 'TAXY-ALPHA', nameEdited: true };
    const out = patchSceneryBlob(text, g, null, meta);
    expect(out).not.toBe(text);
    const { graph: g1 } = buildSceneryGraph(out);
    expect(g1.segments.some((s) => s.name === 'TAXY-ALPHA')).toBe(true);
  });

  it('ignores a name set without the nameEdited flag (identifier-fallback kept out)', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    const idx = meta.segOrigPk.findIndex((pk) => pk != null);
    const g = { ...g0, segments: g0.segments.map((s) => ({ ...s })) };
    g.segments[idx] = { ...g.segments[idx], name: 'X' }; // no nameEdited
    expect(patchSceneryBlob(text, g, null, meta)).toBe(text);
  });

  it('synthesizes a new stand with the user Name', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    const g = { ...g0, nodes: g0.nodes.map((n) => ({ ...n })), stands: g0.stands.map((s) => ({ ...s })) };
    const m = { ...meta, nodeOrigPk: [...meta.nodeOrigPk], standOrigPk: [...meta.standOrigPk], segOrigPk: [...meta.segOrigPk] };
    const nNose = g.nodes.length, nTail = nNose + 1;
    g.nodes.push({ x: 5555.5, z: 6666.5, type: 2, flags: 0 });
    g.nodes.push({ x: 5555.5, z: 6670.5, type: 2, flags: 0 });
    m.nodeOrigPk.push(null, null);
    g.stands.push({ noseIdx: nNose, tailIdx: nTail, heading: 90, pushbackIdxs: [], name: 'GATE-7', nameEdited: true, parkingType: 1, egressType: 0 });
    m.standOrigPk.push(null);
    const out = patchSceneryBlob(text, g, null, m);
    expect(out).not.toBe(text);
    const { graph: g1 } = buildSceneryGraph(out);
    expect(g1.stands.some((s) => s.name === 'GATE-7')).toBe(true);
  });

  it('inserts a Name into a Name-less segment in canonical position', () => {
    const e = '{ "$k": "taxiway-segment:-9:0", "$v": { "$id": 1, "$type": 7, "PK": "taxiway-segment:-9:0", "OsmId": -9, "Nodes": { "$id": 2, "$type": 8, { "$id": 3, "$type": 9, "$rlength": 2, "$rcontent": [ $iref:10, $iref:11 ] } }, "Flags": 2, "Directed": false, "Head": null, "IsHidden": false, "IsUnselectable": false } }';
    const patched = _patchEntryName(e, 'NEWT');
    expect(patched).toContain('"PK": "taxiway-segment:-9:0", "Name": "NEWT", "OsmId": -9');
    expect(_entryNameValue(patched)).toBe('NEWT');
  });

  it('treats an existing Name field as replaceable and `null` as empty', () => {
    const e = '{ "$k": "taxiway-segment:-8:0", "$v": { "$id": 1, "$type": 7, "PK": "taxiway-segment:-8:0", "Name": "", "OsmId": -8 } }';
    expect(_patchEntryName(e, 'ZULU')).toContain('"Name": "ZULU"');
    expect(_entryNameValue('{ "$id": 1, "Name": null, "Identifier": "1" }')).toBe('');
  });
});
