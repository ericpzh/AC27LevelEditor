/**
 * GATCARC4 v3 flight-save parity suite.
 *
 * Provides 1-to-1 GATCARC4 v3 coverage mirroring the Odin v2 flight-save integration
 * suites against `tests/fixtures/game-root-v3`:
 *   - `save_gamecompat.test.js` (duplicate reg deduplication, docked-stand conflict,
 *     arrival stand gap, deleted flight frame purge, missing/bogus STAR auto-repair,
 *     ARR->DEP stand conflict rejection)
 *   - `new_departure_save.test.js` (omitted `isDeparture`, empty `AirlineName`, 3-letter callsign)
 *   - `save_leg_type_idempotent.test.js` (all-departures save -> reopen -> add arrival -> save)
 *   - `zeroflight_save.test.js` (empty schedule `[]` preserves scenery, jetways, radio channels, singletons)
 *   - `voice_language_normalization.test.js` (CN vs non-CN carrier language & captain voice repair,
 *     `radio_template_zh.csv` airport detection, `runChecks` raw mismatch detection)
 *   - `state5_output_pr.test.js`, `animator_lean_scope.test.js`, `aerodrome_code.test.js`,
 *     & `flightplan_ref_integrity.test.js` (`_state=5` `ProgressRatio===0` vs `_state=30` `>0`,
 *     `Specification`-free `Aircraft`, zeroed `_groundIdleTimerState`, `Version=3` paired
 *     `aircraft-animator:aircraft:<REG>`, `FlightPlan.StaticItem` PK ref integrity, aerodrome ICAO preservation)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FIXTURES_GAME_ROOT_V3, stageV3AudioIntoRoot } from '../helpers/gameRoot';

const require = createRequire(import.meta.url);
const parser = require('../../src/acl/parser');
const { openAclFile, detectAclFormat } = require('../../src/acl/archive');
const { buildApproachCache } = require('../../src/acl/approach');
const { GAME_STAND_MIN_GAP_SEC, _airportSupportsChinese } = require('../../src/acl/flight_plans');
const { getSchemaForHash } = require('../../src/acl/v3/schema_registry');
const { validateV3Container } = require('../../src/acl/v3/validator');
const { loadV3AirportAudio } = require('../../src/acl/v3/audio');
const {
  dictEntries,
  dictGet,
  indexDocumentGraph,
  resolveGraphNode,
  unwrapReactive,
} = require('../../src/acl/v3/graph');
const { decodeQ32, decodePosition3ToGu } = require('../../src/acl/v3/q32');
const { analyzeV3, analyzeAclFile, runChecks, timeStrToSec } = require('./gamecompat-utils.cjs');

const ICAO = 'ZSJN';
const LEVEL = 'ZSJN_leisure_1.acl';
const FIXTURE_ACL = path.join(
  FIXTURES_GAME_ROOT_V3,
  'GroundATC_Data',
  'StreamingAssets',
  'Airports',
  ICAO,
  'Levels',
  LEVEL,
);
const FIXTURE_LEVEL_DIR = path.dirname(FIXTURE_ACL);
const approachCache = buildApproachCache(FIXTURE_LEVEL_DIR);

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const secToTime = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/**
 * Stage an isolated StreamingAssets hierarchy in `os.tmpdir()` with optional
 * Chinese support (`includeZhTemplate = true` by default).
 */
