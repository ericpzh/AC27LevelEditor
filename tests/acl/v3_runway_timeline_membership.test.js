/**
 * @vitest-environment node
 *
 * GATCARC4 v3 Flight Runway Timeline Membership Validation Suite.
 *
 * Covers `plan-v3-runway-timeline-membership.md` Sections 1–3 & Verification:
 *   - Shared pure helper (`collectRunwayTimelineMembers`, `validateFlightRunwayTimelineMembership`)
 *     matching `FlightPlanSessionValidator.ValidateRunways` + `RunwayTimelineService.LoadLevel`:
 *       * initial runways + valid transitions (`TryValidateTransitions` sweep)
 *       * invalid/inactive-source transitions do NOT grant membership
 *       * absent (`null`) timeline fallback vs explicit empty timeline (`[]`)
 *       * checks both `InitialArrival` and `InitialDeparture` when a plan has both legs
 *   - Editor validation (`runTripleValidation`) & MCP validation (`validateFlightObjects`):
 *       * v3-only enforcement against live/pending `runwayTimeline`
 *       * timeline-only edits revalidate the entire existing schedule
 *       * preserves arrival active-at-landing check + 10-minute `RUNWAY_TRANSITION_GRACE_SEC`
 *       * no departure active-at-time rule added
 *       * leaves v2 behavior unchanged
 *   - v3 write boundary (`saveToFile` & `saveV3GroundPainterData`) + `gamecompat-utils.cjs`:
 *       * rejects before modifying `.acl`, `.acl.bak`, `.csv`, or sidecars
 *       * existing invalid `.acl` files still open cleanly for repair
 *       * `analyzeAclFile` + `runChecks` emits `runway-not-in-timeline` (`--replace` gate)
 *   - Exact disposable `KJFK_leisure_1` reproduction (`ETD8349` / `A6-UYY` on `22R`).
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
const { dictEntries, indexDocumentGraph, resolveGraphNode } = require('../../src/acl/v3/graph');
const {
  collectRunwayTimelineMembers,
  validateFlightRunwayTimelineMembership,
} = require('../../src/acl/runway_timeline_membership');
const {
  RunwayTimelineMembershipError,
  validateV3ContainerRunwayTimelineMembership,
} = require('../../src/acl/v3/runway_timeline_validation');
const { saveV3GroundPainterData } = require('../../src/acl/v3/ground_painter_save');
import { runTripleValidation } from '../../src/utils/validators.js';
const { buildConstraints, validateFlightObjects } = require('../../electron/api-server');
const { analyzeAclFile, runChecks } = require('../integration/gamecompat-utils.cjs');
const parser = require('../../src/acl/parser');

const ZSJN_V3_DIR = path.join(
  FIXTURES_GAME_ROOT_V3,
  'GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels',
);
const V2_FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/game-root');
const V2_ZSJN_LEISURE = path.join(
  V2_FIXTURE_ROOT,
  'GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels/ZSJN_leisure_1.acl',
);

function resolveCleanKjfkLeisure1() {
  try {
    if (!gameLevelExists('KJFK', 'KJFK_leisure_1.acl')) return null;
    const mainPath = levelPath('KJFK', 'KJFK_leisure_1.acl');
    const bakPath = `${mainPath}.bak`;
    for (const candidate of [bakPath, mainPath]) {
      if (!fs.existsSync(candidate)) continue;
      const buf = fs.readFileSync(candidate);
      if (detectAclFormat(buf) !== 'gatcarc4-v3') continue;
      const h = openAclFile(candidate);
      const check = validateV3ContainerRunwayTimelineMembership(h.container, { throwOnError: false });
      if (check.issues.length === 0) return candidate;
    }
  } catch (_) {}
  return null;
}

const CLEAN_KJFK_LEISURE_1 = resolveCleanKjfkLeisure1();

const tmpDirs = [];
function makeTmpDir(prefix = 'ac27-v3-rwy-tl-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function sha256File(fp) {
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
});

describe('v3 Runway Timeline Membership — Pure Helper & Game Rules', () => {
  it('collects initial runways + valid later transitions and ignores invalid transitions whose source is inactive', () => {
    const res = collectRunwayTimelineMembers({
      initialRunways: ['13L', '22L'],
      timeline: [
        // Invalid: 4L is not active at 08:10:00, so neither 4L nor 22R enters the valid set
        { time: '08:10:00', changes: [{ source: '4L', dest: '22R' }] },
        // Valid: 22L is active -> activates 31L
        { time: '08:20:00', changes: [{ source: '22L', dest: '31L' }] },
      ],
    });

    expect(res.enforced).toBe(true);
    expect([...res.members]).toEqual(['13L', '22L', '31L']);
    expect(res.members.has('22R')).toBe(false);
    expect(res.members.has('4L')).toBe(false);
    expect(res.invalidChanges.length).toBe(1);
    expect(res.invalidChanges[0]).toMatchObject({
      source: '4L',
      dest: '22R',
      reason: 'source_not_active',
    });
  });

  it('distinguishes absent timeline fallback (null -> not enforced) from explicit empty timeline ([] -> enforced)', () => {
    expect(collectRunwayTimelineMembers(null).enforced).toBe(false);
    expect(collectRunwayTimelineMembers(undefined).enforced).toBe(false);

    const emptyExplicit = collectRunwayTimelineMembers({ initialRunways: [], timeline: [] });
    expect(emptyExplicit.enforced).toBe(true);
    expect(emptyExplicit.members.size).toBe(0);

    const issuesOnNull = validateFlightRunwayTimelineMembership(
      [{ CallSign: 'CES1001', Registration: 'B-1001', Runway: '01', OffBlockTime: '06:00:00', isDeparture: true }],
      null,
    );
    expect(issuesOnNull.enforced).toBe(false);
    expect(issuesOnNull.issues).toEqual([]);

    const issuesOnEmpty = validateFlightRunwayTimelineMembership(
      [{ CallSign: 'CES1001', Registration: 'B-1001', Runway: '01', OffBlockTime: '06:00:00', isDeparture: true }],
      { initialRunways: [], timeline: [] },
    );
    expect(issuesOnEmpty.enforced).toBe(true);
    expect(issuesOnEmpty.issues).toMatchObject([
      {
        registration: 'B-1001',
        callsign: 'CES1001',
        direction: 'departure',
        runway: '01',
      },
    ]);
  });

  it('checks both arrival and departure legs when a static plan contains both', () => {
    const dualPlan = {
      registration: 'N777DL',
      arrival: { callsign: 'DAL101', runway: '13L' },
      departure: { callsign: 'DAL102', runway: '22R' },
    };
    const res = validateFlightRunwayTimelineMembership(
      [dualPlan],
      { initialRunways: ['13L', '22L'], timeline: [] },
    );
    expect(res.issues).toMatchObject([
      {
        registration: 'N777DL',
        callsign: 'DAL102',
        direction: 'departure',
        runway: '22R',
      },
    ]);

    const bothBad = validateFlightRunwayTimelineMembership(
      [{ registration: 'N888DL', arrival: { callsign: 'DAL201', runway: '4R' }, departure: { callsign: 'DAL202', runway: '22R' } }],
      { initialRunways: ['13L', '22L'], timeline: [] },
    );
    expect(bothBad.issues.map((i) => `${i.direction}:${i.runway}`)).toEqual(['arrival:4R', 'departure:22R']);
  });
});

describe('v3 Runway Timeline Membership — Editor Validator, MCP Validator, Arrival Grace & v2 Scope', () => {
  function makeAirportValues(isV3 = true) {
    return {
      ZSJN: {
        _isV3: isV3,
        ...(isV3 ? { _v3Audio: true } : {}),
        AirlineCode: ['CES', 'CSN'],
        AirlineName: ['CES', 'CSN'],
        AircraftType: ['AIRBUS A-320neo'],
        DepartureAirport: ['ZSPD'],
        ArrivalAirport: ['ZSPD'],
        Stand: ['1', '2', '3', '4'],
        Runway: ['01', '19'],
        Airway: ['WFG91A'],
        Voice: ['v_zh_1'],
        Language: ['zh'],
        _voiceLanguages: { v_zh_1: 'zh' },
        _airlineCountries: { CES: 'CN', CSN: 'CN' },
        _flightNums: { CES: ['5101', '5102', '5103'], CSN: ['3101', '3102'] },
        _compat: { airlineToAircraft: { CES: ['AIRBUS A-320neo'], CSN: ['AIRBUS A-320neo'] } },
        _registrationMap: { 'CES|AIRBUS A-320neo': ['B-3001', 'B-3002', 'B-3003'] },
        _runwayStarMap: { '01': ['WFG91A'], '19': ['WFG91A'] },
        _starRunwayMap: { WFG91A: ['01', '19'] },
        _liveUsableApprRunways: ['01', '19'],
      },
    };
  }

  it('allows departures on initial runways and later-activated runways, even before/after switch time, while rejecting absent runways', () => {
    const av = makeAirportValues(true);
    const timelineWithSwitch = {
      initialRunways: ['01'],
      timeline: [{ time: '06:00:00', changes: [{ source: '01', dest: '19' }] }],
    };

    const validDeps = [
      // Departure on initial runway 01 AFTER 06:00:00 switch (no departure active-at-time rule)
      {
        CallSign: 'CES5101',
        AirlineName: 'CES',
        AircraftType: 'AIRBUS A-320neo',
        Registration: 'B-3001',
        ArrivalAirport: 'ZSPD',
        Stand: '1',
        Runway: '01',
        OffBlockTime: '06:20:00',
        TakeoffTime: '06:28:00',
        Voice: 'v_zh_1',
        Language: 'zh',
        isDeparture: true,
      },
      // Departure on later-activated runway 19 BEFORE 06:00:00 switch
      {
        CallSign: 'CES5102',
        AirlineName: 'CES',
        AircraftType: 'AIRBUS A-320neo',
        Registration: 'B-3002',
        ArrivalAirport: 'ZSPD',
        Stand: '2',
        Runway: '19',
        OffBlockTime: '05:45:00',
        TakeoffTime: '05:52:00',
        Voice: 'v_zh_1',
        Language: 'zh',
        isDeparture: true,
      },
    ];

    const okEditor = runTripleValidation(validDeps, av, 'ZSJN', null, null, '05:35:00', '06:30:00', timelineWithSwitch);
    expect(okEditor).toEqual([]);

    const mcpConstraints = buildConstraints(
      {
        currentAirport: 'ZSJN',
        airportValues: av,
        _configStartTime: '05:35:00',
        _configEndTime: '06:30:00',
        runwayTimeline: timelineWithSwitch,
      },
      null,
    );
    expect(validateFlightObjects([], validDeps, mcpConstraints)).toBeNull();

    // Timeline-only edit removing 01->19 invalidates CES5102 on 19 across full schedule revalidation
    const timelineWithout19 = { initialRunways: ['01'], timeline: [] };
    const failEditor = runTripleValidation(validDeps, av, 'ZSJN', null, null, '05:35:00', '06:30:00', timelineWithout19);
    expect(failEditor.length).toBe(1);
    expect(failEditor[0]).toContain('CES5102');
    expect(failEditor[0]).toContain('19');

    const mcpConstraintsNo19 = buildConstraints(
      {
        currentAirport: 'ZSJN',
        airportValues: av,
        _configStartTime: '05:35:00',
        _configEndTime: '06:30:00',
        runwayTimeline: timelineWithout19,
      },
      null,
    );
    const mcpIssues = validateFlightObjects([], validDeps, mcpConstraintsNo19);
    expect(mcpIssues).toBeTruthy();
    expect(mcpIssues.some((i) => i.issue === 'runway_not_in_timeline' && i.message.includes('CES5102') && i.value === '19')).toBe(true);
    // Actionable user message offers editing flight assignment or editing Runway Timeline
    expect(mcpIssues[0].message).toMatch(/Edit the flight runway assignment|Runway Timeline/);
  });

  it('preserves arrival 10-minute transition grace while still catching arrivals after grace expires', () => {
    const av = makeAirportValues(true);
    const timelineWithSwitch = {
      initialRunways: ['01'],
      timeline: [{ time: '06:00:00', changes: [{ source: '01', dest: '19' }] }],
    };

    const makeArr = (cs, reg, stand, landing, inBlock) => ({
      CallSign: cs,
      AirlineName: 'CES',
      AircraftType: 'AIRBUS A-320neo',
      Registration: reg,
      DepartureAirport: 'ZSPD',
      Stand: stand,
      Runway: '01',
      Airway: 'WFG91A',
      LandingTime: landing,
      InBlockTime: inBlock,
      Voice: 'v_zh_1',
      Language: 'zh',
      isDeparture: false,
    });

    // 06:09:30 is 570s after 06:00:00 deactivation -> within 600s grace -> valid
    const withinGrace = [makeArr('CES5101', 'B-3001', '1', '06:09:30', '06:15:00')];
    expect(runTripleValidation(withinGrace, av, 'ZSJN', null, null, '05:35:00', '06:30:00', timelineWithSwitch)).toEqual([]);

    // 06:10:30 is 630s after 06:00:00 deactivation -> past 600s grace -> inactive at landing (NOT timeline-absent)
    const pastGrace = [makeArr('CES5102', 'B-3002', '2', '06:10:30', '06:16:00')];
    const pastIssues = runTripleValidation(pastGrace, av, 'ZSJN', null, null, '05:35:00', '06:30:00', timelineWithSwitch);
    expect(pastIssues.length).toBe(1);
    expect(pastIssues[0]).toContain('CES5102');
    expect(pastIssues[0]).toMatch(/未激活|not active/i);
  });

  it('leaves v2 editor validation, MCP validation, and v2 save behavior unchanged', () => {
    const avV2 = makeAirportValues(false);
    const timelineOnly01 = { initialRunways: ['01'], timeline: [] };
    const depOn19 = [{
      CallSign: 'CES5101',
      AirlineName: 'CES',
      AircraftType: 'AIRBUS A-320neo',
      Registration: 'B-3001',
      ArrivalAirport: 'ZSPD',
      Stand: '1',
      Runway: '19',
      OffBlockTime: '05:50:00',
      TakeoffTime: '05:58:00',
      Voice: 'v_zh_1',
      Language: 'zh',
      isDeparture: true,
    }];

    expect(runTripleValidation(depOn19, avV2, 'ZSJN', null, null, '05:35:00', '06:30:00', timelineOnly01)).toEqual([]);
    const v2Constraints = buildConstraints(
      {
        currentAirport: 'ZSJN',
        airportValues: avV2,
        _configStartTime: '05:35:00',
        _configEndTime: '06:30:00',
        runwayTimeline: timelineOnly01,
      },
      null,
    );
    expect(validateFlightObjects([], depOn19, v2Constraints)).toBeNull();

    // v2 ACL save round-trip remains unaffected
    const tmpDir = makeTmpDir('ac27-v2-unchanged-');
    const dstV2 = path.join(tmpDir, 'ZSJN_leisure_1.acl');
    fs.copyFileSync(V2_ZSJN_LEISURE, dstV2);
    const loaded = parser.loadFlights(dstV2);
    const approachCache = parser.buildApproachCache(path.dirname(V2_ZSJN_LEISURE));
    const depIdx = loaded.flights.findIndex((f) => f.isDeparture);
    expect(depIdx).toBeGreaterThanOrEqual(0);
    const editedV2Flights = loaded.flights.map((f, i) => (i === depIdx ? { ...f, Runway: '19' } : f));
    parser.generateFullAcl(dstV2, editedV2Flights, null, null, null, null, approachCache, loaded.startTime);
    const v2Gc = runChecks(analyzeAclFile(dstV2));
    expect(v2Gc.issues.some((i) => i.code === 'runway-not-in-timeline')).toBe(false);
  });
});

describe('v3 Runway Timeline Membership — Candidate Write Boundary & Gamecompat Gate (Fixtures)', () => {
  it('rejects saving a v3 departure on a runway absent from MetaData.RunwayTimeline without touching .acl, .bak, or sidecars', () => {
    const tmpDir = makeTmpDir('ac27-v3-write-gate-');
    const dstAcl = path.join(tmpDir, 'ZSJN_leisure_1.acl');
    const bakAcl = `${dstAcl}.bak`;
    const csvSidecar = path.join(tmpDir, 'flight_schedule_leisure_1.csv');
    fs.copyFileSync(path.join(ZSJN_V3_DIR, 'ZSJN_leisure_1.acl'), dstAcl);
    fs.copyFileSync(dstAcl, bakAcl);
    fs.writeFileSync(csvSidecar, 'CallSign,Runway\nKEEP,01\n', 'utf8');

    const preAclSha = sha256File(dstAcl);
    const preBakSha = sha256File(bakAcl);
    const preCsvSha = sha256File(csvSidecar);

    const approachCache = parser.buildApproachCache(ZSJN_V3_DIR);
    const handle = openAclFile(dstAcl);
    const { flights } = handle.readFlights(dstAcl);
    // ZSJN_leisure_1.acl has InitialRunways = ["01"] and no changes; scenery also has "19"
    const depIdx = flights.findIndex((f) => f.isDeparture);
    expect(depIdx).toBeGreaterThanOrEqual(0);
    const badFlights = flights.map((f, idx) => (idx === depIdx ? { ...f, Runway: '19' } : f));

    handle.applyEdits({ flights: badFlights, approachCache, filePath: dstAcl });
    let caught = null;
    try {
      handle.saveToFile(dstAcl, { createBackup: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunwayTimelineMembershipError);
    expect(caught.code).toBe('V3_RUNWAY_TIMELINE_MEMBERSHIP');
    expect(caught.issues.length).toBe(1);
    expect(caught.issues[0]).toMatchObject({
      callsign: flights[depIdx].CallSign,
      direction: 'departure',
      runway: '19',
    });
    expect(sha256File(dstAcl)).toBe(preAclSha);
    expect(sha256File(bakAcl)).toBe(preBakSha);
    expect(sha256File(csvSidecar)).toBe(preCsvSha);

    // Activating 01 -> 19 in RunwayTimeline makes the exact same schedule save cleanly
    handle.applyEdits({
      runwayTimeline: {
        initialRunways: ['01'],
        timeline: [{ time: '06:05:00', changes: [{ source: '01', dest: '19' }] }],
      },
    });
    handle.saveToFile(dstAcl, { createBackup: true });
    const gc = runChecks(analyzeAclFile(dstAcl));
    expect(gc.issues.filter((i) => i.code === 'runway-not-in-timeline')).toEqual([]);
  });

  it(' checks both legs of a dual-leg StaticData FlightPlan at the v3 write boundary and keeps invalid files openable for repair', () => {
    const tmpDir = makeTmpDir('ac27-v3-dual-leg-');
    const dstAcl = path.join(tmpDir, 'ZSJN_leisure_1.acl');
    fs.copyFileSync(path.join(ZSJN_V3_DIR, 'ZSJN_leisure_1.acl'), dstAcl);

    const handle = openAclFile(dstAcl);
    const schema = getSchemaForHash(handle.header.schemaHash);
    const stIdx = indexDocumentGraph(handle.container.staticData, schema.roots.static, schema);
    const siDict = resolveGraphNode(handle.container.staticData.StaticItems, stIdx);

    let arrPlanObj = null;
    let depLegSample = null;
    for (const [k, rawV] of dictEntries(siDict)) {
      if (!k.startsWith('flight-plan:')) continue;
      const fp = resolveGraphNode(rawV, stIdx);
      const arr = resolveGraphNode(fp?.InitialArrival, stIdx);
      const dep = resolveGraphNode(fp?.InitialDeparture, stIdx);
      if (arr && !dep && !arrPlanObj) arrPlanObj = fp;
      if (dep && !depLegSample) depLegSample = dep;
    }
    expect(arrPlanObj).toBeTruthy();
    expect(depLegSample).toBeTruthy();

    // Attach a second leg (InitialDeparture on non-timeline runway "19") onto an arrival plan
    const { $id: _dropDollarId, id: _dropId, ...depClone } = depLegSample;
    arrPlanObj.InitialDeparture = {
      $id: '999999',
      ...depClone,
      CallSign: 'CES9999',
      Runway: '19',
    };

    expect(() => handle.saveToFile(dstAcl)).toThrow(RunwayTimelineMembershipError);

    // Write raw container directly to simulate a pre-existing broken .acl on disk:
    // openAclFile MUST still open it for repair, and gamecompat runChecks MUST flag it!
    const rawBroken = encodeV3Container(handle.container, { forceReencode: true });
    const brokenPath = path.join(tmpDir, 'broken_dual.acl');
    fs.writeFileSync(brokenPath, rawBroken);

    const reopened = openAclFile(brokenPath, { validateOnOpen: true });
    expect(reopened.format).toBe('gatcarc4-v3');

    const gc = runChecks(analyzeAclFile(brokenPath));
    const tlIssues = gc.issues.filter((i) => i.code === 'runway-not-in-timeline');
    expect(tlIssues.length).toBe(1);
    expect(tlIssues[0].msg).toContain('CES9999');
    expect(tlIssues[0].msg).toContain('19');
  });

  it('rejects Ground Painter saves when runway timeline loses a flight-referenced runway without touching target files', () => {
    const tmpDir = makeTmpDir('ac27-v3-gp-tl-');
    const dstAcl = path.join(tmpDir, 'ZSJN_runwaychange.acl');
    fs.copyFileSync(path.join(ZSJN_V3_DIR, 'ZSJN_runwaychange.acl'), dstAcl);

    const h = openAclFile(dstAcl);
    // Corrupt MetaData.RunwayTimeline in a disposable copy to omit "19", then attempt Ground Painter save
    h.applyEdits({ runwayTimeline: { initialRunways: ['01'], timeline: [] } });
    // Force write raw bytes to simulate a timeline mismatch when saving scenery
    fs.writeFileSync(dstAcl, encodeV3Container(h.container));
    const preSha = sha256File(dstAcl);

    const snap = openAclFile(dstAcl).readSceneryGraph();
    expect(() =>
      saveV3GroundPainterData({
        filePath: dstAcl,
        graph: snap.graph,
        meta: snap.meta,
        createBackup: true,
      }),
    ).toThrow(RunwayTimelineMembershipError);
    expect(sha256File(dstAcl)).toBe(preSha);
    expect(fs.existsSync(`${dstAcl}.bak`)).toBe(false);
  });
});

describe.runIf(Boolean(CLEAN_KJFK_LEISURE_1))('v3 Runway Timeline Membership — Disposable KJFK_leisure_1 Exact Reproduction', () => {
  it('passes pre-fuzz KJFK_leisure_1 schedule and rejects ETD8349 (A6-UYY) on 22R when timeline omits 22R', () => {
    const tmpDir = makeTmpDir('ac27-kjfk-l1-');
    const tmpLevels = path.join(tmpDir, 'GroundATC_Data/StreamingAssets/Airports/KJFK/Levels');
    fs.mkdirSync(tmpLevels, { recursive: true });
    stageV3AudioIntoRoot(tmpDir, 'KJFK', GAME_ROOT);
    const dstAcl = path.join(tmpLevels, 'KJFK_leisure_1.acl');
    const bakAcl = `${dstAcl}.bak`;
    fs.copyFileSync(CLEAN_KJFK_LEISURE_1, dstAcl);
    fs.copyFileSync(CLEAN_KJFK_LEISURE_1, bakAcl);

    // 1. Pre-fuzz KJFK_leisure_1 baseline passes all checks
    const baseHandle = openAclFile(dstAcl);
    expect(validateV3ContainerRunwayTimelineMembership(baseHandle.container).issues).toEqual([]);
    const baseGc = runChecks(analyzeAclFile(dstAcl));
    expect(baseGc.issues.filter((i) => i.code === 'runway-not-in-timeline')).toEqual([]);

    // 2. Reproduce exact ETD8349 (A6-UYY) departure on scenery runway 22R while timeline is [13L, 22L, 31L, 4L]
    const preAclSha = sha256File(dstAcl);
    const preBakSha = sha256File(bakAcl);
    const approachCache = parser.buildApproachCache(path.dirname(CLEAN_KJFK_LEISURE_1));
    const { flights } = baseHandle.readFlights(dstAcl);
    const sceneryGraph = baseHandle.readSceneryGraph().graph;
    const allRunwayEnds = sceneryGraph.runways.flatMap((rw) => rw.names || []);
    expect(allRunwayEnds).toContain('22R');

    const sampleDep = flights.find((f) => f.isDeparture) || flights[0];
    const etd8349 = {
      ...sampleDep,
      CallSign: 'ETD8349',
      AirlineName: 'ETD',
      FlightNumber: 'EY8349',
      Registration: 'A6-UYY',
      _Registration: 'A6-UYY',
      Stand: 't2-86',
      Runway: '22R',
      OffBlockTime: '08:24:58',
      TakeoffTime: '08:26:52',
      LandingTime: '',
      InBlockTime: '',
      Airway: '',
      FlightType: 'Departure',
      isDeparture: true,
    };

    const fuzzedTimeline = {
      initialRunways: ['13L', '22L', '31L', '4L'],
      timeline: [],
    };
    // Keep existing flights mapped onto timeline-valid 22L/13L, plus offending ETD8349 on 22R
    const scheduleWithEtd = [
      ...flights.map((f) => (f.Runway === '13R' ? { ...f, Runway: '22L' } : f)),
      etd8349,
    ];

    // Check shared helper directly
    const pureRes = validateFlightRunwayTimelineMembership(scheduleWithEtd, fuzzedTimeline);
    expect(pureRes.issues).toMatchObject([
      {
        registration: 'A6-UYY',
        callsign: 'ETD8349',
        direction: 'departure',
        runway: '22R',
      },
    ]);

    // Check editor runTripleValidation
    const kv = parser.collectUniqueValues([CLEAN_KJFK_LEISURE_1]);
    kv._isV3 = true;
    kv._v3Audio = true;
    kv.AirlineCode = [...new Set([...(kv.AirlineCode || []), 'ETD'])];
    kv._flightNums = { ...(kv._flightNums || {}), ETD: ['8349'] };
    const editorIssues = runTripleValidation(
      scheduleWithEtd,
      { KJFK: kv },
      'KJFK',
      null,
      null,
      '08:00:00',
      '09:00:00',
      fuzzedTimeline,
    );
    expect(editorIssues.some((m) => m.includes('ETD8349') && m.includes('22R'))).toBe(true);

    // Check v3 write boundary rejects and leaves .acl and .acl.bak byte-identical
    baseHandle.applyEdits({
      flights: scheduleWithEtd,
      runwayTimeline: fuzzedTimeline,
      approachCache,
      filePath: dstAcl,
    });
    expect(() => baseHandle.saveToFile(dstAcl, { createBackup: true })).toThrow(RunwayTimelineMembershipError);
    expect(sha256File(dstAcl)).toBe(preAclSha);
    expect(sha256File(bakAcl)).toBe(preBakSha);

    // Reassigning ETD8349 to 22L allows saveToFile and gamecompat checks to succeed cleanly
    const fixedSchedule = scheduleWithEtd.map((f) => (f.CallSign === 'ETD8349' ? { ...f, Runway: '22L' } : f));
    baseHandle.applyEdits({
      flights: fixedSchedule,
      runwayTimeline: fuzzedTimeline,
      approachCache,
      filePath: dstAcl,
    });
    baseHandle.saveToFile(dstAcl, { createBackup: true });
    const postGc = runChecks(analyzeAclFile(dstAcl));
    expect(postGc.issues.filter((i) => i.code === 'runway-not-in-timeline')).toEqual([]);
  });
});

describe('v3 Runway Timeline Membership — Vite Dev ESM & CJS Interop', () => {
  it('serves native ESM named exports in Vite dev server while remaining CJS-requireable', async () => {
    const { createServer } = await import('vite');
    const server = await createServer({ configFile: false, logLevel: 'silent' });
    try {
      const res = await server.transformRequest('/src/acl/runway_timeline_membership.js');
      expect(res?.code).toBeTruthy();
      expect(res.code).not.toMatch(/\bmodule\.exports\b/);
      expect(res.code).toMatch(/\bexport\s+function\s+collectRunwayTimelineMembers\b/);
      expect(res.code).toMatch(/\bexport\s+function\s+validateFlightRunwayTimelineMembership\b/);
      expect(res.code).toMatch(/\bexport\s+function\s+formatRunwayTimelineMembershipIssue\b/);
    } finally {
      await server.close();
    }

    const cjsMod = require('../../src/acl/runway_timeline_membership');
    expect(typeof cjsMod.collectRunwayTimelineMembers).toBe('function');
    expect(typeof cjsMod.validateFlightRunwayTimelineMembership).toBe('function');
    expect(typeof cjsMod.formatRunwayTimelineMembershipIssue).toBe('function');
  });
});
