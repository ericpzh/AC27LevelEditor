/**
 * GATCARC4 v3 checkpoint-frame reconciliation persistence (1-to-1 counterpart to v2_frame_reconciliation.test.js).
 *
 * Drives the real save pipeline (`parser.generateFullAcl` / `openAclFile`) against
 * an isolated copy of the checked-in ZSJN v3 reference level (`ZSJN_leisure_1.acl`):
 *   1. Deleting a flight removes its `StaticItems["flight-plan:REG"]` AND reconciles
 *      checkpoint `RuntimeEntities` (`flight-plan:REG`, `aircraft:REG`,
 *      `aircraft-animator:aircraft:REG`, docked `jetway:*`, `EventQueue`, `ScoringStateEntity`,
 *      and `RecentMessages`), leaving zero `resolution-missing-leg` or `docked-missing-entity`
 *      issues.
 *   2. Deleting a docked departure flight cleanly undocks its `jetway:*` in the checkpoint frame.
 *   3. Renaming a flight's registration cascades across static & runtime flight-plan, aircraft,
 *      animator, and docked jetway references.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FIXTURES_GAME_ROOT_V3, v3LevelPath, v3GameLevelExists, isV3Acl, stageV3AudioIntoRoot } from '../helpers/gameRoot';

const require = createRequire(import.meta.url);
const parser = require('../../src/acl/parser');
const { openAclFile, detectAclFormat } = require('../../src/acl/archive');
const { buildApproachCache } = require('../../src/acl/approach');
const { getSchemaForHash } = require('../../src/acl/v3/schema_registry');
const { validateV3Container } = require('../../src/acl/v3/validator');
const {
  dictEntries,
  dictGet,
  indexDocumentGraph,
  resolveGraphNode,
  unwrapReactive,
} = require('../../src/acl/v3/graph');
const { analyzeAclFile, runChecks } = require('./gamecompat-utils.cjs');

const LEVEL = 'ZSJN_leisure_1.acl';
const ICAO = 'ZSJN';

const hasLevel = v3GameLevelExists(ICAO, LEVEL, null, null);
const srcPath = hasLevel ? v3LevelPath(ICAO, LEVEL, null, null) : null;
const isV3 = hasLevel && isV3Acl(srcPath);
const describeWithLevel = isV3 ? describe : describe.skip;

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Stage an isolated StreamingAssets layout in `os.tmpdir()` mirroring ZSJN's
 * metadata files so voice/language/profile normalization behaves identically to
 * a full game install.
 */
function tmpV3LevelCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-v3frame-real-'));
  tmpDirs.push(root);

  const saSrc = path.join(FIXTURES_GAME_ROOT_V3, 'GroundATC_Data', 'StreamingAssets');
  const saDst = path.join(root, 'GroundATC_Data', 'StreamingAssets');
  const airportSrc = path.join(saSrc, 'Airports', ICAO);
  const airportDst = path.join(saDst, 'Airports', ICAO);
  const levelDir = path.join(airportDst, 'Levels');
  const voicesDst = path.join(saDst, 'Voices');
  fs.mkdirSync(levelDir, { recursive: true });
  fs.mkdirSync(voicesDst, { recursive: true });

  for (const topFile of [
    'aircraft_profiles.csv',
    'aircraft_registration_rules.cfg',
    'airline_country_registry.cfg',
  ]) {
    const s = path.join(saSrc, topFile);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(saDst, topFile));
  }
  const vcSrc = path.join(saSrc, 'Voices', 'voice_catalog.json');
  if (fs.existsSync(vcSrc)) fs.copyFileSync(vcSrc, path.join(voicesDst, 'voice_catalog.json'));
  stageV3AudioIntoRoot(root, ICAO, FIXTURES_GAME_ROOT_V3);

  for (const apFile of [
    'airport_brief.json',
    'radio_template_en.csv',
    'radio_template_zh.csv',
    'stand_aircraft_compatibility.json',
    'stand_constraints.csv',
  ]) {
    const s = path.join(airportSrc, apFile);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(airportDst, apFile));
  }

  const dest = path.join(levelDir, LEVEL);
  fs.copyFileSync(srcPath, dest);
  for (const ext of ['.aclcfg', '.timeline.json']) {
    const side = srcPath.replace(/\.acl$/i, ext);
    if (fs.existsSync(side)) fs.copyFileSync(side, dest.replace(/\.acl$/i, ext));
  }
  return { root, dest, levelDir };
}