function stageTempV3Level({ includeZhTemplate = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-v3-flight-'));
  tmpDirs.push(root);

  const saSrc = path.join(FIXTURES_GAME_ROOT_V3, 'GroundATC_Data', 'StreamingAssets');
  const saDst = path.join(root, 'GroundATC_Data', 'StreamingAssets');
  const apSrc = path.join(saSrc, 'Airports', ICAO);
  const apDst = path.join(saDst, 'Airports', ICAO);
  const levelDir = path.join(apDst, 'Levels');
  const voicesDst = path.join(saDst, 'Voices');
  fs.mkdirSync(levelDir, { recursive: true });
  fs.mkdirSync(voicesDst, { recursive: true });

  for (const f of ['aircraft_profiles.csv', 'aircraft_registration_rules.cfg', 'airline_country_registry.cfg']) {
    const s = path.join(saSrc, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(saDst, f));
  }
  const vcSrc = path.join(saSrc, 'Voices', 'voice_catalog.json');
  if (fs.existsSync(vcSrc)) fs.copyFileSync(vcSrc, path.join(voicesDst, 'voice_catalog.json'));
  stageV3AudioIntoRoot(root, ICAO, FIXTURES_GAME_ROOT_V3);

  const apFiles = [
    'airport_brief.json',
    'radio_template_en.csv',
    'stand_aircraft_compatibility.json',
    'stand_constraints.csv',
  ];
  if (includeZhTemplate) apFiles.push('radio_template_zh.csv');
  for (const f of apFiles) {
    const s = path.join(apSrc, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(apDst, f));
  }

  const aclPath = path.join(levelDir, LEVEL);
  fs.copyFileSync(FIXTURE_ACL, aclPath);
  for (const ext of ['.aclcfg', '.timeline.json']) {
    const s = FIXTURE_ACL.replace(/\.acl$/i, ext);
    if (fs.existsSync(s)) fs.copyFileSync(s, aclPath.replace(/\.acl$/i, ext));
  }

  const airlineCountries = JSON.parse('{}');
  const regPath = path.join(saDst, 'airline_country_registry.cfg');
  if (fs.existsSync(regPath)) {
    for (const line of fs.readFileSync(regPath, 'utf-8').split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Z0-9]{2,4})\s*=\s*([A-Z]{2})\b/);
      if (m) airlineCountries[m[1]] = m[2];
    }
  }
  const voiceCatalog = {};
  const voiceLanguages = {};
  if (fs.existsSync(path.join(voicesDst, 'voice_catalog.json'))) {
    const rawVc = JSON.parse(fs.readFileSync(path.join(voicesDst, 'voice_catalog.json'), 'utf-8'));
    for (const v of rawVc.voices || []) {
      if (v && v.name) {
        voiceCatalog[v.name] = { language: v.language, role: v.role };
        voiceLanguages[v.name] = v.language;
      }
    }
  }

  const allStandIds = openAclFile(aclPath).readSceneryGraph().graph.stands.map((s) => s.identifier || s.name);
  const usedStandIds = new Set(parser.loadFlights(aclPath).flights.map((f) => String(f.Stand || '').trim()));
  const freeStands = allStandIds.filter((s) => s && !usedStandIds.has(s));

  return { root, aclPath, levelDir, airlineCountries, voiceCatalog, voiceLanguages, freeStands };
}

// ── 1. save_gamecompat v3 parity ─────────────────────────────────────────────

