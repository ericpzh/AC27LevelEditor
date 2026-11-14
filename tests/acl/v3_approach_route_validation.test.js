/**
 * @vitest-environment node
 *
 * GATCARC4 v3 Arrival Approach Route Validation & Scenery Procedure Preservation Suite.
 *
 * Covers `plan-v3-runway-timeline-membership.md` ("Ground Fuzz follow-up. Missing approach route on KJFK runway 6C"):
 *   - `writers_scenery.js`:
 *       * Preserves surviving procedure-to-runway associations across single and swap/chain renames
 *       * Emits structured warning `ground_painter_writer_procedure_dropped` when a procedure drops
 *         because `< 2` distinct usable airway nodes resolve (deleted node or co-located `<= 1e-6` GU)
 *   - Candidate-archive validator (`validateV3ApproachRoutes`):
 *       * Verifies directly against candidate `StaticData` (never satisfied by `approachCache` from other levels)
 *       * Rejects Ground Painter saves and ordinary v3 flight saves before touching `.acl`, `.acl.bak`, `.csv`, `.bg.json`, or `geo_data.osm`
 *       * Reports runway, missing approach (`RouteType = 1`), and affected arrival flights
 *       * Keeps departure-only runways valid without `RouteType = 1` approach routes
 *       * Allows explicit removal of affected arrivals before saving a runway without an approach
 *       * Leaves v2 behavior unchanged
 *   - `gamecompat-utils.cjs`:
 *       * Emits `arrival-missing-approach` on broken containers (`--replace` blocker) while `openAclFile` still opens them for repair
 *   - Disposable `KJFK_leisure_2` exact reproduction:
 *       * `4R/22L -> 6C/24` rename-only preserves `RNAV Y Rwy 4R` (`RouteType = 1`) and all 12 `SIE.CAMRM5` arrivals (`KAL1202` / `B-19O5`)
 *       * `4R/22L -> 6C/24` with `SIE.CAMRM5` intact & sole `RouteType = 1` approach removed (or 1 of its 2 nodes deleted) rejects cleanly with target untouched
 *       * Valid replacement `RouteType = 1` approach on `6C` restores clean save & gamecompat pass.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { GAME_ROOT, FIXTURES_GAME_ROOT_V3, levelPath, gameLevelExists, stageV3AudioIntoRoot } = require('../helpers/gameRoot.cjs');
const { openAclFile, detectAclFormat } = require('../../src/acl/archive');
const { encodeV3Container } = require('../../src/acl/v3/framing');
const { getSchemaForHash } = require('../../src/acl/v3/schema_registry');
const {
  ApproachValidationError,
  inspectV3RunwayApproachSupport,
  validateV3ApproachRoutes,
} = require('../../src/acl/v3/approach_validation');
const { saveV3GroundPainterData } = require('../../src/acl/v3/ground_painter_save');
import { runTripleValidation } from '../../src/utils/validators.js';
const { buildConstraints, validateFlightObjects } = require('../../electron/api-server');
const { analyzeAclFile, runChecks } = require('../integration/gamecompat-utils.cjs');
const parser = require('../../src/acl/parser');

const ZSJN_V3_DIR = path.join(
  FIXTURES_GAME_ROOT_V3,
  'GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels',
);

function resolveCleanKjfkLeisure2() {
  try {
    if (!gameLevelExists('KJFK', 'KJFK_leisure_2.acl')) return null;
    const mainPath = levelPath('KJFK', 'KJFK_leisure_2.acl');
    const bakPath = `${mainPath}.bak`;
    for (const candidate of [bakPath, mainPath]) {
      if (!fs.existsSync(candidate)) continue;
      const buf = fs.readFileSync(candidate);
      if (detectAclFormat(buf) !== 'gatcarc4-v3') continue;
      const h = openAclFile(candidate);
      const check = validateV3ApproachRoutes(h.container.staticData, h.container, { throwOnError: false });
      if (check.ok) return candidate;
    }
  } catch (_) {}
  return null;
}

const CLEAN_KJFK_LEISURE_2 = resolveCleanKjfkLeisure2();

const tmpDirs = [];
function makeTmpDir(prefix = 'ac27-v3-appr-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function stageTmpLevels(tmpDir, icao, sourceRoot = FIXTURES_GAME_ROOT_V3) {
  const tmpLevels = path.join(tmpDir, 'GroundATC_Data/StreamingAssets/Airports', icao, 'Levels');
  fs.mkdirSync(tmpLevels, { recursive: true });
  stageV3AudioIntoRoot(tmpDir, icao, sourceRoot);
  return tmpLevels;
}

function sha256File(fp) {
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

function renameRunwayEndInGraphAndMeta(graph, meta, oldEnd, newEnd, { preRemapProcs = true } = {}) {
  for (const rw of graph.runways || []) {
    if (Array.isArray(rw.names)) {
      rw.names = rw.names.map((n) => (n === oldEnd ? newEnd : n));
    }
    if (rw.name === oldEnd) rw.name = newEnd;
    if (typeof rw.physicalName === 'string' && rw.physicalName.includes('/')) {
      rw.physicalName = rw.physicalName
        .split('/')
        .map((p) => (p === oldEnd ? newEnd : p))
        .join('/');
    }
    for (const en of rw.entries || []) {
      if (en.runwayName === oldEnd) en.runwayName = newEnd;
    }
    for (const ex of rw.exits || []) {
      if (ex.runwayName === oldEnd) ex.runwayName = newEnd;
    }
  }
  if (preRemapProcs) {
    for (const p of graph.procedures || []) {
      if (p.runwayName === oldEnd) p.runwayName = newEnd;
    }
  }
  return { graph, meta };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
});

describe('v3 Arrival Approach Route Validation — Scenery Writer, Candidate Gate & Fixtures', () => {
  it('preserves STAR (RouteType=0) and APPR (RouteType=1) routes across runway rename-only (both pre-remapped and raw proc.runwayName)', () => {
    for (const preRemapProcs of [true, false]) {
      const tmpDir = makeTmpDir('ac27-zsjn-rename-');
      const tmpLevels = stageTmpLevels(tmpDir, 'ZSJN', FIXTURES_GAME_ROOT_V3);
      const dstAcl = path.join(tmpLevels, 'ZSJN_leisure_1.acl');
      fs.copyFileSync(path.join(ZSJN_V3_DIR, 'ZSJN_leisure_1.acl'), dstAcl);

      const approachCache = parser.buildApproachCache(ZSJN_V3_DIR);
      const snap = openAclFile(dstAcl).readSceneryGraph();
      const graph = cloneJson(snap.graph);
      const meta = cloneJson(snap.meta);
      renameRunwayEndInGraphAndMeta(graph, meta, '01', '06C', { preRemapProcs });

      const res = saveV3GroundPainterData(
        { filePath: dstAcl, graph, meta, createBackup: true },
        { getApproachCache: () => approachCache },
      );
      expect(res.purgedFlights).toEqual([]);
      expect(res.refsRemapped).toBeGreaterThan(0);

      const reloaded = openAclFile(dstAcl);
      const schema = getSchemaForHash(reloaded.header.schemaHash);
      const support = inspectV3RunwayApproachSupport(reloaded.container.staticData, schema);
      const rw6c = support.runways.get('06C');
      expect(rw6c).toBeTruthy();
      expect(rw6c.usableApproaches.length).toBeGreaterThanOrEqual(1);
      expect(rw6c.usableStars.size).toBeGreaterThanOrEqual(1);
      expect(validateV3ApproachRoutes(reloaded.container.staticData, schema).ok).toBe(true);

      const gc = runChecks(analyzeAclFile(dstAcl));
      expect(gc.issues.filter((i) => i.code === 'arrival-missing-approach')).toEqual([]);
      expect(gc.issues.filter((i) => i.code === 'runway-not-in-timeline')).toEqual([]);
    }
  });

  it('rejects Ground Painter save when sole RouteType=1 approach is removed while STAR and arrivals remain, leaving .acl/.bak/.csv/.bg.json untouched', () => {
    const tmpDir = makeTmpDir('ac27-zsjn-noappr-');
    const tmpLevels = stageTmpLevels(tmpDir, 'ZSJN', FIXTURES_GAME_ROOT_V3);
    const dstAcl = path.join(tmpLevels, 'ZSJN_leisure_1.acl');
    const bakAcl = `${dstAcl}.bak`;
    const csvSidecar = path.join(tmpLevels, 'flight_schedule_leisure_1.csv');
    const bgSidecar = `${dstAcl}.bg.json`;
    fs.copyFileSync(path.join(ZSJN_V3_DIR, 'ZSJN_leisure_1.acl'), dstAcl);
    fs.copyFileSync(dstAcl, bakAcl);
    fs.writeFileSync(csvSidecar, 'CallSign,Runway\nORIGINAL,01\n', 'utf8');
    fs.writeFileSync(bgSidecar, '{"src":"keep.png"}', 'utf8');

    const preAclSha = sha256File(dstAcl);
    const preBakSha = sha256File(bakAcl);
    const preCsvSha = sha256File(csvSidecar);
    const preBgSha = sha256File(bgSidecar);

    const approachCache = parser.buildApproachCache(ZSJN_V3_DIR);
    const snap = openAclFile(dstAcl).readSceneryGraph();
    const graph = cloneJson(snap.graph);
    const meta = cloneJson(snap.meta);

    // Rename 01 -> 06C while keeping STARs intact, and strip all RouteType === 1 approaches on 06C
    renameRunwayEndInGraphAndMeta(graph, meta, '01', '06C', { preRemapProcs: true });
    const keptProcs = [];
    const keptSegOrigPk = [];
    for (let i = 0; i < graph.procedures.length; i++) {
      const p = graph.procedures[i];
      if (p.runwayName === '06C' && Number(p.routeType) === 1) continue;
      keptProcs.push(p);
      keptSegOrigPk.push(meta.airwaySegOrigPk[i]);
    }
    graph.procedures = keptProcs;
    meta.airwaySegOrigPk = keptSegOrigPk;

    let caught = null;
    try {
      saveV3GroundPainterData(
        {
          filePath: dstAcl,
          graph,
          meta,
          createBackup: true,
          bg: { src: 'mutated.png' },
        },
        { getApproachCache: () => approachCache },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApproachValidationError);
    expect(caught.code).toBe('V3_MISSING_APPROACH_ROUTE');
    expect(caught.message).toContain('06C');
    expect(caught.issues.length).toBeGreaterThan(0);
    expect(caught.issues.every((i) => i.runway === '06C' && i.reason === 'missing_approach')).toBe(true);

    // Disk target, backup, CSV, and .bg.json sidecar must be completely untouched
    expect(sha256File(dstAcl)).toBe(preAclSha);
    expect(sha256File(bakAcl)).toBe(preBakSha);
    expect(sha256File(csvSidecar)).toBe(preCsvSha);
    expect(sha256File(bgSidecar)).toBe(preBgSha);
  });

  it('emits structured ground_painter_writer_procedure_dropped warning and rejects save when an approach is broken (< 2 nodes or co-located nodes)', () => {
    // Subcase A: procedure left with only 1 airwayNodeIdx
    {
      const tmpDir = makeTmpDir('ac27-zsjn-shortappr-');
      const dstAcl = path.join(tmpDir, 'ZSJN_leisure_1.acl');
      fs.copyFileSync(path.join(ZSJN_V3_DIR, 'ZSJN_leisure_1.acl'), dstAcl);

      const h = openAclFile(dstAcl);
      const snap = h.readSceneryGraph();
      const graph = cloneJson(snap.graph);
      const meta = cloneJson(snap.meta);

      const apprProcsOn01 = graph.procedures.filter((p) => p.runwayName === '01' && Number(p.routeType) === 1);
      expect(apprProcsOn01.length).toBeGreaterThan(0);
      for (const p of apprProcsOn01) {
        p.airwayNodeIdxs = p.airwayNodeIdxs.slice(0, 1);
      }

      const scenRes = h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta, filePath: dstAcl });
      const dropWarns = (scenRes.warnings || []).filter((w) => w.key === 'ground_painter_writer_procedure_dropped');
      expect(dropWarns.length).toBe(apprProcsOn01.length);
      expect(dropWarns[0].params).toMatchObject({
        runway: '01',
        routeType: 1,
        resolvedCount: 1,
      });

      expect(() =>
        saveV3GroundPainterData({ filePath: dstAcl, graph, meta, createBackup: false }),
      ).toThrow(ApproachValidationError);
    }

    // Subcase B: 2 airway nodes collapsed to identical XZ coordinates (<= 1e-6 GU apart)
    {
      const tmpDir = makeTmpDir('ac27-zsjn-coloc-');
      const dstAcl = path.join(tmpDir, 'ZSJN_leisure_1.acl');
      fs.copyFileSync(path.join(ZSJN_V3_DIR, 'ZSJN_leisure_1.acl'), dstAcl);

      const h = openAclFile(dstAcl);
      const snap = h.readSceneryGraph();
      const graph = cloneJson(snap.graph);
      const meta = cloneJson(snap.meta);

      // Replace all RouteType=1 on 01 with a 2-node procedure whose two new airway nodes are co-located
      const keptProcs = [];
      const keptSegOrigPk = [];
      for (let i = 0; i < graph.procedures.length; i++) {
        const p = graph.procedures[i];
        if (p.runwayName === '01' && Number(p.routeType) === 1) continue;
        keptProcs.push(p);
        keptSegOrigPk.push(meta.airwaySegOrigPk[i]);
      }
      const nIdxA = graph.airwayNodes.length;
      const nIdxB = nIdxA + 1;
      graph.airwayNodes.push({ x: 12.5, z: -30.25, name: 'COLOC_A' });
      graph.airwayNodes.push({ x: 12.5, z: -30.25, name: 'COLOC_B' });
      meta.airwayNodeOrigPk.push(null, null);
      keptProcs.push({
        name: 'BROKEN_COLOC_APPR',
        runwayName: '01',
        routeType: 1,
        airwayNodeIdxs: [nIdxA, nIdxB],
      });
      keptSegOrigPk.push(null);
      graph.procedures = keptProcs;
      meta.airwaySegOrigPk = keptSegOrigPk;

      const scenRes = h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta, filePath: dstAcl });
      expect(
        (scenRes.warnings || []).some(
          (w) => w.key === 'ground_painter_writer_procedure_dropped' && w.params?.name === 'BROKEN_COLOC_APPR',
        ),
      ).toBe(true);

      expect(() =>
        saveV3GroundPainterData({ filePath: dstAcl, graph, meta, createBackup: false }),
      ).toThrow(ApproachValidationError);
    }
  });

  it('accepts a valid replacement RouteType=1 approach (>= 2 distinct finite airway nodes) and keeps departure-only runways valid without approaches', () => {
    const tmpDir = makeTmpDir('ac27-zsjn-replace-appr-');
    const tmpLevels = stageTmpLevels(tmpDir, 'ZSJN', FIXTURES_GAME_ROOT_V3);
    const dstAcl = path.join(tmpLevels, 'ZSJN_leisure_1.acl');
    fs.copyFileSync(path.join(ZSJN_V3_DIR, 'ZSJN_leisure_1.acl'), dstAcl);

    const approachCache = parser.buildApproachCache(ZSJN_V3_DIR);
    const snap = openAclFile(dstAcl).readSceneryGraph();
    const graph = cloneJson(snap.graph);
    const meta = cloneJson(snap.meta);

    // Strip all original RouteType=1 procedures on BOTH 01 and 19:
    //   - Add a valid replacement RouteType=1 approach on 01 (which has arrivals)
    //   - Leave 19 WITHOUT any RouteType=1 approach (19 has zero arrivals in ZSJN_leisure_1 -> departure-only / unused)
    const keptProcs = [];
    const keptSegOrigPk = [];
    for (let i = 0; i < graph.procedures.length; i++) {
      const p = graph.procedures[i];
      if (Number(p.routeType) === 1) continue;
      keptProcs.push(p);
      keptSegOrigPk.push(meta.airwaySegOrigPk[i]);
    }
    const baseNode = graph.airwayNodes[0] || { x: 0, z: -20 };
    const idx1 = graph.airwayNodes.length;
    const idx2 = idx1 + 1;
    graph.airwayNodes.push({ x: baseNode.x + 2, z: baseNode.z - 8, name: 'FAF01' });
    graph.airwayNodes.push({ x: baseNode.x, z: baseNode.z, name: 'MAP01' });
    meta.airwayNodeOrigPk.push(null, null);
    keptProcs.push({
      name: 'RNAV Z Rwy 01',
      runwayName: '01',
      routeType: 1,
      airwayNodeIdxs: [idx1, idx2],
    });
    keptSegOrigPk.push(null);
    graph.procedures = keptProcs;
    meta.airwaySegOrigPk = keptSegOrigPk;

    const res = saveV3GroundPainterData(
      { filePath: dstAcl, graph, meta, createBackup: false },
      { getApproachCache: () => approachCache },
    );
    expect(res.purgedFlights).toEqual([]);

    const reloaded = openAclFile(dstAcl);
    const support = inspectV3RunwayApproachSupport(
      reloaded.container.staticData,
      getSchemaForHash(reloaded.header.schemaHash),
    );
    expect(support.runways.get('01').usableApproaches.map((a) => a.name)).toEqual(['RNAV Z Rwy 01']);
    expect(support.runways.get('19').usableApproaches).toEqual([]);
    expect(validateV3ApproachRoutes(reloaded.container.staticData, reloaded.container).ok).toBe(true);
  });

  it('cannot be satisfied by cached approaches from other levels during ordinary v3 flight saves, while allowing explicit arrival removal', () => {
    const tmpDir = makeTmpDir('ac27-zsjn-nocache-bypass-');
    const dstAcl = path.join(tmpDir, 'ZSJN_leisure_1.acl');
    fs.copyFileSync(path.join(ZSJN_V3_DIR, 'ZSJN_leisure_1.acl'), dstAcl);

    // Build an approachCache from unmodified ZSJN_V3_DIR (which DOES contain approaches for "01")
    const otherLevelsApproachCache = parser.buildApproachCache(ZSJN_V3_DIR);
    expect(otherLevelsApproachCache.appPointMap.size).toBeGreaterThan(0);

    // First remove all arrivals so we can save a departure-only level with no RouteType=1 on "01"
    const h1 = openAclFile(dstAcl);
    const { flights: origFlights } = h1.readFlights(dstAcl);
    const depOnlyFlights = origFlights.filter((f) => f.isDeparture);
    const sampleArrival = origFlights.find((f) => !f.isDeparture);
    expect(sampleArrival).toBeTruthy();

    h1.applyEdits({ flights: depOnlyFlights, approachCache: otherLevelsApproachCache, filePath: dstAcl });
    h1.saveToFile(dstAcl, { createBackup: false });

    // Strip RouteType=1 from "01" — succeeds because only departures remain!
    const snap = openAclFile(dstAcl).readSceneryGraph();
    const graph = cloneJson(snap.graph);
    const meta = cloneJson(snap.meta);
    const keptProcs = [];
    const keptSegOrigPk = [];
    for (let i = 0; i < graph.procedures.length; i++) {
      if (graph.procedures[i].runwayName === '01' && Number(graph.procedures[i].routeType) === 1) continue;
      keptProcs.push(graph.procedures[i]);
      keptSegOrigPk.push(meta.airwaySegOrigPk[i]);
    }
    graph.procedures = keptProcs;
    meta.airwaySegOrigPk = keptSegOrigPk;
    saveV3GroundPainterData({ filePath: dstAcl, graph, meta, createBackup: false });

    // Now attempt an ordinary v3 flight save (`applyEdits` + `saveToFile`) adding `sampleArrival` back
    // while passing `otherLevelsApproachCache` (which has cached approaches for "01" from other levels).
    // Candidate `StaticData` on `dstAcl` still lacks RouteType=1 on "01", so `saveToFile` MUST reject!
    const preSha = sha256File(dstAcl);
    const h2 = openAclFile(dstAcl);
    h2.applyEdits({
      flights: [...depOnlyFlights, sampleArrival],
      approachCache: otherLevelsApproachCache,
      filePath: dstAcl,
    });
    expect(() => h2.saveToFile(dstAcl, { createBackup: true })).toThrow(ApproachValidationError);
    expect(sha256File(dstAcl)).toBe(preSha);
    expect(fs.existsSync(`${dstAcl}.bak`)).toBe(false);
  });

  it('flags missing-approach arrivals in v3 editor & MCP validation (leaving v2 unchanged) and in gamecompat decoded-output checks while keeping broken files openable', () => {
    const makeAv = (isV3) => ({
      ZSJN: {
        _isV3: isV3,
        ...(isV3 ? { _v3Audio: true } : {}),
        AirlineCode: ['CES'],
        AirlineName: ['CES'],
        AircraftType: ['AIRBUS A-320neo'],
        DepartureAirport: ['ZSPD'],
        Stand: ['1'],
        Runway: ['01', '19'],
        Airway: ['WFG91A'],
        Voice: ['v_zh_1'],
        Language: ['zh'],
        _voiceLanguages: { v_zh_1: 'zh' },
        _airlineCountries: { CES: 'CN' },
        _flightNums: { CES: ['5101'] },
        _compat: { airlineToAircraft: { CES: ['AIRBUS A-320neo'] } },
        _registrationMap: { 'CES|AIRBUS A-320neo': ['B-3001'] },
        _runwayStarMap: { '01': ['WFG91A'] },
        _starRunwayMap: { WFG91A: ['01'] },
        // Runway 01 has a STAR, but NO usable RouteType=1 approach!
        _liveUsableApprRunways: ['19'],
      },
    });
    const arrOn01 = [{
      CallSign: 'CES5101',
      AirlineName: 'CES',
      AircraftType: 'AIRBUS A-320neo',
      Registration: 'B-3001',
      DepartureAirport: 'ZSPD',
      Stand: '1',
      Runway: '01',
      Airway: 'WFG91A',
      LandingTime: '05:50:00',
      InBlockTime: '05:56:00',
      Voice: 'v_zh_1',
      Language: 'zh',
      isDeparture: false,
    }];
    const tl = { initialRunways: ['01', '19'], timeline: [] };

    // v3 flags missing approach in both editor and MCP
    const v3EditorIssues = runTripleValidation(arrOn01, makeAv(true), 'ZSJN', null, null, '05:35:00', '06:30:00', tl);
    expect(v3EditorIssues.length).toBe(1);
    expect(v3EditorIssues[0]).toContain('CES5101');
    expect(v3EditorIssues[0]).toContain('01');

    const v3Mcp = buildConstraints({
      currentAirport: 'ZSJN',
      airportValues: makeAv(true),
      _configStartTime: '05:35:00',
      _configEndTime: '06:30:00',
      runwayTimeline: tl,
    }, null);
    const mcpErrs = validateFlightObjects([], arrOn01, v3Mcp);
    expect(mcpErrs && mcpErrs.some((e) => e.issue === 'runway_missing_approach' && e.value === '01')).toBe(true);

    // v2 leaves behavior unchanged
    expect(runTripleValidation(arrOn01, makeAv(false), 'ZSJN', null, null, '05:35:00', '06:30:00', tl)).toEqual([]);
    const v2Mcp = buildConstraints({
      currentAirport: 'ZSJN',
      airportValues: makeAv(false),
      _configStartTime: '05:35:00',
      _configEndTime: '06:30:00',
      runwayTimeline: tl,
    }, null);
    expect(validateFlightObjects([], arrOn01, v2Mcp)).toBeNull();

    // Gamecompat decoded-output gate flags raw broken container while openAclFile still opens it for repair
    const tmpDir = makeTmpDir('ac27-zsjn-gc-gate-');
    const brokenPath = path.join(tmpDir, 'broken_no_appr.acl');
    fs.copyFileSync(path.join(ZSJN_V3_DIR, 'ZSJN_leisure_1.acl'), brokenPath);
    const h = openAclFile(brokenPath);
    const snap = h.readSceneryGraph();
    const graph = cloneJson(snap.graph);
    const meta = cloneJson(snap.meta);
    const keptProcs = [];
    const keptSegOrigPk = [];
    for (let i = 0; i < graph.procedures.length; i++) {
      if (graph.procedures[i].runwayName === '01' && Number(graph.procedures[i].routeType) === 1) continue;
      keptProcs.push(graph.procedures[i]);
      keptSegOrigPk.push(meta.airwaySegOrigPk[i]);
    }
    graph.procedures = keptProcs;
    meta.airwaySegOrigPk = keptSegOrigPk;
    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta, filePath: brokenPath });
    fs.writeFileSync(brokenPath, encodeV3Container(h.container));

    const reopened = openAclFile(brokenPath, { validateOnOpen: true });
    expect(reopened.format).toBe('gatcarc4-v3');
    const gc = runChecks(analyzeAclFile(brokenPath));
    expect(gc.issues.some((i) => i.code === 'arrival-missing-approach')).toBe(true);
  });
});

describe.runIf(Boolean(CLEAN_KJFK_LEISURE_2))('v3 Arrival Approach Route Validation — Disposable KJFK_leisure_2 (4R -> 6C) Reproduction', () => {
  it('rename-only (4R/22L -> 6C/24, plus swap/chain 4L/22R -> 4R/22L) preserves RNAV Y Rwy 4R and all 12 SIE.CAMRM5 arrivals including KAL1202 (B-19O5)', () => {
    const tmpDir = makeTmpDir('ac27-kjfk-l2-rename-');
    const tmpLevels = stageTmpLevels(tmpDir, 'KJFK', GAME_ROOT);
    const dstAcl = path.join(tmpLevels, 'KJFK_leisure_2.acl');
    fs.copyFileSync(CLEAN_KJFK_LEISURE_2, dstAcl);

    const approachCache = parser.buildApproachCache(path.dirname(CLEAN_KJFK_LEISURE_2));
    const snap = openAclFile(dstAcl).readSceneryGraph();
    const graph = cloneJson(snap.graph);
    const meta = cloneJson(snap.meta);

    // Perform simultaneous chain rename: 4R/22L -> 6C/24 AND 4L/22R -> 4R/22L
    for (const rw of graph.runways) {
      if (Array.isArray(rw.names) && rw.names[0] === '4R' && rw.names[1] === '22L') {
        rw.names = ['6C', '24'];
        rw.name = '6C';
        rw.physicalName = '6C/24';
        for (const en of rw.entries || []) {
          if (en.runwayName === '4R') en.runwayName = '6C';
          else if (en.runwayName === '22L') en.runwayName = '24';
        }
        for (const ex of rw.exits || []) {
          if (ex.runwayName === '4R') ex.runwayName = '6C';
          else if (ex.runwayName === '22L') ex.runwayName = '24';
        }
      } else if (Array.isArray(rw.names) && rw.names[0] === '4L' && rw.names[1] === '22R') {
        rw.names = ['4R', '22R'];
        rw.name = '4R';
        rw.physicalName = '4R/22R';
        for (const en of rw.entries || []) {
          if (en.runwayName === '4L') en.runwayName = '4R';
        }
        for (const ex of rw.exits || []) {
          if (ex.runwayName === '4L') ex.runwayName = '4R';
        }
      }
    }
    // Pre-remap procedures in a single pass (matching UI `_boundRunwayEnd` / MCP single-pass update)
    for (const p of graph.procedures) {
      if (p.runwayName === '4R') p.runwayName = '6C';
      else if (p.runwayName === '22L') p.runwayName = '24';
      else if (p.runwayName === '4L') p.runwayName = '4R';
    }

    const res = saveV3GroundPainterData(
      { filePath: dstAcl, graph, meta, createBackup: true },
      { getApproachCache: () => approachCache },
    );
    expect(res.purgedFlights).toEqual([]);

    const reloaded = openAclFile(dstAcl);
    const schema = getSchemaForHash(reloaded.header.schemaHash);
    const support = inspectV3RunwayApproachSupport(reloaded.container.staticData, schema);
    const rw6c = support.runways.get('6C');
    expect(rw6c).toBeTruthy();
    expect(rw6c.usableStars.has('SIE.CAMRM5')).toBe(true);
    expect(rw6c.usableApproaches.some((a) => a.name === 'RNAV Y Rwy 4R' && a.points.length >= 2)).toBe(true);

    // Verify 4L's procedures landed on 4R (NOT double-remapped onto 6C!)
    const rw4r = support.runways.get('4R');
    expect(rw4r).toBeTruthy();
    expect(rw4r.usableApproaches.some((a) => a.name.includes('4L'))).toBe(true);

    const { flights: savedFlights } = reloaded.readFlights(dstAcl);
    const arrOn6c = savedFlights.filter((f) => !f.isDeparture && f.Runway === '6C');
    expect(arrOn6c.length).toBe(12);
    expect(arrOn6c.some((f) => f.CallSign === 'KAL1202' && f._Registration === 'B-19O5' && f.Stand === 'it4-A7')).toBe(true);

    const gc = runChecks(analyzeAclFile(dstAcl));
    expect(gc.issues.filter((i) => i.code === 'arrival-missing-approach')).toEqual([]);
    expect(gc.issues.filter((i) => i.code === 'runway-not-in-timeline')).toEqual([]);
  });

  it('deterministic regression: 4R -> 6C with SIE.CAMRM5 intact and sole RouteType=1 approach removed rejects save, names 6C + KAL1202 (B-19O5), and leaves target intact; valid replacement approach restores save', () => {
    const tmpDir = makeTmpDir('ac27-kjfk-l2-repro-');
    const tmpLevels = stageTmpLevels(tmpDir, 'KJFK', GAME_ROOT);
    const dstAcl = path.join(tmpLevels, 'KJFK_leisure_2.acl');
    const bakAcl = `${dstAcl}.bak`;
    const csvSidecar = path.join(tmpLevels, 'flight_schedule_leisure_2.csv');
    fs.copyFileSync(CLEAN_KJFK_LEISURE_2, dstAcl);
    fs.copyFileSync(CLEAN_KJFK_LEISURE_2, bakAcl);
    fs.writeFileSync(csvSidecar, 'CallSign,Runway\nKAL1202,4R\n', 'utf8');

    const preAclSha = sha256File(dstAcl);
    const preBakSha = sha256File(bakAcl);
    const preCsvSha = sha256File(csvSidecar);

    const approachCache = parser.buildApproachCache(path.dirname(CLEAN_KJFK_LEISURE_2));
    const snap = openAclFile(dstAcl).readSceneryGraph();
    const graph = cloneJson(snap.graph);
    const meta = cloneJson(snap.meta);

    // Rename 4R/22L -> 6C/24, keep SIE.CAMRM5 intact, remove RNAV Y Rwy 4R (sole RouteType=1 on 6C)
    renameRunwayEndInGraphAndMeta(graph, meta, '4R', '6C', { preRemapProcs: true });
    renameRunwayEndInGraphAndMeta(graph, meta, '22L', '24', { preRemapProcs: true });

    let removedApprNodes = null;
    const keptProcs = [];
    const keptSegOrigPk = [];
    for (let i = 0; i < graph.procedures.length; i++) {
      const p = graph.procedures[i];
      if (p.runwayName === '6C' && Number(p.routeType) === 1) {
        removedApprNodes = p.airwayNodeIdxs.map((idx) => ({ ...graph.airwayNodes[idx] }));
        continue;
      }
      keptProcs.push(p);
      keptSegOrigPk.push(meta.airwaySegOrigPk[i]);
    }
    expect(removedApprNodes && removedApprNodes.length >= 2).toBe(true);
    graph.procedures = keptProcs;
    meta.airwaySegOrigPk = keptSegOrigPk;

    let caught = null;
    try {
      saveV3GroundPainterData(
        { filePath: dstAcl, graph, meta, createBackup: true },
        { getApproachCache: () => approachCache },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApproachValidationError);
    expect(caught.code).toBe('V3_MISSING_APPROACH_ROUTE');
    expect(caught.message).toContain('6C');
    expect(caught.message).toContain('12 affected arrival flight(s)');
    expect(caught.issues.length).toBe(12);
    expect(caught.issues.some((i) => i.callsign === 'KAL1202' && i.registration === 'B-19O5' && i.runway === '6C' && i.star === 'SIE.CAMRM5')).toBe(true);

    // Target .acl, .acl.bak, and .csv are completely unchanged
    expect(sha256File(dstAcl)).toBe(preAclSha);
    expect(sha256File(bakAcl)).toBe(preBakSha);
    expect(sha256File(csvSidecar)).toBe(preCsvSha);

    // Restoring a valid replacement RouteType=1 approach on 6C allows save to succeed with all 12 arrivals intact!
    const nIdx1 = graph.airwayNodes.length;
    const nIdx2 = nIdx1 + 1;
    graph.airwayNodes.push({ x: removedApprNodes[0].x, z: removedApprNodes[0].z, name: 'FAF6C' });
    graph.airwayNodes.push({ x: removedApprNodes[1].x, z: removedApprNodes[1].z, name: 'MAP6C' });
    meta.airwayNodeOrigPk.push(null, null);
    graph.procedures.push({
      name: 'RNAV Z Rwy 6C',
      runwayName: '6C',
      routeType: 1,
      airwayNodeIdxs: [nIdx1, nIdx2],
    });
    meta.airwaySegOrigPk.push(null);

    const saved = saveV3GroundPainterData(
      { filePath: dstAcl, graph, meta, createBackup: true },
      { getApproachCache: () => approachCache },
    );
    expect(saved.purgedFlights).toEqual([]);

    const postHandle = openAclFile(dstAcl);
    const { flights: postFlights } = postHandle.readFlights(dstAcl);
    expect(postFlights.filter((f) => !f.isDeparture && f.Runway === '6C').length).toBe(12);
    const postGc = runChecks(analyzeAclFile(dstAcl));
    expect(postGc.issues.filter((i) => i.code === 'arrival-missing-approach')).toEqual([]);
  });
});
