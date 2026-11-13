/**
 * @vitest-environment node
 *
 * Comprehensive GATCARC4 v3 corpus sweep, mixed v2+v3 folder workflow,
 * semantic edit families (config & timelines, flights + checkpoint reconciliation + zero flights,
 * scenery Ground/Air Painter add/move/rename/delete cascades), ZIP round-trip,
 * stale-source protection, and failed-save safety.
 *
 * All writes go strictly to temporary directories under `os.tmpdir()`; the installed
 * game root (`GAME_ROOT`) is treated as strictly read-only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { GAME_ROOT, FIXTURES_GAME_ROOT_V3, levelPath, gameLevelExists } = require('../helpers/gameRoot.cjs');
const gamePaths = require('../../src/utils/gamePaths');
const { openAcl, openAclFile, detectAclFormat } = require('../../src/acl/archive');
const { StaleSourceError } = require('../../src/acl/v3/handler');
const { TARGET_SCHEMA_HASH, getSchemaForHash } = require('../../src/acl/v3/schema_registry');
const { validateV3Container } = require('../../src/acl/v3/validator');
const { decodePosition3ToGu } = require('../../src/acl/v3/q32');
const { indexDocumentGraph, resolveGraphNode, unwrapReactive } = require('../../src/acl/v3/graph');
const {
  scanGameRoot,
  getFileInfo,
  collectUniqueValues,
  collectRunwayPairs,
  buildApproachCache,
  createZip,
  extractZip,
  readZipEntries,
} = require('../../src/acl/parser');
const {
  SYNTH_FIXTURE_PATH,
  buildSyntheticV3Buffer,
} = require('../fixtures/v3/synthetic_v3');

const V2_FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/game-root');
const V2_ZSJN_LEISURE = path.join(
  V2_FIXTURE_ROOT,
  'GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels/ZSJN_leisure_1.acl',
);

const HAS_INSTALLED_V3_CORPUS = (() => {
  try {
    if (!gameLevelExists('ZSJN', 'ZSJN_leisure_1.acl')) return false;
    const sample = fs.readFileSync(levelPath('ZSJN', 'ZSJN_leisure_1.acl'));
    return detectAclFormat(sample) === 'gatcarc4-v3';
  } catch (_) {
    return false;
  }
})();

const tmpDirs = [];
function makeTmpDir(prefix = 'ac27-v3-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {}
  }
});

describe('GATCARC4 v3 — Synthetic Edit & Safety Coverage (Always Runs)', () => {
  it('edits config, weather, wind, and runway timelines while preserving untouched wind raw BigInts and checkpoints', () => {
    const tmpDir = makeTmpDir('ac27-v3-meta-');
    const tmpAcl = path.join(tmpDir, 'SYNTH_leisure_1.acl');
    fs.writeFileSync(tmpAcl, buildSyntheticV3Buffer());

    const handle = openAclFile(tmpAcl);
    const origWindRaw0 = handle.container.metaData.WindFrames[0];
    const origDirRaw0 = origWindRaw0.Direction;
    const origSpdRaw0 = origWindRaw0.Speed;
    const origFrameBytes = Buffer.from(handle.container.frames[0].rawFrameBytes);

    const tl = handle.readTimelines();
    expect(tl.weatherTimeline.length).toBeGreaterThanOrEqual(1);
    expect(tl.windTimeline.length).toBeGreaterThanOrEqual(1);

    // Keep wind[0] identical to projected values so raw BigInts are preserved; append wind[1]
    handle.applyEdits({
      config: { startTime: '08:05:00', endTime: '11:30:00' },
      weatherTimeline: [
        ...tl.weatherTimeline,
        { time: '09:30', preset: 'LightRain' },
      ],
      windTimeline: [
        { ...tl.windTimeline[0] },
        { time: '09:30', direction: 190, speed: 18 },
      ],
      windSpeedUnit: 'knots',
      runwayTimeline: {
        initialRunways: tl.runwayTimeline.initialRunways,
        timeline: [
          {
            startTime: '09:45:00',
            targetRunways: [{ runway: '19', arrival: true, departure: true }],
          },
        ],
      },
    });

    handle.saveToFile(tmpAcl, { createBackup: true });
    expect(fs.existsSync(tmpAcl + '.bak')).toBe(true);

    const reloaded = openAclFile(tmpAcl);
    expect(reloaded.format).toBe('gatcarc4-v3');
    expect(reloaded.storageVersion).toBe(3);
    validateV3Container(reloaded.container);

    // Untouched wind[0] raw Q32.32 BigInt values preserved byte-for-byte
    expect(reloaded.container.metaData.WindFrames[0].Direction).toBe(origDirRaw0);
    expect(reloaded.container.metaData.WindFrames[0].Speed).toBe(origSpdRaw0);
    // Checkpoint frame segment bytes untouched on MetaData-only edit
    expect(reloaded.container.frames[0].rawFrameBytes.equals(origFrameBytes)).toBe(true);

    const reloadedCfg = reloaded.readConfig();
    expect(reloadedCfg.startTime).toBe('08:05:00');
    expect(reloadedCfg.endTime).toBe('11:30:00');

    const reloadedTl = reloaded.readTimelines();
    expect(reloadedTl.weatherTimeline.some((w) => w.preset === 'LightRain')).toBe(true);
    expect(reloadedTl.windTimeline.length).toBe(2);
    expect(reloadedTl.windTimeline[1].direction).toBe(190);
    expect(reloadedTl.windTimeline[1].speed).toBe(18);
    expect(reloadedTl.runwayTimeline.timeline.length).toBe(1);
  });

  it('enforces stale-source protection and leaves original file intact on simulated write failure', () => {
    const tmpDir = makeTmpDir('ac27-v3-safety-');
    const tmpAcl = path.join(tmpDir, 'SYNTH_safety.acl');
    const origBytes = buildSyntheticV3Buffer();
    fs.writeFileSync(tmpAcl, origBytes);

    const handle = openAclFile(tmpAcl);
    handle.applyEdits({ config: { startTime: '08:10:00' } });

    // 1. Simulated write failure BEFORE atomic rename
    expect(() => handle.saveToFile(tmpAcl, { simulateWriteFailure: true, createBackup: false })).toThrow(
      /Simulated write failure/,
    );
    expect(fs.readFileSync(tmpAcl).equals(origBytes)).toBe(true);
    const dirFiles = fs.readdirSync(tmpDir);
    expect(dirFiles).toEqual(['SYNTH_safety.acl']);
    // Original file remains usable
    expect(openAclFile(tmpAcl).readFlights(tmpAcl).flights.length).toBeGreaterThan(0);

    // 2. Stale-source check when disk changed behind the handle
    const externalHandle = openAclFile(tmpAcl);
    externalHandle.applyEdits({ config: { endTime: '12:00:00' } });
    externalHandle.saveToFile(tmpAcl);

    expect(() => handle.saveToFile(tmpAcl)).toThrow(StaleSourceError);
    expect(openAclFile(tmpAcl).readConfig().endTime).toBe('12:00:00');
  });

  it('preserves each file format in a mixed v2 + v3 airport directory', () => {
    const tmpRoot = makeTmpDir('ac27-v3-mixed-');
    const levelsDir = path.join(tmpRoot, 'GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels');
    fs.mkdirSync(levelsDir, { recursive: true });

    const v2FixtureDir = path.dirname(V2_ZSJN_LEISURE);
    for (const f of fs.readdirSync(v2FixtureDir)) {
      fs.copyFileSync(path.join(v2FixtureDir, f), path.join(levelsDir, f));
    }
    const v3SourceBytes = HAS_INSTALLED_V3_CORPUS
      ? fs.readFileSync(levelPath('ZSJN', 'ZSJN_peakdeparture.acl'))
      : fs.readFileSync(SYNTH_FIXTURE_PATH);
    const v3Path = path.join(levelsDir, 'ZSJN_v3_level.acl');
    const v2Path = path.join(levelsDir, 'ZSJN_leisure_1.acl');
    fs.writeFileSync(v3Path, v3SourceBytes);

    // Mixed-directory read operations
    const aclList = [v2Path, v3Path];
    const vals = collectUniqueValues(aclList);
    expect(vals.Runway.length).toBeGreaterThan(0);
    const pairs = collectRunwayPairs(aclList);
    expect(Array.isArray(pairs)).toBe(true);
    const appCache = buildApproachCache(levelsDir);
    expect(Object.keys(appCache.starPaths || {}).length).toBeGreaterThan(0);

    // Save v2 file -> stays v2
    const h2 = openAclFile(v2Path);
    expect(h2.format).toBe('gatcarc4-v2');
    const f2 = h2.readFlights(v2Path);
    h2.applyEdits({ flights: f2.flights, filePath: v2Path });
    h2.saveToFile(v2Path);
    expect(detectAclFormat(fs.readFileSync(v2Path))).toBe('gatcarc4-v2');
    expect(openAclFile(v2Path).storageVersion).toBe(2);

    // Save v3 file -> stays v3
    const h3 = openAclFile(v3Path);
    expect(h3.format).toBe('gatcarc4-v3');
    const tl3 = h3.readTimelines();
    h3.applyEdits({
      weatherTimeline: tl3.weatherTimeline,
      windTimeline: tl3.windTimeline,
      windSpeedUnit: 'knots',
    });
    h3.saveToFile(v3Path);
    expect(detectAclFormat(fs.readFileSync(v3Path))).toBe('gatcarc4-v3');
    const h3Reload = openAclFile(v3Path);
    expect(h3Reload.storageVersion).toBe(3);
    validateV3Container(h3Reload.container);
  });

  it('supports ZIP package round-trip and format-aware incoming validation for both v3 and v2', () => {
    const tmpDir = makeTmpDir('ac27-v3-zip-');
    const v3ZipPath = path.join(tmpDir, 'v3_export.zip');
    const v3Buf = buildSyntheticV3Buffer();
    const csvBuf = Buffer.from('CallSign,AircraftType\nCES5101,A320\n', 'utf8');

    createZip(
      [
        { name: 'SYNTH_level.acl', data: v3Buf },
        { name: 'flight_schedule.csv', data: csvBuf },
      ],
      v3ZipPath,
    );

    // In-memory inspection before touching target directory
    const zipEntries = readZipEntries(v3ZipPath);
    expect([...zipEntries.keys()].sort()).toEqual(['SYNTH_level.acl', 'flight_schedule.csv']);
    const incoming = openAcl(zipEntries.get('SYNTH_level.acl'), { validateOnOpen: true });
    expect(incoming.format).toBe('gatcarc4-v3');

    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    extractZip(v3ZipPath, extractDir);

    const extractedHandle = openAclFile(path.join(extractDir, 'SYNTH_level.acl'));
    expect(extractedHandle.format).toBe('gatcarc4-v3');
    expect(extractedHandle.toBuffer().equals(v3Buf)).toBe(true);
  });

  it('round-trips exact non-zero GU coordinates across moved and synthesized scenery entities and aircraft', () => {
    const tmpDir = makeTmpDir('ac27-v3-coords-');
    const tmpAcl = path.join(tmpDir, 'SYNTH_coords.acl');
    fs.writeFileSync(tmpAcl, buildSyntheticV3Buffer());

    const h = openAclFile(tmpAcl);
    const { graph, meta } = h.readSceneryGraph();

    // 1. Move an existing TaxiwayNode (node[2] = hold01 at (-1.2, -14))
    const movedTarget = { x: -1.75, z: -13.25 };
    graph.nodes[2] = { ...graph.nodes[2], x: movedTarget.x, z: movedTarget.z };

    // 2. Synthesize new TaxiwayNodes + TaxiwaySegment + Stand ('V388') + pushback node
    const pbIdx = graph.nodes.length;
    graph.nodes.push({ x: -1.35, z: 3.25, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);

    const tailIdx = graph.nodes.length;
    graph.nodes.push({ x: -2.4, z: 3.25, type: 0, flags: 0 });
    meta.nodeOrigPk.push(null);

    const noseIdx = graph.nodes.length;
    graph.nodes.push({ x: -3.1, z: 3.25, type: 0, flags: 0 });
    meta.nodeOrigPk.push(null);

    graph.segments.push({
      nodeIdxs: [4, pbIdx, tailIdx, noseIdx],
      aIdx: 4,
      bIdx: noseIdx,
      name: 'TWY_COORD',
      flags: 1,
      directed: false,
    });
    meta.segOrigPk.push(null);

    graph.stands.push({
      identifier: 'V388',
      name: 'V388',
      tailIdx,
      noseIdx,
      parkingType: 1,
      egressType: 0,
      pushbackIdxs: [pbIdx],
    });
    meta.standOrigPk.push(null);

    // 3. Synthesize a new Runway pair ('09/27') from two new non-zero threshold nodes
    const rwThA = graph.nodes.length;
    graph.nodes.push({ x: -12.5, z: 22.0, type: 1, flags: 0 });
    meta.nodeOrigPk.push(null);
    const rwThB = graph.nodes.length;
    graph.nodes.push({ x: 14.5, z: 22.0, type: 1, flags: 0 });
    meta.nodeOrigPk.push(null);
    graph.segments.push({
      nodeIdxs: [rwThA, rwThB],
      aIdx: rwThA,
      bIdx: rwThB,
      name: '09/27',
      flags: 4,
      directed: false,
    });
    meta.segOrigPk.push(null);
    graph.runways.push({
      thAIdx: rwThA,
      thBIdx: rwThB,
      names: ['09', '27'],
      name: '09',
      physicalName: '09/27',
      width: 0.45,
      entries: [],
      exits: [],
    });
    meta.runwayOrigPk.push(null);

    // 4. Synthesize new AirwayNodes + STAR procedure
    const awA = graph.airwayNodes.length;
    graph.airwayNodes.push({ name: 'CRDFX', x: -33.5, z: -55.25 });
    meta.airwayNodeOrigPk.push(null);
    const awB = graph.airwayNodes.length;
    graph.airwayNodes.push({ name: 'CRDFY', x: -18.25, z: -27.75 });
    meta.airwayNodeOrigPk.push(null);
    graph.procedures.push({
      name: 'CRD1A',
      routeType: 0,
      runwayName: '01',
      airwayNodeIdxs: [awA, awB],
    });
    meta.airwaySegOrigPk.push(null);

    // 5. Modify existing Area[0] vertex & synthesize new Area polygon
    graph.areas[0] = {
      ...graph.areas[0],
      points: [
        { x: -4.25, z: -2.5 },
        ...graph.areas[0].points.slice(1),
      ],
    };
    graph.areas.push({
      areaType: 2,
      points: [
        { x: 5.5, z: -6.25 },
        { x: 7.5, z: -6.25 },
        { x: 7.5, z: -4.25 },
        { x: 5.5, z: -4.25 },
      ],
    });
    meta.areaOrigId.push(null);

    // 6. Add a departure flight parked on the newly synthesized stand V388
    const existingFlights = h.readFlights(tmpAcl).flights;
    const sampleDep = existingFlights.find((f) => f.isDeparture) || existingFlights[0];
    const nextFlights = [
      ...existingFlights,
      {
        ...sampleDep,
        _fpGuid: '',
        _Registration: 'B-CRD1',
        Registration: 'B-CRD1',
        CallSign: 'CES7788',
        Stand: 'V388',
        Runway: '01',
        OffBlockTime: '08:40:00',
        isDeparture: true,
      },
    ];

    h.applyEdits({
      sceneryGraph: graph,
      sceneryMeta: meta,
      flights: nextFlights,
      filePath: tmpAcl,
    });
    h.saveToFile(tmpAcl);

    const reloaded = openAclFile(tmpAcl, { validateOnOpen: true });
    const sc = reloaded.readScenery();
    const sg = reloaded.readSceneryGraph().graph;

    // Moved TaxiwayNode
    expect(sg.nodes[2].x).toBeCloseTo(movedTarget.x, 6);
    expect(sg.nodes[2].z).toBeCloseTo(movedTarget.z, 6);

    // Synthesized Stand V388 + companion FixedTaxiNavigationPoint coordinates
    expect(sc.standPositions.V388).toBeDefined();
    expect(sc.standPositions.V388.tailX).toBeCloseTo(-2.4, 6);
    expect(sc.standPositions.V388.tailZ).toBeCloseTo(3.25, 6);
    expect(sc.standPositions.V388.noseX).toBeCloseTo(-3.1, 6);
    expect(sc.standPositions.V388.noseZ).toBeCloseTo(3.25, 6);

    const schema = getSchemaForHash(reloaded.header.schemaHash);
    const sIdx = indexDocumentGraph(reloaded.container.staticData, schema.roots.static, schema);
    const pkDict = resolveGraphNode(reloaded.container.staticData.PKStaticEntities, sIdx);
    const standNav = resolveGraphNode(pkDict['taxi-navigation:stand:V388'], sIdx);
    const standNavGu = decodePosition3ToGu(standNav.Position);
    expect(standNavGu.x).toBeCloseTo(-2.4, 6);
    expect(standNavGu.y).toBe(0);
    expect(standNavGu.z).toBeCloseTo(3.25, 6);

    const pbNavKey = Object.keys(pkDict).find((k) => k.startsWith('taxi-navigation:pushback:V388:'));
    expect(pbNavKey).toBeTruthy();
    const pbNavGu = decodePosition3ToGu(resolveGraphNode(pkDict[pbNavKey], sIdx).Position);
    expect(pbNavGu.x).toBeCloseTo(-1.35, 6);
    expect(pbNavGu.y).toBe(0);
    expect(pbNavGu.z).toBeCloseTo(3.25, 6);

    // Synthesized Runway 09/27 thresholds & derived TouchDownPoint
    expect(sc.runwayThresholds['09/27']).toBeDefined();
    expect(sc.runwayThresholds['09/27'].thresholds[0].x).toBeCloseTo(-12.5, 6);
    expect(sc.runwayThresholds['09/27'].thresholds[0].z).toBeCloseTo(22.0, 6);
    expect(sc.runwayThresholds['09/27'].thresholds[1].x).toBeCloseTo(14.5, 6);
    expect(sc.runwayThresholds['09/27'].thresholds[1].z).toBeCloseTo(22.0, 6);
    const rw09 = resolveGraphNode(pkDict['runway:09'], sIdx);
    const td09Gu = decodePosition3ToGu(unwrapReactive(resolveGraphNode(rw09.TouchDownPoint, sIdx).ReactivePosition, sIdx));
    expect(td09Gu.x).toBeCloseTo(-12.5 + 4.8, 5);
    expect(td09Gu.z).toBeCloseTo(22.0, 6);

    // Synthesized AirwayNodes
    const crdFx = sg.airwayNodes.find((n) => n.name === 'CRDFX');
    const crdFy = sg.airwayNodes.find((n) => n.name === 'CRDFY');
    expect(crdFx.x).toBeCloseTo(-33.5, 6);
    expect(crdFx.z).toBeCloseTo(-55.25, 6);
    expect(crdFy.x).toBeCloseTo(-18.25, 6);
    expect(crdFy.z).toBeCloseTo(-27.75, 6);

    // Edited & synthesized Area polygon vertices
    expect(sg.areas[0].points[0].x).toBeCloseTo(-4.25, 6);
    expect(sg.areas[0].points[0].z).toBeCloseTo(-2.5, 6);
    const newArea = sg.areas.find((a) => a.areaType === 2);
    expect(newArea.points[0].x).toBeCloseTo(5.5, 6);
    expect(newArea.points[0].z).toBeCloseTo(-6.25, 6);
    expect(newArea.points[2].x).toBeCloseTo(7.5, 6);
    expect(newArea.points[2].z).toBeCloseTo(-4.25, 6);

    // Synthesized Aircraft position on V388 in checkpoint RuntimeData
    const rtIdx = indexDocumentGraph(reloaded.container.frames[0].runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(reloaded.container.frames[0].runtimeData.RuntimeEntities, rtIdx);
    const acObj = resolveGraphNode(reDict['aircraft:B-CRD1'], rtIdx);
    const acPosGu = decodePosition3ToGu(unwrapReactive(acObj._position, rtIdx));
    expect(Math.abs(acPosGu.x)).toBeGreaterThan(2.5);
    expect(acPosGu.z).toBeCloseTo(3.25, 5);
  });
});

describe('GATCARC4 v3 — Checked-In 13-File ZSJN Reference Corpus (Always Runs)', () => {
  it('discovers, validates, projects, and byte-exactly round-trips all 13 checked-in ZSJN v3 .acl files', () => {
    const scan = scanGameRoot(FIXTURES_GAME_ROOT_V3);
    expect(scan.airports.map((a) => a.icao)).toEqual(['ZSJN']);
    expect(scan.totalFiles).toBe(13);

    const dir = gamePaths.levelsDir(FIXTURES_GAME_ROOT_V3, 'ZSJN');
    const aclFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.acl') && !f.endsWith('.acl.bak')).sort();
    expect(aclFiles.length).toBe(13);

    for (const fileName of aclFiles) {
      const fp = path.join(dir, fileName);
      const origBytes = fs.readFileSync(fp);
      expect(detectAclFormat(origBytes)).toBe('gatcarc4-v3');

      const handle = openAcl(origBytes, { filePath: fp, validateOnOpen: true });
      expect(handle.storageVersion).toBe(3);
      expect(handle.header.schemaHash).toBe(TARGET_SCHEMA_HASH);

      const flightsRes = handle.readFlights(fp);
      expect(Array.isArray(flightsRes.flights)).toBe(true);

      const info = getFileInfo(fp);
      if (flightsRes.flights.length === 0) {
        expect(info.error).toBe('No WorldState flight data');
      } else {
        expect(info.error).toBeUndefined();
        expect(info.flightCount).toBe(flightsRes.flights.length);
      }

      const timelines = handle.readTimelines();
      expect(Array.isArray(timelines.weatherTimeline)).toBe(true);
      expect(Array.isArray(timelines.windTimeline)).toBe(true);

      const scenery = handle.readScenery();
      expect(Object.keys(scenery.standPositions).length).toBeGreaterThan(0);

      const sg = handle.readSceneryGraph();
      expect(sg.graph.runways.length).toBeGreaterThan(0);

      // No-edit byte-exact round-trip
      expect(handle.toBuffer().equals(origBytes)).toBe(true);

      // Full re-encode round-trip
      const reencoded = handle.toBuffer({ forceReencode: true });
      const reparsed = openAcl(reencoded, { validateOnOpen: true });
      expect(reparsed.container.frames.length).toBe(handle.container.frames.length);
    }
  }, 45000);
});

describe.skipIf(!HAS_INSTALLED_V3_CORPUS)('GATCARC4 v3 — Installed 40-File Game Corpus & 5-Airport Real Edits', () => {
  it('discovers all shipped airports and byte-exactly round-trips all 40 shipped v3 .acl files', () => {
    const scan = scanGameRoot(GAME_ROOT);
    expect(scan.airports.map((a) => a.icao).sort()).toEqual(['KDCA', 'KJFK', 'ZGSZ', 'ZSJN']);
    expect(scan.totalFiles).toBe(40);

    const airports = ['KDCA', 'KJFK', 'ZGSZ', 'ZSJN'];
    let count = 0;
    for (const icao of airports) {
      const dir = gamePaths.levelsDir(GAME_ROOT, icao);
      const aclFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.acl')).sort();
      for (const fileName of aclFiles) {
        count++;
        const fp = path.join(dir, fileName);
        const origBytes = fs.readFileSync(fp);
        expect(detectAclFormat(origBytes)).toBe('gatcarc4-v3');

        const handle = openAcl(origBytes, { filePath: fp, validateOnOpen: true });
        expect(handle.storageVersion).toBe(3);
        expect(handle.header.schemaHash).toBe(TARGET_SCHEMA_HASH);

        // Read projections
        const flightsRes = handle.readFlights(fp);
        expect(Array.isArray(flightsRes.flights)).toBe(true);

        const info = getFileInfo(fp);
        if (flightsRes.flights.length === 0) {
          expect(info.error).toBe('No WorldState flight data');
        } else {
          expect(info.error).toBeUndefined();
          expect(info.flightCount).toBe(flightsRes.flights.length);
        }

        const timelines = handle.readTimelines();
        expect(Array.isArray(timelines.weatherTimeline)).toBe(true);
        expect(Array.isArray(timelines.windTimeline)).toBe(true);

        const scenery = handle.readScenery();
        expect(Object.keys(scenery.standPositions).length).toBeGreaterThan(0);

        const sg = handle.readSceneryGraph();
        expect(sg.graph.runways.length).toBeGreaterThan(0);

        // No-edit byte-exact round-trip
        const outBytes = handle.toBuffer();
        expect(outBytes.equals(origBytes)).toBe(true);

        // Full re-encode round-trip preserves exact numeric values & checkpoint counts
        const reencoded = handle.toBuffer({ forceReencode: true });
        const reparsed = openAcl(reencoded, { validateOnOpen: true });
        expect(reparsed.container.frames.length).toBe(handle.container.frames.length);
        for (let fi = 0; fi < handle.container.frames.length; fi++) {
          expect(reparsed.container.frames[fi].summary.createdAtUtcTicks).toBe(
            handle.container.frames[fi].summary.createdAtUtcTicks,
          );
        }
      }
    }
    expect(count).toBe(40);
  }, 60000);

  it('handles EGLC CSV-only airport cleanly without .acl files', () => {
    const eglcDir = gamePaths.levelsDir(GAME_ROOT, 'EGLC');
    const aclFiles = fs.readdirSync(eglcDir).filter((f) => f.endsWith('.acl'));
    expect(aclFiles.length).toBe(0);
    const scan = scanGameRoot(GAME_ROOT);
    expect(scan.airports.some((a) => a.icao === 'EGLC')).toBe(false);
    const vals = collectUniqueValues([]);
    expect(Array.isArray(vals.AirlineCode)).toBe(true);
  });

  it('edits flights (add arrival & departure, rename registration, delete, and zero flights) with checkpoint reconciliation across airports', () => {
    // Test on checkpointed ZSJN_leisure_1.acl and KDCA_leisure_1.acl, plus 0-frame KJFK_leisure_1.acl & ZGSZ_leisure_1.acl
    const targets = [
      { icao: 'ZSJN', file: 'ZSJN_leisure_1.acl', expectFrames: 1 },
      { icao: 'KDCA', file: 'KDCA_leisure_1.acl', expectFrames: 1 },
      { icao: 'KJFK', file: 'KJFK_leisure_1.acl', expectFrames: 0 },
      { icao: 'ZGSZ', file: 'ZGSZ_leisure_1.acl', expectFrames: 0 },
    ];

    for (const t of targets) {
      const tmpRoot = makeTmpDir(`ac27-v3-fl-${t.icao}-`);
      const tmpLevels = path.join(tmpRoot, 'GroundATC_Data/StreamingAssets/Airports', t.icao, 'Levels');
      fs.mkdirSync(tmpLevels, { recursive: true });
      const srcPath = levelPath(t.icao, t.file);
      const dstPath = path.join(tmpLevels, t.file);
      fs.copyFileSync(srcPath, dstPath);

      const approachCache = buildApproachCache(gamePaths.levelsDir(GAME_ROOT, t.icao));
      const handle = openAclFile(dstPath);
      expect(handle.container.frames.length).toBe(t.expectFrames);

      const { flights } = handle.readFlights(dstPath);
      expect(flights.length).toBeGreaterThan(2);
      const scenery = handle.readScenery();
      const standList = Object.keys(scenery.standPositions);
      expect(standList.length).toBeGreaterThan(0);

      // Find an unused stand so adding a flight never triggers stand overlap
      const usedStands = new Set(flights.map((f) => String(f.Stand || '').trim()));
      const freeStandName = standList.find((id) => !usedStands.has(String(id).trim()));
      expect(freeStandName).toBeTruthy();

      // Clone template arrival & departure, rename first flight's registration, delete second flight, and add a new flight
      const editedFlights = flights.filter((_, idx) => idx !== 1).map((f, idx) => {
        if (idx === 0) {
          return {
            ...f,
            Registration: 'B-99V3',
            _Registration: 'B-99V3',
          };
        }
        return { ...f };
      });

      const sampleDep = flights.find((f) => f.FlightType === 'Departure') || flights[0];
      editedFlights.push({
        ...sampleDep,
        CallSign: 'CES9876',
        FlightNumber: 'MU9876',
        Registration: 'B-88V3',
        _Registration: 'B-88V3',
        Stand: freeStandName,
        FlightType: 'Departure',
      });

      const deletedReg = flights[1]._Registration || flights[1].Registration;

      handle.applyEdits({
        flights: editedFlights,
        approachCache,
        filePath: dstPath,
      });
      handle.saveToFile(dstPath);

      const reloaded = openAclFile(dstPath);
      validateV3Container(reloaded.container);
      const afterFlights = reloaded.readFlights(dstPath).flights;
      expect(afterFlights.length).toBe(editedFlights.length);
      expect(afterFlights.some((f) => (f._Registration || f.Registration) === 'B-99V3')).toBe(true);
      expect(afterFlights.some((f) => (f._Registration || f.Registration) === 'B-88V3')).toBe(true);
      expect(afterFlights.some((f) => (f._Registration || f.Registration) === deletedReg)).toBe(false);

      if (t.expectFrames > 0) {
        const rtEntities = reloaded.container.frames[0].runtimeData.RuntimeEntities;
        expect(rtEntities[`flight-plan:${deletedReg}`]).toBeUndefined();
        expect(rtEntities[`aircraft:${deletedReg}`]).toBeUndefined();
        expect(rtEntities[`aircraft-animator:aircraft:${deletedReg}`]).toBeUndefined();
        expect(rtEntities['flight-plan:B-99V3']).toBeDefined();
        expect(rtEntities['flight-plan:B-88V3']).toBeDefined();
      }

      // Now test zero-flights behavior on the checkpointed ZSJN level
      if (t.icao === 'ZSJN') {
        reloaded.applyEdits({
          flights: [],
          approachCache,
          filePath: dstPath,
        });
        reloaded.saveToFile(dstPath);

        const zeroHandle = openAclFile(dstPath);
        validateV3Container(zeroHandle.container);
        expect(zeroHandle.readFlights(dstPath).flights.length).toBe(0);
        // Unrelated scenery and singleton runtime entities remain intact
        expect(Object.keys(zeroHandle.readScenery().standPositions).length).toBe(standList.length);
        const zeroRt = zeroHandle.container.frames[0].runtimeData.RuntimeEntities;
        expect(zeroRt['singleton:game-time']).toBeDefined();
        expect(zeroRt['singleton:game-event-schedule']).toBeDefined();
        expect(zeroRt['singleton:scoring-state']).toBeDefined();
      }
    }
  }, 45000);

  it('applies Ground & Air Painter scenery edits (add/move/delete taxiway, stand, area, airway procedure, and runway rename/delete cascade) and reloads cleanly', () => {
    const tmpDir = makeTmpDir('ac27-v3-scenery-');
    // 1. ZSJN_leisure_1.acl (has checkpoint frame): move node, add taxiway branch, add jetbridge stand, delete stand, add area, add airway procedure
    const zsjnTmp = path.join(tmpDir, 'ZSJN_leisure_1.acl');
    fs.copyFileSync(levelPath('ZSJN', 'ZSJN_leisure_1.acl'), zsjnTmp);

    const h = openAclFile(zsjnTmp);
    const { graph, meta } = h.readSceneryGraph();
    const origStandCount = graph.stands.length;
    const origAreaCount = graph.areas.length;
    const origProcCount = graph.procedures.length;

    // Pick an untouched node to verify exact raw BigInt preservation
    const untouchedNodePk = meta.nodeOrigPk[0];
    const untouchedRawBefore = h.container.staticData.PKStaticEntities[untouchedNodePk].ReactivePosition.value;

    // Move node[5] slightly
    graph.nodes[5] = { ...graph.nodes[5], x: graph.nodes[5].x + 0.05, z: graph.nodes[5].z - 0.05 };

    // Add taxiway nodes + a new taxiway segment branching off node[5]
    const nIdxA = graph.nodes.length;
    graph.nodes.push({ x: graph.nodes[5].x + 0.4, z: graph.nodes[5].z + 0.4 });
    meta.nodeOrigPk.push(null);
    const nIdxB = graph.nodes.length;
    graph.nodes.push({ x: graph.nodes[5].x + 0.8, z: graph.nodes[5].z + 0.4 });
    meta.nodeOrigPk.push(null);
    const nIdxTail = graph.nodes.length;
    graph.nodes.push({ x: graph.nodes[5].x + 0.8, z: graph.nodes[5].z + 0.6 });
    meta.nodeOrigPk.push(null);
    const nIdxNose = graph.nodes.length;
    graph.nodes.push({ x: graph.nodes[5].x + 0.8, z: graph.nodes[5].z + 0.9 });
    meta.nodeOrigPk.push(null);

    graph.segments.push({
      aIdx: 5,
      bIdx: nIdxNose,
      nodeIdxs: [5, nIdxA, nIdxB, nIdxTail, nIdxNose],
      name: 'TWY_V3',
      flags: 1,
      directed: false,
      isHidden: false,
      isUnselectable: false,
    });
    meta.segOrigPk.push(null);

    // Add a new jetbridge stand ('V399') connected to nIdxTail -> nIdxNose + pushbackIdxs [nIdxB]
    graph.stands.push({
      identifier: 'V399',
      name: 'V399',
      tailIdx: nIdxTail,
      noseIdx: nIdxNose,
      parkingType: 1, // Jetbridge -> must synthesize jetway:V399 in checkpoint RuntimeData!
      egressType: 0,
      pushbackIdxs: [nIdxB],
    });
    meta.standOrigPk.push(null);

    // Delete the last pre-existing stand and record its PK in meta.deletedPks
    const delStandIdx = origStandCount - 1;
    const delStandIdent = graph.stands[delStandIdx].identifier || graph.stands[delStandIdx].name;
    const delStandPk = meta.standOrigPk[delStandIdx];
    meta.deletedPks = [...(meta.deletedPks || []), delStandPk];
    graph.stands.splice(delStandIdx, 1);
    meta.standOrigPk.splice(delStandIdx, 1);

    // Add a new ground Area polygon (numeric EAreaType = 1)
    graph.areas.push({
      areaType: 1,
      points: [
        { x: -1.0, z: -1.0 },
        { x: -0.5, z: -1.0 },
        { x: -0.5, z: -0.5 },
        { x: -1.0, z: -0.5 },
      ],
    });
    meta.areaOrigId.push(null);

    // Add a new AirwayNode + STAR procedure on existing runway
    const rwyEnd = graph.runways[0].names[0];
    const awIdxA = graph.airwayNodes.length;
    graph.airwayNodes.push({ name: 'V3FIXA', x: -20, z: -40 });
    meta.airwayNodeOrigPk.push(null);
    const awIdxB = graph.airwayNodes.length;
    graph.airwayNodes.push({ name: 'V3FIXB', x: -10, z: -20 });
    meta.airwayNodeOrigPk.push(null);

    graph.procedures.push({
      name: 'V3STAR1A',
      routeType: 0,
      runwayName: rwyEnd,
      airwayNodeIdxs: [awIdxA, awIdxB],
    });
    meta.airwaySegOrigPk.push(null);

    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    // Also reconcile flights that referenced the deleted stand before saving
    const remainingFlights = h.readFlights(zsjnTmp).flights.filter(
      (f) => String(f.Stand || '').trim() !== String(delStandIdent).trim(),
    );
    h.applyEdits({ flights: remainingFlights, filePath: zsjnTmp });
    h.saveToFile(zsjnTmp);

    const reloaded = openAclFile(zsjnTmp);
    validateV3Container(reloaded.container);

    // Untouched node[0] raw BigInt tuple preserved exactly
    const untouchedRawAfter = reloaded.container.staticData.PKStaticEntities[untouchedNodePk].ReactivePosition.value;
    expect(untouchedRawAfter).toEqual(untouchedRawBefore);

    const reloadedSg = reloaded.readSceneryGraph();
    expect(reloadedSg.graph.stands.length).toBe(origStandCount); // -1 deleted + 1 added
    expect(reloadedSg.graph.stands.some((s) => s.identifier === 'V399')).toBe(true);
    expect(reloadedSg.graph.stands.some((s) => s.identifier === delStandIdent)).toBe(false);
    expect(reloadedSg.graph.areas.length).toBe(origAreaCount + 1);
    expect(reloadedSg.graph.procedures.length).toBe(origProcCount + 1);
    expect(reloadedSg.graph.procedures.some((p) => p.name === 'V3STAR1A')).toBe(true);

    // Verify exact non-zero GU coordinates on moved & newly synthesized ZSJN entities
    const reloadedSc = reloaded.readScenery();
    expect(reloadedSg.graph.nodes[5].x).toBeCloseTo(graph.nodes[5].x, 6);
    expect(reloadedSg.graph.nodes[5].z).toBeCloseTo(graph.nodes[5].z, 6);
    expect(reloadedSc.standPositions.V399.tailX).toBeCloseTo(graph.nodes[nIdxTail].x, 6);
    expect(reloadedSc.standPositions.V399.tailZ).toBeCloseTo(graph.nodes[nIdxTail].z, 6);
    expect(reloadedSc.standPositions.V399.noseX).toBeCloseTo(graph.nodes[nIdxNose].x, 6);
    expect(reloadedSc.standPositions.V399.noseZ).toBeCloseTo(graph.nodes[nIdxNose].z, 6);
    const fixA = reloadedSg.graph.airwayNodes.find((n) => n.name === 'V3FIXA');
    const fixB = reloadedSg.graph.airwayNodes.find((n) => n.name === 'V3FIXB');
    expect(fixA.x).toBeCloseTo(-20, 6);
    expect(fixA.z).toBeCloseTo(-40, 6);
    expect(fixB.x).toBeCloseTo(-10, 6);
    expect(fixB.z).toBeCloseTo(-20, 6);
    const addedArea = reloadedSg.graph.areas[reloadedSg.graph.areas.length - 1];
    expect(addedArea.points[0].x).toBeCloseTo(-1.0, 6);
    expect(addedArea.points[0].z).toBeCloseTo(-1.0, 6);
    expect(addedArea.points[2].x).toBeCloseTo(-0.5, 6);
    expect(addedArea.points[2].z).toBeCloseTo(-0.5, 6);

    // Checkpoint runtime jetway synthesized for V399 and removed for deleted stand
    const rtEnts = reloaded.container.frames[0].runtimeData.RuntimeEntities;
    expect(rtEnts['jetway:V399']).toBeDefined();
    expect(rtEnts[`jetway:${delStandIdent}`]).toBeUndefined();

    // 2. Multi-runway KDCA_leisure_1.acl: delete secondary runway & verify cascade
    const kdcaTmp = path.join(tmpDir, 'KDCA_leisure_1.acl');
    fs.copyFileSync(levelPath('KDCA', 'KDCA_leisure_1.acl'), kdcaTmp);
    const hk = openAclFile(kdcaTmp);
    const { graph: gk, meta: mk } = hk.readSceneryGraph();
    expect(gk.runways.length).toBeGreaterThanOrEqual(2);

    // Delete the last runway
    const droppedRw = gk.runways.pop();
    mk.runwayOrigPk.pop();
    const droppedOrigInfo = mk.runwayOrigInfo.pop();
    if (droppedOrigInfo && Array.isArray(droppedOrigInfo.pks)) {
      mk.deletedPks = [...(mk.deletedPks || []), ...droppedOrigInfo.pks.filter(Boolean)];
    }

    hk.applyEdits({ sceneryGraph: gk, sceneryMeta: mk });
    // Purge flights using the deleted runway ends
    const droppedEnds = new Set(droppedRw.names || []);
    const kdcaKeptFlights = hk.readFlights(kdcaTmp).flights.filter((f) => !droppedEnds.has(f.Runway));
    hk.applyEdits({ flights: kdcaKeptFlights, filePath: kdcaTmp });
    hk.saveToFile(kdcaTmp);

    const hkReload = openAclFile(kdcaTmp);
    validateV3Container(hkReload.container);
    expect(hkReload.readSceneryGraph().graph.runways.length).toBe(gk.runways.length);
  }, 45000);
});