describe('GATCARC4 v3 — save pipeline game-compatibility invariants', () => {
  it('control: unmodified ZSJN_leisure_1.acl re-saved passes all gamecompat checks', () => {
    const { aclPath, airlineCountries, voiceLanguages } = stageTempV3Level();
    const { flights } = parser.loadFlights(aclPath);
    parser.generateFullAcl(aclPath, flights, undefined, undefined, undefined, undefined, approachCache, undefined, undefined);

    expect(detectAclFormat(fs.readFileSync(aclPath))).toBe('gatcarc4-v3');
    const a = analyzeAclFile(aclPath);
    const res = runChecks(a, {
      voiceLanguages,
      airlineCountries,
      languages: ['en', 'zh'],
    });
    expect(res.issues).toEqual([]);
  });

  it('condition 1 (same-reg ARR+DEP on docked stand): deduplicates registration and keeps docked aircraft intact', () => {
    const { aclPath, freeStands } = stageTempV3Level();
    const pre = analyzeAclFile(aclPath);
    const dock = pre.frameDocked[0];
    const dockedReg = dock.reg;

    const { flights } = parser.loadFlights(aclPath);
    const depIdx = flights.findIndex((f) => f.isDeparture && (f._Registration || f.Registration) === dockedReg);
    const arrIdx = flights.findIndex((f) => !f.isDeparture && (f._Registration || f.Registration) !== dockedReg);
    expect(depIdx).toBeGreaterThanOrEqual(0);
    expect(arrIdx).toBeGreaterThanOrEqual(0);

    flights[arrIdx] = {
      ...flights[arrIdx],
      _Registration: dockedReg,
      Registration: dockedReg,
      Stand: freeStands[0],
    };

    const handle = openAclFile(aclPath);
    const editRes = handle.applyEdits({ flights, approachCache });
    expect(editRes.compatStats.renamed).toBeGreaterThanOrEqual(1);
    handle.saveToFile(aclPath);

    const post = analyzeAclFile(aclPath);
    expect(runChecks(post).issues).toEqual([]);
    expect(post.frameAircraftRegs).toContain(dockedReg);
  });

  it('condition 2 (arrival on stand held by post-endTime docked departure): moves arrival to a free stand', () => {
    const { aclPath } = stageTempV3Level();
    const pre = analyzeAclFile(aclPath);
    const { flights } = parser.loadFlights(aclPath);

    // Pick a docked departure whose stand has NO pre-existing arrival so moving its
    // OffBlockTime past scenario end does not trip the pre-save ARR->DEP stand conflict gate.
    const dock = pre.frameDocked.find(
      (d) => !flights.some((f) => !f.isDeparture && f.Stand === d.stand && (f._Registration || f.Registration) !== d.reg),
    );
    expect(dock).toBeTruthy();
    const dockedReg = dock.reg;

    const dep = flights.find((f) => f.isDeparture && (f._Registration || f.Registration) === dockedReg);
    expect(dep).toBeTruthy();

    // Push departure's OffBlockTime well past scenario endTime + 30 min so its stand is permanently held
    const endSec = pre.config.endSec || 22500;
    dep.OffBlockTime = secToTime(endSec + 3600);
    dep.TakeoffTime = secToTime(endSec + 4200);

    const arr = flights.find((f) => !f.isDeparture && (f._Registration || f.Registration) !== dockedReg);
    expect(arr).toBeTruthy();
    arr.Stand = dep.Stand;
    arr.LandingTime = secToTime(endSec + 3900);
    arr.InBlockTime = secToTime(endSec + 4500);

    const handle = openAclFile(aclPath);
    const editRes = handle.applyEdits({ flights, approachCache });
    expect(editRes.compatStats.moved).toBeGreaterThanOrEqual(1);
    handle.saveToFile(aclPath);

    const post = analyzeAclFile(aclPath);
    expect(runChecks(post).issues.filter((i) => i.code === 'docked-stand-blocked')).toEqual([]);
  });

  it('condition 3 (two arrivals 5 min apart on one stand): moves second arrival to satisfy GAME_STAND_MIN_GAP_SEC', () => {
    const { aclPath } = stageTempV3Level();
    const { flights } = parser.loadFlights(aclPath);
    const arrs = flights.filter((f) => !f.isDeparture);
    expect(arrs.length).toBeGreaterThanOrEqual(2);

    const t0 = timeStrToSec(arrs[0].LandingTime) || 29400;
    arrs[1].Stand = arrs[0].Stand;
    arrs[1].LandingTime = secToTime(t0 + Math.min(300, Math.floor(GAME_STAND_MIN_GAP_SEC / 4)));
    arrs[1].InBlockTime = secToTime(t0 + 600);

    const handle = openAclFile(aclPath);
    const editRes = handle.applyEdits({ flights, approachCache });
    expect(editRes.compatStats.moved).toBeGreaterThanOrEqual(1);
    handle.saveToFile(aclPath);

    const post = analyzeAclFile(aclPath);
    expect(runChecks(post).issues.filter((i) => i.code === 'arrival-stand-gap')).toEqual([]);
  });

  it('condition 4 (arrival with empty Airway on valid runway): auto-fills STAR from Runway.Routes', () => {
    const { aclPath } = stageTempV3Level();
    const { flights } = parser.loadFlights(aclPath);
    const arr = flights.find((f) => !f.isDeparture);
    expect(arr).toBeTruthy();
    arr.Airway = '';
    arr.Runway = '01';

    const handle = openAclFile(aclPath);
    const editRes = handle.applyEdits({ flights, approachCache });
    expect(editRes.compatStats.starred).toBeGreaterThanOrEqual(1);
    handle.saveToFile(aclPath);

    const post = analyzeAclFile(aclPath);
    expect(runChecks(post).issues.filter((i) => i.code === 'arrival-no-star')).toEqual([]);
    const reloaded = parser.loadFlights(aclPath).flights.find(
      (f) => (f._Registration || f.Registration) === (arr._Registration || arr.Registration),
    );
    expect(reloaded?.Airway).toBeTruthy();
  });

  it('condition 5 (arrival with empty Airway on bogus runway "99"): switches runway and fills valid STAR', () => {
    const { aclPath } = stageTempV3Level();
    const { flights } = parser.loadFlights(aclPath);
    const arr = flights.find((f) => !f.isDeparture);
    expect(arr).toBeTruthy();
    arr.Airway = '';
    arr.Runway = '99';

    const handle = openAclFile(aclPath);
    const editRes = handle.applyEdits({ flights, approachCache });
    expect(editRes.compatStats.starred).toBeGreaterThanOrEqual(1);
    handle.saveToFile(aclPath);

    const post = analyzeAclFile(aclPath);
    expect(runChecks(post).issues.filter((i) => i.code === 'arrival-no-star')).toEqual([]);
    const reloaded = parser.loadFlights(aclPath).flights.find(
      (f) => (f._Registration || f.Registration) === (arr._Registration || arr.Registration),
    );
    expect(['01', '19']).toContain(reloaded?.Runway);
    expect(reloaded?.Airway).toBeTruthy();
  });

  it('condition 6 (cross-reg ARR before DEP on same stand): throws stand conflict before modifying file', () => {
    const { aclPath } = stageTempV3Level();
    const bytesBefore = fs.readFileSync(aclPath);
    const { flights } = parser.loadFlights(aclPath);
    const arr = flights.find((f) => !f.isDeparture);
    const dep = flights.find(
      (f) => f.isDeparture && (f._Registration || f.Registration) !== (arr._Registration || arr.Registration),
    );
    expect(arr).toBeTruthy();
    expect(dep).toBeTruthy();

    arr.Stand = '300';
    arr.LandingTime = '08:30:00';
    arr.InBlockTime = '08:35:00';
    dep.Stand = '300';
    dep.OffBlockTime = '09:00:00';
    dep.TakeoffTime = '09:10:00';

    expect(() =>
      parser.generateFullAcl(aclPath, flights, undefined, undefined, undefined, undefined, approachCache, undefined, undefined),
    ).toThrow(/Stand|conflict/i);
    expect(fs.readFileSync(aclPath).equals(bytesBefore)).toBe(true);
  });
});