describeWithLevel(`v3 frame reconciliation — ${ICAO}/${LEVEL}`, () => {
  it('deleting a flight drops its stale runtime flight-plan entity from the frame', (ctx) => {
    const { dest, levelDir } = tmpV3LevelCopy();
    const approachCache = buildApproachCache(levelDir);

    const loaded = parser.loadFlights(dest);
    if (loaded.flights.length < 2) {
      ctx.skip(`fixture ${LEVEL} has ${loaded.flights.length} flight(s); needs >= 2`);
    }

    const beforeBuf = fs.readFileSync(dest);
    const removed = loaded.flights[0];
    const removedReg = removed._Registration || removed.Registration;
    const remaining = loaded.flights.filter((f) => f !== removed);

    parser.generateFullAcl(dest, remaining, undefined, undefined, undefined, undefined, approachCache, undefined, undefined);

    const afterBuf = fs.readFileSync(dest);
    expect(detectAclFormat(afterBuf)).toBe('gatcarc4-v3');
    expect(afterBuf.equals(beforeBuf)).toBe(false);

    const saved = openAclFile(dest, { validateOnOpen: true });
    validateV3Container(saved.container);

    // Every runtime plan in the frame must resolve to a static item, with 0 game-compat issues.
    const a = analyzeAclFile(dest);
    const check = runChecks(a);
    expect(check.issues.filter((i) => i.code === 'resolution-missing-leg')).toEqual([]);
    expect(check.issues).toEqual([]);

    if (removedReg) {
      const schema = getSchemaForHash(saved.header.schemaHash);
      const rtIdx = indexDocumentGraph(saved.container.frames[0].runtimeData, schema.roots.runtime, schema);
      const reDict = resolveGraphNode(saved.container.frames[0].runtimeData.RuntimeEntities, rtIdx);
      expect(dictGet(reDict, `flight-plan:${removedReg}`)).toBeUndefined();
      expect(dictGet(reDict, `aircraft:${removedReg}`)).toBeUndefined();
      expect(dictGet(reDict, `aircraft-animator:aircraft:${removedReg}`)).toBeUndefined();
    }
  });

  it('deleting a jetway-docked departure undocks its jetway and removes its runtime aircraft & animator', () => {
    const { dest, levelDir } = tmpV3LevelCopy();
    const approachCache = buildApproachCache(levelDir);

    const preHandle = openAclFile(dest);
    const preSchema = getSchemaForHash(preHandle.header.schemaHash);
    const preRtIdx = indexDocumentGraph(preHandle.container.frames[0].runtimeData, preSchema.roots.runtime, preSchema);
    const preReDict = resolveGraphNode(preHandle.container.frames[0].runtimeData.RuntimeEntities, preRtIdx);

    const preAnalysis = analyzeAclFile(dest);
    const dockedInfo = preAnalysis.frameDocked[0];
    expect(dockedInfo).toBeTruthy();
    const dockedReg = dockedInfo.reg;
    expect(dockedReg).toBeTruthy();

    const preAcObj = resolveGraphNode(dictGet(preReDict, `aircraft:${dockedReg}`), preRtIdx);
    let dockedJwKey = null;
    for (const [k, rawV] of dictEntries(preReDict)) {
      if (!k.startsWith('jetway:')) continue;
      const jw = resolveGraphNode(rawV, preRtIdx);
      if (resolveGraphNode(unwrapReactive(jw.DockingAircraft, preRtIdx), preRtIdx) === preAcObj) {
        dockedJwKey = k;
        break;
      }
    }
    expect(dockedJwKey).toBeTruthy();

    const loaded = parser.loadFlights(dest);
    const remaining = loaded.flights.filter(
      (f) => (f._Registration || f.Registration) !== dockedReg,
    );
    expect(remaining.length).toBeLessThan(loaded.flights.length);

    parser.generateFullAcl(dest, remaining, undefined, undefined, undefined, undefined, approachCache, undefined, undefined);

    const saved = openAclFile(dest, { validateOnOpen: true });
    const schema = getSchemaForHash(saved.header.schemaHash);
    const rtIdx = indexDocumentGraph(saved.container.frames[0].runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(saved.container.frames[0].runtimeData.RuntimeEntities, rtIdx);

    expect(dictGet(reDict, `flight-plan:${dockedReg}`)).toBeUndefined();
    expect(dictGet(reDict, `aircraft:${dockedReg}`)).toBeUndefined();
    expect(dictGet(reDict, `aircraft-animator:aircraft:${dockedReg}`)).toBeUndefined();

    // Unless another departure on that stand took over the jetway, it is undocked cleanly;
    // either way, it must NOT point to the deleted aircraft and gamecompat must report 0 issues.
    const jwObj = resolveGraphNode(dictGet(reDict, dockedJwKey), rtIdx);
    expect(jwObj).toBeTruthy();
    const postDockAc = resolveGraphNode(unwrapReactive(jwObj.DockingAircraft, rtIdx), rtIdx);
    if (!postDockAc) {
      expect(jwObj.Status).toBe(0);
      expect(unwrapReactive(jwObj.DockingDoorIndex, rtIdx)).toBe(-1);
    }

    const postAnalysis = analyzeAclFile(dest);
    expect(runChecks(postAnalysis).issues).toEqual([]);
  });

  it('renaming a docked flight registration cascades across StaticItems and checkpoint RuntimeEntities', () => {
    const { dest, levelDir } = tmpV3LevelCopy();
    const approachCache = buildApproachCache(levelDir);

    const preAnalysis = analyzeAclFile(dest);
    const [, dockedInfo] = [...preAnalysis.frameDocked.entries()][0];
    const oldReg = dockedInfo.reg;
    const newReg = 'B-RNV3';

    const loaded = parser.loadFlights(dest);
    const target = loaded.flights.find((f) => (f._Registration || f.Registration) === oldReg);
    expect(target).toBeTruthy();
    target._Registration = newReg;
    target.Registration = newReg;

    parser.generateFullAcl(dest, loaded.flights, undefined, undefined, undefined, undefined, approachCache, undefined, undefined);

    const saved = openAclFile(dest, { validateOnOpen: true });
    const schema = getSchemaForHash(saved.header.schemaHash);
    const stIdx = indexDocumentGraph(saved.container.staticData, schema.roots.static, schema);
    const siDict = resolveGraphNode(saved.container.staticData.StaticItems, stIdx);
    expect(dictGet(siDict, `flight-plan:${oldReg}`)).toBeUndefined();
    expect(dictGet(siDict, `flight-plan:${newReg}`)).toBeTruthy();

    const rtIdx = indexDocumentGraph(saved.container.frames[0].runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(saved.container.frames[0].runtimeData.RuntimeEntities, rtIdx);
    expect(dictGet(reDict, `flight-plan:${oldReg}`)).toBeUndefined();
    expect(dictGet(reDict, `aircraft:${oldReg}`)).toBeUndefined();
    expect(dictGet(reDict, `aircraft-animator:aircraft:${oldReg}`)).toBeUndefined();

    expect(dictGet(reDict, `flight-plan:${newReg}`)).toBeTruthy();
    expect(dictGet(reDict, `aircraft:${newReg}`)).toBeTruthy();
    expect(dictGet(reDict, `aircraft-animator:aircraft:${newReg}`)).toBeTruthy();

    expect(runChecks(analyzeAclFile(dest)).issues).toEqual([]);
  });
});
