/**
 * GATCARC4 v2 checkpoint-frame edit persistence.
 *
 * Regression for the fuzz-produced broken leisure levels: the save pipeline
 * rewrote the decoded checkpoint-frame text (orphan runtime-entity removal,
 * stale $fstrref nulling, $iref remapping) but `encodeV2Archive` re-copied the
 * original frame bytes verbatim and ignored the edited frame docs. The header's
 * StaticItems lost the deleted flight plans while the frame's runtime
 * `flight-plan:REG` entities (with `StaticItem: $fstrref:"flight-plan:REG"`)
 * survived, so the game aborted GameStateRegistry.RestoreWorld.
 *
 * This test builds a synthetic v2 archive with one checkpoint frame, edits the
 * frame text, round-trips through writeAcl/readAclText, and asserts the edit
 * persisted.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const {
  writeAcl,
  readAclText,
  getStorageVersion,
  parseV2Archive,
  buildV2HeaderSegment,
  buildV2MainSegment,
  encodeTextToPayload,
} = require('../../src/acl/gatcarc');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const SENTINEL = '$$$ GATCARC4 CHECKPOINT FRAME $$$';

const MAIN_TEXT = [
  '{',
  '    "$id": 1,',
  '    "$type": "0|ContextCross.Saves.SaveSystem+LevelPayload, GroundATC.Core",',
  '    "MetaData": {',
  '        "$id": 2,',
  '        "$type": "1|ContextCross.Saves.LevelMetaData, GroundATC.Core",',
  '        "Guid": "TEST_leisure_1"',
  '    }',
  '}',
].join('\r\n');

/** Build a checkpoint-frame doc containing the given plan registrations. */
function frameText(regs) {
  const entries = regs.map((reg, i) => [
    '                {',
    `                    "$k": "flight-plan:${reg}",`,
    '                    "$v": {',
    `                        "$id": ${4 + i * 2},`,
    '                        "$type": "3|Some.Runtime.Entity, GroundATC.Core",',
    `                        "StaticItem": $fstrref:"flight-plan:${reg}"`,
    '                    }',
    '                }',
  ].join('\r\n')).join(',\r\n');
  return [
    '{',
    '    "$id": 1,',
    '    "$type": "0|ContextCross.Saves.SaveSystem+CheckpointPayload, GroundATC.Core",',
    '    "RuntimeData": {',
    '        "$id": 2,',
    '        "$type": "1|ContextCross.Saves.RuntimeField, GroundATC.Core",',
    '        "RuntimeEntities": {',
    '            "$id": 3,',
    '            "$type": "2|System.Collections.Generic.Dictionary`2[[System.String, mscorlib],[ContextCross.Saves.Serialization.IRuntimeEntity, GroundATC.Core]], mscorlib",',
    `            "$rlength": ${regs.length},`,
    '            "$rcontent": [',
    entries,
    '            ]',
    '        }',
    '    }',
    '}',
  ].join('\r\n');
}

/** Build the internal v2 frame payload: [4 jsonLen][json][32 hash][4 binLen][bin][32 hash][NODF]. */
function makeFramePayload(innerText, jsonText) {
  const json = Buffer.from(jsonText, 'utf-8');
  const bin = encodeTextToPayload(innerText);
  const lenJ = Buffer.alloc(4); lenJ.writeUInt32LE(json.length, 0);
  const lenB = Buffer.alloc(4); lenB.writeUInt32LE(bin.length, 0);
  return Buffer.concat([lenJ, json, sha256(json), lenB, bin, sha256(bin), Buffer.from('NODF', 'ascii')]);
}

function marfSegment(payload, version = 2) {
  const head = Buffer.alloc(12);
  head.write('MARF', 0, 'ascii');
  head.writeUInt32LE(version, 4);
  head.writeUInt32LE(payload.length, 8);
  return Buffer.concat([head, payload]);
}

function makeV2Archive(mainText, frameInner) {
  const header = buildV2HeaderSegment('TEST_leisure_1', 'ZSJN');
  const main = buildV2MainSegment(encodeTextToPayload(mainText));
  const frame = marfSegment(makeFramePayload(frameInner, JSON.stringify({ guid: 'g', kind: 0 })));
  return Buffer.concat([header, main, frame]);
}

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpAclPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-v2frame-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'Airports', 'ZSJN', 'Levels', 'TEST_leisure_1.acl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

describe('encodeV2Archive — checkpoint frame edits persist', () => {
  it('round-trips a v2 archive with a decodable frame', () => {
    const p = tmpAclPath();
    fs.writeFileSync(p, makeV2Archive(MAIN_TEXT, frameText(['B-AAA', 'B-BBB'])));
    expect(getStorageVersion(fs.readFileSync(p))).toBe(2);

    const text = readAclText(p);
    expect(text.split(SENTINEL).length).toBe(2);
    expect(text).toContain('flight-plan:B-AAA');
    expect(text).toContain('flight-plan:B-BBB');
  });

  it('persists a removed runtime entity in the frame (was copied verbatim)', () => {
    const p = tmpAclPath();
    fs.writeFileSync(p, makeV2Archive(MAIN_TEXT, frameText(['B-AAA', 'B-BBB'])));
    const before = fs.readFileSync(p);

    const docs = readAclText(p).split(SENTINEL);
    // Rebuild the frame doc without B-BBB, exactly as _removeOrphanedFlightEntities would.
    docs[1] = frameText(['B-AAA']);
    writeAcl(p, docs.join('\r\n' + SENTINEL + '\r\n'), { format: 'binary' });

    const after = fs.readFileSync(p);
    expect(after.equals(before)).toBe(false); // frame bytes actually changed

    const reread = readAclText(p).split(SENTINEL);
    expect(reread[1]).not.toContain('flight-plan:B-BBB');
    expect(reread[1]).toContain('flight-plan:B-AAA');
    expect(reread[0]).toContain('TEST_leisure_1');
  });

  it('preserves a frame whose inner payload is not a checkpoint doc', () => {
    const p = tmpAclPath();
    const header = buildV2HeaderSegment('TEST_leisure_1', 'ZSJN');
    const main = buildV2MainSegment(encodeTextToPayload(MAIN_TEXT));
    const notCheckpoint = '{ "$id": 1, "$type": "0|Something.Else, X" }';
    const payload = makeFramePayload(notCheckpoint, JSON.stringify({ guid: 'g' }));
    fs.writeFileSync(p, Buffer.concat([header, main, marfSegment(payload)]));

    const rawBefore = parseV2Archive(fs.readFileSync(p)).frameMeta[0].raw;
    const docs = readAclText(p).split(SENTINEL);
    expect(docs.length).toBe(1); // frame not appended as an editable doc

    writeAcl(p, docs[0], { format: 'binary' });
    const rawAfter = parseV2Archive(fs.readFileSync(p)).frameMeta[0].raw;
    expect(rawAfter.equals(rawBefore)).toBe(true);
  });
});