// ── 2. new_departure_save, save_leg_type_idempotent, & zeroflight_save v3 ───

describe('GATCARC4 v3 — departure inference, leg-type idempotency, and zero-flight saves', () => {
  it('infers isDeparture when omitted on a newly added 3-letter-callsign departure with empty AirlineName', () => {
    const { aclPath, freeStands } = stageTempV3Level();
    const { flights } = parser.loadFlights(aclPath);
    const templateDep = flights.find((f) => f.isDeparture);
    expect(templateDep).toBeTruthy();

    const newDep = {
      ...templateDep,
      CallSign: 'CCA2761',
      _Registration: 'B-NEW3',
      Registration: 'B-NEW3',
      AirlineName: '',
      Stand: freeStands[0],
      LandingTime: '',
      InBlockTime: '',
      OffBlockTime: '10:25:00',
      TakeoffTime: '10:35:00',
      DepartureAirport: ICAO,
      ArrivalAirport: 'ZUUU',
    };
    delete newDep.isDeparture;

    parser.generateFullAcl(
      aclPath,
      [...flights, newDep],
      undefined,
      undefined,
      undefined,
      undefined,
      approachCache,
      undefined,
      undefined,
    );

    const saved = openAclFile(aclPath, { validateOnOpen: true });
    validateV3Container(saved.container);

    const reloaded = parser.loadFlights(aclPath).flights;
    const found = reloaded.find((f) => (f._Registration || f.Registration) === 'B-NEW3');
    expect(found).toBeTruthy();
    expect(found.isDeparture).toBe(true);
    expect(found.CallSign).toBe('CCA2761');
    expect(found.OffBlockTime).toBe('10:25:00');
  });

  it('re-adds an arrival cleanly after saving an all-departures v3 schedule (leg-type idempotency)', () => {
    const { aclPath, freeStands } = stageTempV3Level();
    const { flights } = parser.loadFlights(aclPath);
    const onlyDeps = flights.filter((f) => f.isDeparture);
    const sampleArr = flights.find((f) => !f.isDeparture);
    expect(onlyDeps.length).toBeGreaterThan(0);
    expect(sampleArr).toBeTruthy();

    // Step 1: save departures-only schedule (zero InitialArrival objects anywhere in StaticItems)
    parser.generateFullAcl(aclPath, onlyDeps, undefined, undefined, undefined, undefined, approachCache, undefined, undefined);
    validateV3Container(openAclFile(aclPath).container);
    expect(parser.loadFlights(aclPath).flights.every((f) => f.isDeparture)).toBe(true);

    // Step 2: reopen and add back an arrival on a free stand
    const reopenedDeps = parser.loadFlights(aclPath).flights;
    const addedArr = {
      ...sampleArr,
      _Registration: 'B-ARV3',
      Registration: 'B-ARV3',
      Stand: freeStands[0],
      LandingTime: '08:45:00',
      InBlockTime: '08:52:00',
      DepartureAirport: 'ZBAA',
      ArrivalAirport: ICAO,
    };
    parser.generateFullAcl(
      aclPath,
      [...reopenedDeps, addedArr],
      undefined,
      undefined,
      undefined,
      undefined,
      approachCache,
      undefined,
      undefined,
    );

    const postHandle = openAclFile(aclPath, { validateOnOpen: true });
    validateV3Container(postHandle.container);

    const finalFlights = parser.loadFlights(aclPath).flights;
    const reloadedArr = finalFlights.find((f) => (f._Registration || f.Registration) === 'B-ARV3');
    expect(reloadedArr).toBeTruthy();
    expect(reloadedArr.isDeparture).toBe(false);
    expect(reloadedArr.DepartureAirport).toBe('ZBAA');
  });

  it('saves a zero-flight schedule [] cleanly while preserving scenery, jetways, radio channels, and singletons', () => {
    const { aclPath } = stageTempV3Level();
    const preScenery = openAclFile(aclPath).readSceneryGraph().graph;

    parser.generateFullAcl(aclPath, [], undefined, undefined, undefined, undefined, approachCache, undefined, undefined);

    const saved = openAclFile(aclPath, { validateOnOpen: true });
    expect(saved.format).toBe('gatcarc4-v3');
    validateV3Container(saved.container);

    const schema = getSchemaForHash(saved.header.schemaHash);
    const stIdx = indexDocumentGraph(saved.container.staticData, schema.roots.static, schema);
    const siDict = resolveGraphNode(saved.container.staticData.StaticItems, stIdx);
    const siKeys = dictEntries(siDict).map(([k]) => k);
    expect(siKeys.filter((k) => k.startsWith('flight-plan:'))).toEqual([]);
    expect(siKeys.some((k) => k.startsWith('jetway:'))).toBe(true);
    expect(siKeys.some((k) => k.startsWith('physical-runway:'))).toBe(true);
    expect(siKeys.some((k) => k.startsWith('radio-channel:'))).toBe(true);

    const rtIdx = indexDocumentGraph(saved.container.frames[0].runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(saved.container.frames[0].runtimeData.RuntimeEntities, rtIdx);
    const reKeys = dictEntries(reDict).map(([k]) => k);
    expect(reKeys.filter((k) => k.startsWith('flight-plan:'))).toEqual([]);
    expect(reKeys.filter((k) => k.startsWith('aircraft:'))).toEqual([]);
    expect(reKeys.filter((k) => k.startsWith('aircraft-animator:'))).toEqual([]);
    expect(reKeys.some((k) => k.startsWith('jetway:'))).toBe(true);
    expect(reKeys.some((k) => k.startsWith('radio-channel:'))).toBe(true);
    expect(reKeys.some((k) => k.startsWith('singleton:'))).toBe(true);

    // Every runtime jetway is cleanly undocked
    for (const [k, rawV] of dictEntries(reDict)) {
      if (!k.startsWith('jetway:')) continue;
      const jw = resolveGraphNode(rawV, rtIdx);
      expect(unwrapReactive(jw.DockingAircraft, rtIdx)).toBeNull();
      expect(jw.Status).toBe(0);
    }

    expect(parser.loadFlights(aclPath).flights).toEqual([]);
    const postScenery = saved.readSceneryGraph().graph;
    expect(postScenery.stands.length).toBe(preScenery.stands.length);
    expect(postScenery.runways.length).toBe(preScenery.runways.length);

    // Re-saving [] a second time is idempotent
    parser.generateFullAcl(aclPath, [], undefined, undefined, undefined, undefined, approachCache, undefined, undefined);
    expect(parser.loadFlights(aclPath).flights).toEqual([]);
  });
});

// ── 3. explicit Language & Voice preservation on v3 ─────────────────────────

describe('GATCARC4 v3 — explicit Language & Voice preservation without legacy sidecar heuristics', () => {
  it('preserves submitted explicit Language and Voice pairs verbatim (including cross-language selections) without auto-rewriting', () => {
    const { root, aclPath, voiceCatalog, freeStands } = stageTempV3Level({ includeZhTemplate: true });
    const { flights } = parser.loadFlights(aclPath);
    const cnFlight = flights.find((f) => /^CES|^CSN|^CCA|^CSC/.test(f.CallSign));
    expect(cnFlight).toBeTruthy();

    const enCaptain = Object.entries(voiceCatalog).find(([name, m]) => m.role === 'captain' && m.language === 'en' && name.startsWith('CN-Captain-'))?.[0];
    const zhCaptain = Object.entries(voiceCatalog).find(([, m]) => m.role === 'captain' && m.language === 'zh')?.[0];
    expect(enCaptain).toBeTruthy();
    expect(zhCaptain).toBeTruthy();

    cnFlight.Language = 'en';
    cnFlight.Voice = enCaptain;

    const usedCallsigns = new Set(flights.map((f) => f.CallSign));
    const { v3Audio } = loadV3AirportAudio(root, ICAO);
    const allocatableEnCallsign = (v3Audio.allocatableCallsignsByVoice[enCaptain] || []).find((cs) => !usedCallsigns.has(cs));
    expect(allocatableEnCallsign).toBeTruthy();

    const addedEnFlight = {
      ...cnFlight,
      CallSign: allocatableEnCallsign,
      _Registration: 'B-HKV3',
      Registration: 'B-HKV3',
      Stand: freeStands[0],
      Language: 'en',
      Voice: enCaptain,
      isDeparture: true,
      LandingTime: '',
      InBlockTime: '',
      OffBlockTime: '10:40:00',
      TakeoffTime: '10:50:00',
      DepartureAirport: ICAO,
      ArrivalAirport: 'VHHH',
    };

    const handle = openAclFile(aclPath);
    handle.applyEdits({ flights: [...flights, addedEnFlight], approachCache });
    handle.saveToFile(aclPath);

    const savedFlights = parser.loadFlights(aclPath).flights;
    const savedCn = savedFlights.find((f) => (f._Registration || f.Registration) === (cnFlight._Registration || cnFlight.Registration));
    const savedAdded = savedFlights.find((f) => (f._Registration || f.Registration) === 'B-HKV3');
    expect(savedCn.Language).toBe('en');
    expect(savedCn.Voice).toBe(enCaptain);
    expect(savedAdded.Language).toBe('en');
    expect(savedAdded.Voice).toBe(enCaptain);
  });

  it('preserves Chinese Language and Voice when the airport folder lacks legacy radio_template_zh.csv and audio_clips_zh.json', () => {
    const { aclPath, voiceCatalog } = stageTempV3Level({ includeZhTemplate: false });
    expect(_airportSupportsChinese(aclPath)).toBe(false);

    const { flights } = parser.loadFlights(aclPath);
    const handle = openAclFile(aclPath);
    handle.applyEdits({ flights, approachCache });
    handle.saveToFile(aclPath);

    for (const f of parser.loadFlights(aclPath).flights) {
      expect(f.Language).toBe('zh');
      expect(voiceCatalog[f.Voice]?.language).toBe('zh');
    }
  });

  it('analyzeV3 + runChecks catches raw voice-language-mismatch when Voice and Language disagree', () => {
    const { aclPath, airlineCountries, voiceCatalog, voiceLanguages } = stageTempV3Level({ includeZhTemplate: true });
    const enCaptain = Object.entries(voiceCatalog).find(([, m]) => m.role === 'captain' && m.language === 'en')?.[0];
    expect(enCaptain).toBeTruthy();

    const handle = openAclFile(aclPath);
    const schema = getSchemaForHash(handle.header.schemaHash);
    const stIdx = indexDocumentGraph(handle.container.staticData, schema.roots.static, schema);
    const siDict = resolveGraphNode(handle.container.staticData.StaticItems, stIdx);

    // Directly corrupt one FlightPlanStaticItem inside StaticItems without running applyFlightEdits
    for (const [k, rawV] of dictEntries(siDict)) {
      if (!k.startsWith('flight-plan:')) continue;
      const item = resolveGraphNode(rawV, stIdx);
      const leg = item.InitialDeparture || item.InitialArrival;
      if (leg && /^CES|^CSN|^CCA|^CSC/.test(leg.CallSign || '')) {
        item.Language = 'zh';
        item.Voice = enCaptain; // voice-language-mismatch
        break;
      }
    }

    const rawReport = runChecks(analyzeV3(handle.container), {
      voiceLanguages,
      airlineCountries,
      languages: ['en', 'zh'],
    });
    expect(rawReport.issues.some((i) => i.code === 'voice-language-mismatch')).toBe(true);
  });
});

// ── 4. state5_output_pr, animator_lean_scope, & flightplan_ref_integrity v3 ─

describe('GATCARC4 v3 — airborne state-5/state-30 synthesis, lean Aircraft/Animator, and PK ref integrity', () => {
  it('emits ProgressRatio=0 on state-5 final approach, ProgressRatio>0 on state-30 STAR approach, and lean paired Aircraft/Animator entities', () => {
    const { aclPath, freeStands } = stageTempV3Level();
    const baseHandle = openAclFile(aclPath);
    const snapshotSec = baseHandle.readGameTimeSec();
    expect(Number.isFinite(snapshotSec)).toBe(true);

    const { flights } = parser.loadFlights(aclPath);
    const templateArr = flights.find((f) => !f.isDeparture && f.Airway && f.Runway);
    expect(templateArr).toBeTruthy();

    // Synthesize one close-in arrival (TTL = 75s -> state 5) and one STAR arrival (TTL = 900s -> state 30)
    const arrState5 = {
      ...templateArr,
      CallSign: 'CCA2761',
      _Registration: 'B-ST05',
      Registration: 'B-ST05',
      Stand: freeStands[0],
      LandingTime: secToTime(snapshotSec + 75),
      InBlockTime: secToTime(snapshotSec + 375),
    };
    const arrState30 = {
      ...templateArr,
      CallSign: 'CCA2762',
      _Registration: 'B-ST30',
      Registration: 'B-ST30',
      Stand: freeStands[1],
      LandingTime: secToTime(snapshotSec + 900),
      InBlockTime: secToTime(snapshotSec + 1200),
    };

    const handle = openAclFile(aclPath);
    handle.applyEdits({
      flights: [...flights, arrState5, arrState30],
      approachCache,
    });
    handle.saveToFile(aclPath);

    const saved = openAclFile(aclPath, { validateOnOpen: true });
    validateV3Container(saved.container);

    const schema = getSchemaForHash(saved.header.schemaHash);
    const stIdx = indexDocumentGraph(saved.container.staticData, schema.roots.static, schema);
    const siDict = resolveGraphNode(saved.container.staticData.StaticItems, stIdx);
    const rtIdx = indexDocumentGraph(saved.container.frames[0].runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(saved.container.frames[0].runtimeData.RuntimeEntities, rtIdx);

    const ac5 = resolveGraphNode(dictGet(reDict, 'aircraft:B-ST05'), rtIdx);
    const ac30 = resolveGraphNode(dictGet(reDict, 'aircraft:B-ST30'), rtIdx);
    expect(ac5).toBeTruthy();
    expect(ac30).toBeTruthy();

    // State 5: ApproachDynamicsParams with ProgressRatio === 0, non-zero world position
    expect(unwrapReactive(ac5._state, rtIdx)).toBe(5);
    expect(unwrapReactive(ac5.DynamicsData.DynamicsState, rtIdx)).toBe(2);
    const params5 = resolveGraphNode(ac5.DynamicsData.DynamicsParams, rtIdx);
    expect(params5.$type).toBe('ContextCross.Dynamics.States.ApproachDynamicsParams');
    expect(decodeQ32(params5.ProgressRatio)).toBe(0);
    const pos5 = decodePosition3ToGu(unwrapReactive(ac5._position, rtIdx));
    expect(Math.hypot(pos5.x, pos5.z)).toBeGreaterThan(0.1);

    // State 30: FlyApproachDynamicsParams with ProgressRatio > 0
    expect(unwrapReactive(ac30._state, rtIdx)).toBe(30);
    expect(unwrapReactive(ac30.DynamicsData.DynamicsState, rtIdx)).toBe(1);
    const params30 = resolveGraphNode(ac30.DynamicsData.DynamicsParams, rtIdx);
    expect(params30.$type).toBe('ContextCross.Dynamics.States.FlyApproachDynamicsParams');
    expect(decodeQ32(params30.ProgressRatio)).toBeGreaterThan(0);

    // Every runtime aircraft omits `Specification`, has zeroed `_groundIdleTimerState` on synthesized entities,
    // pairs 1-to-1 with `aircraft-animator:aircraft:<REG>` (Version === 3), and resolves `_flightPlan -> StaticItem`
    for (const reg of ['B-ST05', 'B-ST30']) {
      const ac = resolveGraphNode(dictGet(reDict, `aircraft:${reg}`), rtIdx);
      expect(Object.prototype.hasOwnProperty.call(ac, 'Specification')).toBe(false);
      expect(resolveGraphNode(ac._groundIdleTimerState, rtIdx)).toMatchObject({
        AccumulatedTicks: 0,
        IsRunning: false,
        StartedAtTick: 0,
      });

      const anim = resolveGraphNode(dictGet(reDict, `aircraft-animator:aircraft:${reg}`), rtIdx);
      expect(anim).toBeTruthy();
      expect(anim.Version).toBe(3);
      expect(anim.HasSnapshot).toBe(true);
      expect(resolveGraphNode(anim.Aircraft, rtIdx)).toBe(ac);

      const fp = resolveGraphNode(ac._flightPlan, rtIdx);
      expect(fp).toBe(resolveGraphNode(dictGet(reDict, `flight-plan:${reg}`), rtIdx));
      expect(fp.StaticItem?.$ref).toBe(`pk:ContextCross.Models.FlightPlanStaticItem:flight-plan:${reg}`);
      expect(dictGet(siDict, `flight-plan:${reg}`)).toBeTruthy();
    }
  });
});
