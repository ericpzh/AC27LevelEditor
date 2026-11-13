/**
 * GATCARC4 v3 checkpoint-frame edit persistence (1-to-1 counterpart to gatcarc_v2_frame_edit.test.js).
 *
 * Verifies that `parseV3Container` + `encodeV3Container`:
 *   1. Re-emits byte-identical archives when no section is marked dirty.
 *   2. Re-encodes `MARF` v3 checkpoint frames (`dirtyRuntimeData`, `dirtyMessages`,
 *      `dirtySummary`) with updated outer wrapper lengths, inner SHA-256 digests,
 *      and `NODF` commit markers while preserving untouched `Header` and `LevelPayload`
 *      byte slices verbatim.
 *   3. Reuses untouched `frames[0].rawFrameBytes` byte-for-byte when only `MetaData`
 *      is modified (`dirtyMetaData = true`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FIXTURES_GAME_ROOT_V3 } from '../helpers/gameRoot';

const require = createRequire(import.meta.url);
const { detectAclFormat, openAclFile } = require('../../src/acl/archive');
const { parseV3Container, encodeV3Container } = require('../../src/acl/v3/framing');
const { getSchemaForHash } = require('../../src/acl/v3/schema_registry');
const { validateV3Container } = require('../../src/acl/v3/validator');
const {
  dictEntries,
  dictGet,
  dictDelete,
  indexDocumentGraph,
  resolveGraphNode,
  unwrapReactive,
  makeReactive,
  normalizeDocumentGraph,
} = require('../../src/acl/v3/graph');

const ZSJN_LEISURE_1 = path.join(
  FIXTURES_GAME_ROOT_V3,
  'GroundATC_Data',
  'StreamingAssets',
  'Airports',
  'ZSJN',
  'Levels',
  'ZSJN_leisure_1.acl',
);

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpAclPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-v3frame-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'Airports', 'ZSJN', 'Levels', 'ZSJN_leisure_1.acl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

describe('encodeV3Container — checkpoint frame edits persist', () => {
  it('round-trips a v3 archive with a decodable MARF v3 frame byte-identically when clean', () => {
    const srcBuf = fs.readFileSync(ZSJN_LEISURE_1);
    expect(detectAclFormat(srcBuf)).toBe('gatcarc4-v3');

    const parsed = parseV3Container(srcBuf);
    expect(parsed.frames.length).toBeGreaterThanOrEqual(1);
    expect(parsed.frames[0].version).toBe(3);

    validateV3Container(parsed);

    const reencoded = encodeV3Container(parsed);
    expect(reencoded.equals(srcBuf)).toBe(true);
  });

  it('persists a removed runtime flight entity set in the frame while keeping LevelPayload bytes untouched', () => {
    const p = tmpAclPath();
    const srcBuf = fs.readFileSync(ZSJN_LEISURE_1);
    fs.writeFileSync(p, srcBuf);

    const parsed = parseV3Container(srcBuf);
    const schema = getSchemaForHash(parsed.header.schemaHash);
    const frame = parsed.frames[0];
    const rtIdx = indexDocumentGraph(frame.runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(frame.runtimeData.RuntimeEntities, rtIdx);
    frame.runtimeData.RuntimeEntities = reDict;

    // Collect all $id targets referenced outside RuntimeEntities and by jetways
    // so we pick a runtime flight entity set (flight-plan, aircraft, animator)
    // that can be excised without leaving dangling $iref links in EventQueue/ScoringState.
    const externalRefs = new Set();
    const collectRefs = (node, skipDict = false) => {
      if (!node || typeof node !== 'object') return;
      if (skipDict && node === reDict) return;
      if (typeof node.$iref === 'number' || typeof node.$iref === 'string') {
        externalRefs.add(String(node.$iref));
      }
      if (Array.isArray(node)) {
        for (const el of node) collectRefs(el, skipDict);
        return;
      }
      for (const v of Object.values(node)) collectRefs(v, skipDict);
    };
    collectRefs(frame.runtimeData, true);
    for (const [k, rawV] of dictEntries(reDict)) {
      if (
        k.startsWith('flight-plan:') ||
        k.startsWith('aircraft:') ||
        k.startsWith('aircraft-animator:')
      ) {
        continue;
      }
      collectRefs(resolveGraphNode(rawV, rtIdx), false);
    }

    let targetReg = null;
    for (const [k, rawV] of dictEntries(reDict)) {
      if (!k.startsWith('flight-plan:')) continue;
      const reg = k.slice('flight-plan:'.length);
      const fpObj = resolveGraphNode(rawV, rtIdx);
      const acObj = resolveGraphNode(dictGet(reDict, `aircraft:${reg}`), rtIdx);
      const animObj = resolveGraphNode(dictGet(reDict, `aircraft-animator:aircraft:${reg}`), rtIdx);
      const ids = [fpObj?.$id, acObj?.$id, animObj?.$id].filter((x) => x != null).map(String);
      if (ids.every((id) => !externalRefs.has(id))) {
        targetReg = reg;
        break;
      }
    }
    expect(targetReg).toBeTruthy();

    dictDelete(reDict, `flight-plan:${targetReg}`);
    dictDelete(reDict, `aircraft:${targetReg}`);
    dictDelete(reDict, `aircraft-animator:aircraft:${targetReg}`);
    frame.runtimeData = normalizeDocumentGraph(
      frame.runtimeData,
      schema.roots.runtime,
      schema,
      rtIdx,
    );
    frame.dirtyRuntimeData = true;

    const rawHeaderBefore = Buffer.from(parsed.rawHeaderSegment);
    const rawMainBefore = Buffer.from(parsed.rawMainSegment);
    const rawFrameBefore = Buffer.from(frame.rawFrameBytes);

    validateV3Container(parsed);
    const outBuf = encodeV3Container(parsed);
    fs.writeFileSync(p, outBuf);

    expect(outBuf.equals(srcBuf)).toBe(false);

    const reparsed = parseV3Container(fs.readFileSync(p));
    validateV3Container(reparsed);

    // Header and LevelPayload segments were preserved byte-for-byte
    expect(reparsed.rawHeaderSegment.equals(rawHeaderBefore)).toBe(true);
    expect(reparsed.rawMainSegment.equals(rawMainBefore)).toBe(true);
    // Frame bytes changed and persisted the deletion
    expect(reparsed.frames[0].rawFrameBytes.equals(rawFrameBefore)).toBe(false);

    const postIdx = indexDocumentGraph(reparsed.frames[0].runtimeData, schema.roots.runtime, schema);
    const postRe = resolveGraphNode(reparsed.frames[0].runtimeData.RuntimeEntities, postIdx);
    expect(dictGet(postRe, `flight-plan:${targetReg}`)).toBeUndefined();
    expect(dictGet(postRe, `aircraft:${targetReg}`)).toBeUndefined();
    expect(dictGet(postRe, `aircraft-animator:aircraft:${targetReg}`)).toBeUndefined();

    // Also re-opens cleanly through the editor facade
    const handle = openAclFile(p, { validateOnOpen: true });
    expect(handle.format).toBe('gatcarc4-v3');
    expect(handle.storageVersion).toBe(3);
  });

  it('reuses untouched MARF frame bytes verbatim when only MetaData is edited', () => {
    const srcBuf = fs.readFileSync(ZSJN_LEISURE_1);
    const parsed = parseV3Container(srcBuf);
    const rawFrameBefore = Buffer.from(parsed.frames[0].rawFrameBytes);
    const rawStaticBase64Before = parsed.rawStaticBase64;

    parsed.metaData.Config.endTime = '06:20:00';
    parsed.dirtyMetaData = true;

    validateV3Container(parsed);
    const outBuf = encodeV3Container(parsed);
    const reparsed = parseV3Container(outBuf);
    validateV3Container(reparsed);

    expect(reparsed.metaData.Config.endTime).toBe(parsed.metaData.Config.endTime);
    expect(reparsed.rawStaticBase64).toBe(rawStaticBase64Before);
    expect(reparsed.frames[0].rawFrameBytes.equals(rawFrameBefore)).toBe(true);
  });

  it('persists RecentMessages edits while reusing rawSummaryBlock and rawRuntimeBase64', () => {
    const srcBuf = fs.readFileSync(ZSJN_LEISURE_1);
    const parsed = parseV3Container(srcBuf);
    const frame = parsed.frames[0];
    const origSummaryBlock = Buffer.from(frame.rawSummaryBlock);
    const origRuntimeB64 = frame.rawRuntimeBase64;

    frame.recentMessages = [];
    frame.dirtyMessages = true;

    validateV3Container(parsed);
    const outBuf = encodeV3Container(parsed);
    const reparsed = parseV3Container(outBuf);
    validateV3Container(reparsed);

    expect(reparsed.frames[0].recentMessages).toEqual([]);
    expect(reparsed.frames[0].rawSummaryBlock.equals(origSummaryBlock)).toBe(true);
    expect(reparsed.frames[0].rawRuntimeBase64).toBe(origRuntimeB64);
  });
});
