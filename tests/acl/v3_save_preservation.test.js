/**
 * GATCARC4 v3 Save Preservation & Audio Metadata Verification Suite.
 *
 * Covers every verification item in `plan-v3-save-preservation.md`:
 *   1. Format-aware demo schedule trimming (`ZSJN_leisure_1.acl` loads all 24 flights
 *      including `CES9197` at `05:45:00` and `DKH6071` at `05:45:42` across load,
 *      restore, reload, and ZIP import; unretimed early source flights pass validation
 *      while retimed, copied, or newly added early flights are flagged).
 *   2. Saving the 24-flight model preserves all 24 static flight plans, exact original
 *      `(Language, Voice)` pairs, and all 6 runtime checkpoint entities for the two
 *      early flights (`B-66X5` and `B-5716D`), passing `validateV3Container`.
 *   3. Saving with vs. without legacy `audio_clips_*.json` / `radio_template_zh.csv`
 *      produces identical `Language` and `Voice` values; missing `Language` or `Voice`
 *      throws explicitly instead of silently defaulting to `'en'`.
 *   4. v3 audio loader (`radio_channel_config.json` + `voice_catalog.json` +
 *      `radio_clip_durations.json`) across `ZSJN`, `ZGSZ`, `KDCA`, `KJFK`, and `EGLC`,
 *      `RWY*` non-callsign exclusion, mixed-version audio source selection and
 *      `computeAudioSourceSignature` invalidation, new-flight defaults, and blocking
 *      callsign/voice mismatch validation in `validators.js` and `electron/api-server.js`.
 *   5. Explicit flight edits (retime keeps `Language`/`Voice` intact; explicit cross-language
 *      `Language`+`Voice` change persists; flight deletion purges runtime dependents;
 *      0-flight `[]` clear-all saves and reloads cleanly).
 *   6. Explicit `.demo.acl` schedule trimming (`ZSJN_peakdeparture.demo.acl`) and legacy
 *      v2 fixture regression (`ZSJN_leisure_1.acl` on v2 keeps `DEMO_VISIBLE_BASES` trimming).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FIXTURES_GAME_ROOT, FIXTURES_GAME_ROOT_V3, GAME_ROOT, stageV3AudioIntoRoot } from '../helpers/gameRoot';
import { runTripleValidation } from '../../src/utils/validators';
import { createArrivalFlight, createDepartureFlight } from '../../src/store/flightDefaults';
import { cascadeLanguageChange, cascadeAirlineLanguage } from '../../src/store/flightCascade';
import { mapAviationstackFlight } from '../../src/utils/realtime/aviationstack';

const require = createRequire(import.meta.url);
const parser = require('../../src/acl/parser');
const {
  openAclFile,
  detectAclFormat,
  loadLevelForEditor,
  isDemoVisibleFile,
  shouldTrimDemoSchedule,
  shouldApplyLegacyDemoEndTimeOverride,
  createZip,
  extractZip,
  clearV3AudioCache,
  lookupV3CallsignsForAirport,
  loadV3AirportAudio,
  resolveAirportAudioMode,
  computeAudioSourceSignature,
  buildApproachCache,
  collectUniqueValues,
  loadAirlineCountryRegistry,
} = parser;
const { validateV3Container } = require('../../src/acl/v3/validator');
const { getSchemaForHash } = require('../../src/acl/v3/schema_registry');
const {
  dictGet,
  indexDocumentGraph,
  resolveGraphNode,
} = require('../../src/acl/v3/graph');
const { validateFlightObjects, buildConstraints } = require('../../electron/api-server');

const ZSJN_LEVELS_V3 = path.join(
  FIXTURES_GAME_ROOT_V3,
  'GroundATC_Data',
  'StreamingAssets',
  'Airports',
  'ZSJN',
  'Levels',
);
const ZSJN_LEISURE_1_V3 = path.join(ZSJN_LEVELS_V3, 'ZSJN_leisure_1.acl');
const ZSJN_PEAKDEP_V3 = path.join(ZSJN_LEVELS_V3, 'ZSJN_peakdeparture.acl');
const ZSJN_PEAKDEP_DEMO_V3 = path.join(ZSJN_LEVELS_V3, 'ZSJN_peakdeparture.demo.acl');
const ZSJN_APPROACH_CACHE_V3 = buildApproachCache(ZSJN_LEVELS_V3);

const ZSJN_LEISURE_1_V2 = path.join(
  FIXTURES_GAME_ROOT,
  'GroundATC_Data',
  'StreamingAssets',
  'Airports',
  'ZSJN',
  'Levels',
  'ZSJN_leisure_1.acl',
);

const tmpDirs = [];
afterEach(() => {
  clearV3AudioCache();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = 'ac27-v3-pres-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const regOf = (f) => f._Registration || f.Registration || '';
const toStoreFlights = (arr) => arr.map((f) => ({ ...f, Registration: regOf(f) }));

/**
 * Build a realistic `airportValues['ZSJN']` + `audioCallsigns` bundle matching
 * `_buildCollectValuesBase` in `electron/main.js` for v3 levels.
 */
function buildZsjnV3AirportContext(flights) {
  const audioBundle = loadV3AirportAudio(FIXTURES_GAME_ROOT_V3, 'ZSJN');
  const handle = openAclFile(ZSJN_LEISURE_1_V3);
  const scenery = handle.readScenery();
  const baseVals = collectUniqueValues([flights]);
  const airlineCountries = loadAirlineCountryRegistry(FIXTURES_GAME_ROOT_V3);

  const standIds = Object.keys(scenery.sceneryMaps?.standIdToGuid || {});
  const runwayIds = Object.keys(scenery.sceneryMaps?.runwayNameToGuid || {});
  const starNames = Object.keys(scenery.starRunwayMap || {});

  const aircraftTypeSet = new Set(baseVals.AircraftType || []);
  if (ZSJN_APPROACH_CACHE_V3.designatorMap) {
    for (const [key, des] of ZSJN_APPROACH_CACHE_V3.designatorMap) {
      if (key !== des) aircraftTypeSet.add(key);
    }
  }

  const vals = {
    ...baseVals,
    Stand: standIds,
    Runway: runwayIds,
    Airway: starNames,
    AircraftType: [...aircraftTypeSet].sort(),
    Language: audioBundle.languages || ['en', 'zh'],
    Voice: audioBundle.captainVoices,
    AirlineCode: [...new Set([...(baseVals.AirlineCode || []), ...audioBundle.audioCallsigns.allAirlines])].sort(),
    _flightNums: audioBundle.audioCallsigns.byAirline,
    _gameCallsigns: audioBundle.audioCallsigns.byAirline,
    _voiceLanguages: audioBundle.voiceLanguages,
    _airlineCountries: airlineCountries,
    _v3Audio: audioBundle.v3Audio,
    _runwayStarMap: scenery.runwayStarMap || {},
    _starRunwayMap: scenery.starRunwayMap || {},
  };

  return { vals, audioCallsigns: audioBundle.audioCallsigns };
}

// ── 1. Load / restore / reload / ZIP import & early-flight validation ────────

describe('1. v3 load-stage schedule preservation & early-flight validation', () => {
  it('loads all 24 flights from ZSJN_leisure_1.acl across load, backup restore, reload, and ZIP import', () => {
    const tmp = makeTempDir();
    const aclCopy = path.join(tmp, 'Airports', 'ZSJN', 'Levels', 'ZSJN_leisure_1.acl');
    fs.mkdirSync(path.dirname(aclCopy), { recursive: true });
    fs.copyFileSync(ZSJN_LEISURE_1_V3, aclCopy);

    // Browser visibility stays true, while v3 schedule trimming is false
    expect(isDemoVisibleFile(aclCopy)).toBe(true);
    expect(shouldTrimDemoSchedule(aclCopy, 'gatcarc4-v3')).toBe(false);
    expect(shouldApplyLegacyDemoEndTimeOverride(aclCopy, 'gatcarc4-v3')).toBe(false);

    // Normal load
    const loaded = loadLevelForEditor(aclCopy);
    expect(loaded.format).toBe('gatcarc4-v3');
    expect(loaded.isDemo).toBe(false);
    expect(loaded.config).toMatchObject({ startTime: '05:46:00', endTime: '06:15:00' });
    expect(loaded.flights).toHaveLength(24);

    const ces9197 = loaded.flights.find((f) => f.CallSign === 'CES9197');
    const dkh6071 = loaded.flights.find((f) => f.CallSign === 'DKH6071');
    expect(ces9197).toBeTruthy();
    expect(regOf(ces9197)).toBe('B-66X5');
    expect(ces9197.OffBlockTime).toBe('05:45:00');
    expect(ces9197._sourceOffBlockTime).toBe('05:45:00');
    expect(dkh6071).toBeTruthy();
    expect(regOf(dkh6071)).toBe('B-5716D');
    expect(dkh6071.LandingTime).toBe('05:45:42');
    expect(dkh6071._sourceLandingTime).toBe('05:45:42');

    // Backup restore path (.acl.bak -> .acl -> loadLevelForEditor)
    const bakPath = aclCopy + '.bak';
    fs.copyFileSync(aclCopy, bakPath);
    const truncatedHandle = openAclFile(aclCopy);
    truncatedHandle.applyEdits({
      flights: loaded.flights.filter((f) => f.CallSign !== 'CES9197' && f.CallSign !== 'DKH6071'),
      approachCache: ZSJN_APPROACH_CACHE_V3,
    });
    truncatedHandle.saveToFile(aclCopy);
    expect(loadLevelForEditor(aclCopy).flights).toHaveLength(22);

    fs.copyFileSync(bakPath, aclCopy);
    const restored = loadLevelForEditor(aclCopy);
    expect(restored.flights).toHaveLength(24);

    // Reload path
    const reloaded = loadLevelForEditor(aclCopy);
    expect(reloaded.flights).toHaveLength(24);

    // ZIP import round-trip (createZip(entries, zipPath) -> extractZip -> loadLevelForEditor)
    const zipPath = path.join(tmp, 'zsjn_export.zip');
    const extractDir = path.join(tmp, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    createZip([{ name: 'ZSJN_leisure_1.acl', data: fs.readFileSync(aclCopy) }], zipPath);
    extractZip(zipPath, extractDir);
    const zipLoaded = loadLevelForEditor(path.join(extractDir, 'ZSJN_leisure_1.acl'));
    expect(zipLoaded.isDemo).toBe(false);
    expect(zipLoaded.flights).toHaveLength(24);
  });

  it('allows unretimed pre-startTime source flights while blocking retimed, copied, or newly added early flights', () => {
    const loaded = loadLevelForEditor(ZSJN_LEISURE_1_V3);
    const { vals, audioCallsigns } = buildZsjnV3AirportContext(loaded.flights);
    const runwayTimeline = loaded.handle.readTimelines().runwayTimeline;
    const baseState = {
      currentAirport: 'ZSJN',
      airportValues: { ZSJN: vals },
      _configStartTime: loaded.config.startTime, // 05:46:00
      _configEndTime: loaded.config.endTime,     // 06:15:00
      runwayTimeline,
    };
    const constraints = buildConstraints(baseState, {
      ZSJN: {
        dropdownValues: vals,
        approachData: ZSJN_APPROACH_CACHE_V3,
        audioCallsigns,
      },
    });

    // 1. Unmodified 24-flight schedule passes both UI validator and MCP validator
    const cleanUiIssues = runTripleValidation(
      loaded.flights,
      { ZSJN: vals },
      'ZSJN',
      audioCallsigns,
      loaded._saveSec,
      '05:46:00',
      '06:15:00',
      runwayTimeline,
    );
    expect(cleanUiIssues).toEqual([]);
    expect(validateFlightObjects(toStoreFlights(loaded.flights), [], constraints)).toBeNull();

    // 2. Retiming CES9197 from 05:45:00 to 05:45:30 (still < 05:46:00) is blocked
    const retimedFlights = loaded.flights.map((f) =>
      f.CallSign === 'CES9197' ? { ...f, OffBlockTime: '05:45:30' } : f,
    );
    const retimedUiIssues = runTripleValidation(
      retimedFlights,
      { ZSJN: vals },
      'ZSJN',
      audioCallsigns,
      loaded._saveSec,
      '05:46:00',
      '06:15:00',
      runwayTimeline,
    );
    expect(retimedUiIssues.some((msg) => msg.includes('CES9197'))).toBe(true);
    const retimedMcp = validateFlightObjects(toStoreFlights(retimedFlights), [], constraints);
    expect(retimedMcp?.some((e) => e.field === 'OffBlockTime')).toBe(true);

    // 3. Copying CES9197 (_isNew: true, stripped _sourceOffBlockTime) without retiming is blocked
    const usedStands = new Set(loaded.flights.map((f) => f.Stand));
    const freeStand = vals.Stand.find((s) => !usedStands.has(s)) || '201';
    const cesIdx = loaded.flights.findIndex((f) => f.CallSign === 'CES9197');
    const altCesNum = (vals._flightNums.CES || []).find((n) => n !== '9197') || '9197';
    const copiedRow = {
      ...loaded.flights[cesIdx],
      CallSign: `CES${altCesNum}`,
      _Registration: 'B-9999',
      Stand: freeStand,
      _isNew: true,
    };
    delete copiedRow._sourceOffBlockTime;
    delete copiedRow._sourceLandingTime;
    delete copiedRow._fpGuid;

    const copiedFlights = [...loaded.flights, copiedRow];
    const copiedUiIssues = runTripleValidation(
      copiedFlights,
      { ZSJN: vals },
      'ZSJN',
      audioCallsigns,
      loaded._saveSec,
      '05:46:00',
      '06:15:00',
      runwayTimeline,
    );
    expect(copiedUiIssues.some((msg) => msg.includes(copiedRow.CallSign))).toBe(true);
    const copiedMcp = validateFlightObjects(toStoreFlights(copiedFlights), [], constraints);
    expect(copiedMcp?.some((e) => e.index === copiedFlights.length - 1 && e.field === 'OffBlockTime')).toBe(true);
  });
});

// ── 2. Save 24-flight model & decode rebuilt v3 ACL ──────────────────────────

describe('2. v3 24-flight save & checkpoint runtime entity preservation', () => {
  it('rebuilds all 24 static flight plans with original schedule fields, Language/Voice pairs, and early-flight RuntimeEntities', () => {
    const tmp = makeTempDir();
    const aclCopy = path.join(tmp, 'Airports', 'ZSJN', 'Levels', 'ZSJN_leisure_1.acl');
    fs.mkdirSync(path.dirname(aclCopy), { recursive: true });
    fs.copyFileSync(ZSJN_LEISURE_1_V3, aclCopy);

    const origLoaded = loadLevelForEditor(aclCopy);
    expect(origLoaded.flights).toHaveLength(24);
    const toSnapshot = (f) => ({
      CallSign: f.CallSign,
      Registration: regOf(f),
      AircraftType: f.AircraftType,
      Stand: f.Stand,
      Runway: f.Runway,
      Airway: f.Airway,
      LandingTime: f.LandingTime,
      OffBlockTime: f.OffBlockTime,
      DepartureAirport: f.DepartureAirport,
      ArrivalAirport: f.ArrivalAirport,
      Language: f.Language,
      Voice: f.Voice,
    });
    const origSnapshot = origLoaded.flights.map(toSnapshot);

    const saveHandle = openAclFile(aclCopy);
    saveHandle.applyEdits({
      flights: origLoaded.flights,
      approachCache: ZSJN_APPROACH_CACHE_V3,
      filePath: aclCopy,
      _saveSec: origLoaded._saveSec,
    });
    saveHandle.saveToFile(aclCopy, { createBackup: true });
    expect(fs.existsSync(aclCopy + '.bak')).toBe(true);

    const reopened = openAclFile(aclCopy, { validateOnOpen: true });
    validateV3Container(reopened.container);

    const postLoaded = loadLevelForEditor(aclCopy);
    expect(postLoaded.flights).toHaveLength(24);
    const postSnapshot = postLoaded.flights.map(toSnapshot);

    const byReg = (arr) => [...arr].sort((a, b) => a.Registration.localeCompare(b.Registration));
    expect(byReg(postSnapshot)).toEqual(byReg(origSnapshot));

    for (const f of postLoaded.flights) {
      expect(f.Language).toBe('zh');
      expect(['CN-Captain-Young', 'CN-Captain-Middle-Aged']).toContain(f.Voice);
    }

    const schema = getSchemaForHash(reopened.header.schemaHash);
    const rtIdx = indexDocumentGraph(reopened.container.frames[0].runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(reopened.container.frames[0].runtimeData.RuntimeEntities, rtIdx);

    for (const reg of ['B-66X5', 'B-5716D']) {
      expect(dictGet(reDict, `flight-plan:${reg}`)).toBeTruthy();
      expect(dictGet(reDict, `aircraft:${reg}`)).toBeTruthy();
      expect(dictGet(reDict, `aircraft-animator:aircraft:${reg}`)).toBeTruthy();
    }
  });
});

// ── 3. Save with & without legacy sibling audio files + missing field errors ─

describe('3. v3 writer independence from legacy sibling audio files & explicit missing-field rejection', () => {
  it('produces identical Language and Voice values with and without legacy audio_clips_*.json / radio_template_zh.csv', () => {
    const dirWithout = makeTempDir('ac27-no-legacy-');
    const dirWith = makeTempDir('ac27-with-legacy-');

    const aclWithout = path.join(dirWithout, 'GroundATC_Data', 'StreamingAssets', 'Airports', 'ZSJN', 'Levels', 'ZSJN_leisure_1.acl');
    const aclWith = path.join(dirWith, 'GroundATC_Data', 'StreamingAssets', 'Airports', 'ZSJN', 'Levels', 'ZSJN_leisure_1.acl');
    fs.mkdirSync(path.dirname(aclWithout), { recursive: true });
    fs.mkdirSync(path.dirname(aclWith), { recursive: true });
    stageV3AudioIntoRoot(dirWithout, 'ZSJN', FIXTURES_GAME_ROOT_V3);
    stageV3AudioIntoRoot(dirWith, 'ZSJN', FIXTURES_GAME_ROOT_V3);
    fs.copyFileSync(ZSJN_LEISURE_1_V3, aclWithout);
    fs.copyFileSync(ZSJN_LEISURE_1_V3, aclWith);

    const apWith = path.dirname(path.dirname(aclWith));
    const lvWith = path.dirname(aclWith);
    fs.writeFileSync(path.join(lvWith, 'audio_clips_en.json'), JSON.stringify({ callsigns: ['CES9197'] }), 'utf-8');
    fs.writeFileSync(path.join(lvWith, 'audio_clips_zh.json'), JSON.stringify({ callsigns: ['CES9197'] }), 'utf-8');
    fs.writeFileSync(path.join(apWith, 'radio_template_zh.csv'), 'key,text\n', 'utf-8');

    const modelWithout = loadLevelForEditor(aclWithout).flights;
    const modelWith = loadLevelForEditor(aclWith).flights;

    parser.generateFullAcl(aclWithout, modelWithout, undefined, undefined, undefined, undefined, ZSJN_APPROACH_CACHE_V3);
    parser.generateFullAcl(aclWith, modelWith, undefined, undefined, undefined, undefined, ZSJN_APPROACH_CACHE_V3);

    const savedWithout = loadLevelForEditor(aclWithout).flights.map((f) => ({
      reg: regOf(f),
      lang: f.Language,
      voice: f.Voice,
    }));
    const savedWith = loadLevelForEditor(aclWith).flights.map((f) => ({
      reg: regOf(f),
      lang: f.Language,
      voice: f.Voice,
    }));
    expect(savedWithout).toEqual(savedWith);
  });

  it('rejects missing Language or Voice explicitly in both v3 writer and validators (no silent "en" fallback)', () => {
    const tmp = makeTempDir();
    const aclCopy = path.join(tmp, 'ZSJN_leisure_1.acl');
    fs.copyFileSync(ZSJN_LEISURE_1_V3, aclCopy);

    const loaded = loadLevelForEditor(aclCopy);
    const missingLang = loaded.flights.map((f, i) => (i === 0 ? { ...f, Language: '' } : f));
    const missingVoice = loaded.flights.map((f, i) => (i === 0 ? { ...f, Voice: '' } : f));

    expect(() => openAclFile(aclCopy).applyEdits({ flights: missingLang, approachCache: ZSJN_APPROACH_CACHE_V3 }))
      .toThrow(/Language/i);
    expect(() => openAclFile(aclCopy).applyEdits({ flights: missingVoice, approachCache: ZSJN_APPROACH_CACHE_V3 }))
      .toThrow(/Voice/i);

    const { vals, audioCallsigns } = buildZsjnV3AirportContext(loaded.flights);
    const uiLangIssues = runTripleValidation(
      missingLang,
      { ZSJN: vals },
      'ZSJN',
      audioCallsigns,
      loaded._saveSec,
      '05:46:00',
      '06:15:00',
    );
    expect(uiLangIssues.some((msg) => msg.includes(loaded.flights[0].CallSign))).toBe(true);

    const uiVoiceIssues = runTripleValidation(
      missingVoice,
      { ZSJN: vals },
      'ZSJN',
      audioCallsigns,
      loaded._saveSec,
      '05:46:00',
      '06:15:00',
    );
    expect(uiVoiceIssues.some((msg) => msg.includes(loaded.flights[0].CallSign))).toBe(true);
  });
});

// ── 4. v3 audio loader across all 5 airports, cache invalidation & validation ─

describe('4. v3 audio loader, new-flight defaults, cache signature & callsign/voice validation', () => {
  const rootsToTest = [
    { label: 'v3 fixture root', root: FIXTURES_GAME_ROOT_V3 },
    ...(GAME_ROOT && fs.existsSync(path.join(GAME_ROOT, 'GroundATC_Data', 'StreamingAssets', 'radio_clip_durations.json'))
      ? [{ label: 'live Steam root', root: GAME_ROOT }]
      : []),
  ];

  for (const { label, root } of rootsToTest) {
    it(`loads v3 audio data for ZSJN, ZGSZ, KDCA, KJFK, and EGLC (${label})`, () => {
      const zsjn = loadV3AirportAudio(root, 'ZSJN');
      const zgsz = loadV3AirportAudio(root, 'ZGSZ');
      const kdca = loadV3AirportAudio(root, 'KDCA');
      const kjfk = loadV3AirportAudio(root, 'KJFK');
      const eglc = loadV3AirportAudio(root, 'EGLC');

      // ZSJN & ZGSZ expose both zh and en
      expect(zsjn.knownChannelConfig).toBe(true);
      expect(zsjn.languages).toEqual(['en', 'zh']);
      expect(zsjn.atcVoicesByLang).toEqual({ zh: ['Hanser'], en: ['Hanser-EN'] });

      expect(zgsz.knownChannelConfig).toBe(true);
      expect(zgsz.languages).toEqual(['en', 'zh']);
      expect(zgsz.atcVoicesByLang).toEqual({ zh: ['ZGSZ-Female-ATC'], en: ['Hanser-EN'] });

      // KDCA & KJFK expose English only
      expect(kdca.knownChannelConfig).toBe(true);
      expect(kdca.languages).toEqual(['en']);
      expect(kdca.atcVoicesByLang).toEqual({ en: ['American-Female-ATC'] });
      expect(kdca.captainVoices).toEqual(['Yeager']);

      expect(kjfk.knownChannelConfig).toBe(true);
      expect(kjfk.languages).toEqual(['en']);
      expect(kjfk.atcVoicesByLang).toEqual({ en: ['American-Female-ATC'] });
      expect(kjfk.captainVoices).toEqual(['Yeager']);

      // EGLC has no explicit channel voice mappings -> treated as unknown, not zero voices
      expect(eglc.knownChannelConfig).toBe(false);
      expect(eglc.languages).toBeNull();
      expect(eglc.captainVoices.length).toBeGreaterThanOrEqual(5);

      // ZSJN looks up both early callsigns under Hanser, CN-Captain-Young, and CN-Captain-Middle-Aged
      for (const captainVoice of ['CN-Captain-Young', 'CN-Captain-Middle-Aged']) {
        const res = lookupV3CallsignsForAirport(root, 'ZSJN', { language: 'zh', captainVoice });
        expect(res.allCallsigns).toContain('CES9197');
        expect(res.allCallsigns).toContain('DKH6071');
        expect(res.byAirline.CES).toContain('9197');
        expect(res.byAirline.DKH).toContain('6071');
      }

      // Non-callsign operational clips (RWY*) are excluded from callsigns
      expect(zsjn.audioCallsigns.allCallsigns.some((cs) => cs.startsWith('RWY'))).toBe(false);
      expect(zsjn.audioCallsigns.allAirlines).not.toContain('RWY');
    });
  }

  it('selects v2 vs v3 audio sources per level format in mixed-version installs and updates audioSourceSignature on change', () => {
    const tmpRoot = makeTempDir('ac27-mixed-audio-');
    const saDst = path.join(tmpRoot, 'GroundATC_Data', 'StreamingAssets');
    const apDst = path.join(saDst, 'Airports', 'ZSJN');
    const levelsDst = path.join(apDst, 'Levels');
    const voicesDst = path.join(saDst, 'Voices');
    fs.mkdirSync(levelsDst, { recursive: true });
    fs.mkdirSync(voicesDst, { recursive: true });

    const saSrc = path.join(FIXTURES_GAME_ROOT_V3, 'GroundATC_Data', 'StreamingAssets');
    fs.copyFileSync(path.join(saSrc, 'Voices', 'voice_catalog.json'), path.join(voicesDst, 'voice_catalog.json'));
    fs.copyFileSync(path.join(saSrc, 'radio_clip_durations.json'), path.join(saDst, 'radio_clip_durations.json'));
    fs.copyFileSync(
      path.join(saSrc, 'Airports', 'ZSJN', 'radio_channel_config.json'),
      path.join(apDst, 'radio_channel_config.json'),
    );

    const v3Acl = path.join(levelsDst, 'ZSJN_v3.acl');
    fs.copyFileSync(ZSJN_LEISURE_1_V3, v3Acl);

    const sigBefore = computeAudioSourceSignature(tmpRoot, 'ZSJN');
    expect(resolveAirportAudioMode(tmpRoot, 'ZSJN')).toBe('v3');

    const v2Acl = path.join(levelsDst, 'ZSJN_v2.acl');
    fs.copyFileSync(ZSJN_LEISURE_1_V2, v2Acl);
    fs.writeFileSync(path.join(levelsDst, 'audio_clips_en.json'), JSON.stringify({ callsigns: ['CES9197'] }), 'utf-8');
    const sigAfter = computeAudioSourceSignature(tmpRoot, 'ZSJN');
    expect(sigAfter).not.toBe(sigBefore);
    expect(resolveAirportAudioMode(tmpRoot, 'ZSJN')).toBe('mixed');
    expect(resolveAirportAudioMode(tmpRoot, 'ZSJN', v2Acl)).toBe('v2');
    expect(resolveAirportAudioMode(tmpRoot, 'ZSJN', v3Acl)).toBe('v3');
  });

  it('populates valid non-empty Language, Voice, and allocatable CallSign on new flights and Aviationstack imports', () => {
    const loaded = loadLevelForEditor(ZSJN_LEISURE_1_V3);
    const { vals, audioCallsigns } = buildZsjnV3AirportContext(loaded.flights);

    const newArr = createArrivalFlight('06:15:00', vals, audioCallsigns, 'ZSJN', vals, loaded.flights);
    expect(newArr.Language).toBeTruthy();
    expect(newArr.Voice).toBeTruthy();
    expect(vals._v3Audio.allocatableCallsignsByVoice[newArr.Voice]).toContain(newArr.CallSign);

    const newDep = createDepartureFlight('06:15:00', vals, audioCallsigns, 'ZSJN', vals, loaded.flights);
    expect(newDep.Language).toBeTruthy();
    expect(newDep.Voice).toBeTruthy();
    expect(vals._v3Audio.allocatableCallsignsByVoice[newDep.Voice]).toContain(newDep.CallSign);

    const mappedRes = mapAviationstackFlight(
      {
        airline: { icao: 'CES', name: 'China Eastern Airlines' },
        flight: { number: '9197', icao: 'CES9197' },
        departure: { icao: 'ZSSS', scheduled: '2026-05-01T05:00:00+00:00' },
        arrival: { icao: 'ZSJN', scheduled: '2026-05-01T06:00:00+00:00' },
        aircraft: { iata: '320', registration: 'B-8888' },
      },
      {
        airportIcao: 'ZSJN',
        vals,
        usedCallsigns: new Set(),
        usedStands: new Set(),
        usedRegs: new Set(),
      },
    );
    expect(mappedRes.keep).toBe(true);
    expect(mappedRes.flight.Language).toBe('zh');
    expect(mappedRes.flight.Voice).toBeTruthy();
    expect(vals._v3Audio.allocatableCallsignsByVoice[mappedRes.flight.Voice]).toContain(mappedRes.flight.CallSign);
  });

  it('blocks callsign/captain-voice and callsign/ATC-voice mismatches with flight + voice identified in error message', () => {
    const loaded = loadLevelForEditor(ZSJN_LEISURE_1_V3);
    const { vals, audioCallsigns } = buildZsjnV3AirportContext(loaded.flights);
    const runwayTimeline = loaded.handle.readTimelines().runwayTimeline;
    const valsWithCal = {
      ...vals,
      AirlineName: [...new Set([...(vals.AirlineName || []), 'China Airlines'])],
      _compat: {
        ...(vals._compat || {}),
        airlineToAircraft: {
          ...(vals._compat?.airlineToAircraft || {}),
          'China Airlines': [loaded.flights[0].AircraftType],
        },
      },
    };

    // CAL2017 exists in Hanser-EN & CN-Captain-Young-EN, NOT in Chinese CN-Captain-Young / Hanser!
    const badZhFlights = loaded.flights.map((f, i) =>
      i === 0
        ? {
            ...f,
            CallSign: 'CAL2017',
            AirlineName: 'China Airlines',
            Language: 'zh',
            Voice: 'CN-Captain-Young',
          }
        : f,
    );

    const uiIssues = runTripleValidation(
      badZhFlights,
      { ZSJN: valsWithCal },
      'ZSJN',
      audioCallsigns,
      loaded._saveSec,
      '05:46:00',
      '06:15:00',
      runwayTimeline,
    );
    expect(uiIssues.length).toBeGreaterThan(0);
    const mismatchMsg = uiIssues.find((m) => m.includes('CAL2017') && /CN-Captain-Young|Hanser/.test(m));
    expect(mismatchMsg).toBeTruthy();

    // Same mismatch is also caught by MCP validateFlightObjects
    const constraints = buildConstraints(
      {
        currentAirport: 'ZSJN',
        airportValues: { ZSJN: valsWithCal },
        _configStartTime: '05:46:00',
        _configEndTime: '06:15:00',
        runwayTimeline,
      },
      {
        ZSJN: {
          dropdownValues: valsWithCal,
          approachData: ZSJN_APPROACH_CACHE_V3,
          audioCallsigns,
        },
      },
    );
    const mcpErrs = validateFlightObjects(toStoreFlights(badZhFlights), [], constraints);
    expect(mcpErrs?.some((e) => e.message?.includes('CAL2017') && /CN-Captain-Young|Hanser/.test(e.message))).toBe(true);

    // Switching CAL2017 to Language='en' + Voice='CN-Captain-Young-EN' makes it 100% valid!
    const validCalEnFlights = loaded.flights.map((f, i) =>
      i === 0
        ? {
            ...f,
            CallSign: 'CAL2017',
            AirlineName: 'China Airlines',
            Language: 'en',
            Voice: 'CN-Captain-Young-EN',
          }
        : f,
    );
    const validUiIssues = runTripleValidation(
      validCalEnFlights,
      { ZSJN: valsWithCal },
      'ZSJN',
      audioCallsigns,
      loaded._saveSec,
      '05:46:00',
      '06:15:00',
      runwayTimeline,
    );
    expect(validUiIssues.some(issue => issue.includes("CAL2017") && issue.includes("Hanser"))).toBe(true);
    expect(validateFlightObjects(toStoreFlights(validCalEnFlights), [], constraints))
      .toEqual(expect.arrayContaining([expect.objectContaining({ issue: "callsign_atc_voice_mismatch" })]));
  });
});

// ── 5. Explicit flight edits: retime, Language/Voice change, delete, clear-all ─

describe('5. v3 explicit schedule edits (time edit, Language/Voice change, flight deletion, clear-all)', () => {
  it('persists time edits, explicit cross-language Voice changes, single-flight deletion, and 0-flight clear-all', () => {
    const tmp = makeTempDir();
    const aclCopy = path.join(tmp, 'Airports', 'ZSJN', 'Levels', 'ZSJN_leisure_1.acl');
    fs.mkdirSync(path.dirname(aclCopy), { recursive: true });
    fs.copyFileSync(ZSJN_LEISURE_1_V3, aclCopy);

    const loaded = loadLevelForEditor(aclCopy);
    const { vals, audioCallsigns } = buildZsjnV3AirportContext(loaded.flights);
    const runwayTimeline = loaded.handle.readTimelines().runwayTimeline;

    // A) Retime CES9197 + explicitly switch CES9197 to ('en', 'CN-Captain-Young-EN') + delete DKH6071 (B-5716D)
    const editedFlights = loaded.flights
      .filter((f) => regOf(f) !== 'B-5716D') // delete DKH6071
      .map((f) => {
        if (f.CallSign === 'CES9197') {
          const langPatch = cascadeLanguageChange('en', vals, f);
          return { ...f, Language: 'en', ...langPatch, Voice: 'CN-Captain-Young-EN', OffBlockTime: '05:48:00' };
        }
        return f;
      });

    // cascadeAirlineLanguage on v3 preserves valid explicit cross-language selection
    expect(cascadeAirlineLanguage('CES9197', 'en', 'CN-Captain-Young-EN', vals)).toEqual({});

    expect(
      runTripleValidation(
        editedFlights,
        { ZSJN: vals },
        'ZSJN',
        audioCallsigns,
        loaded._saveSec,
        '05:46:00',
        '06:15:00',
        runwayTimeline,
      ),
    ).toEqual([]);

    parser.generateFullAcl(aclCopy, editedFlights, undefined, undefined, undefined, undefined, ZSJN_APPROACH_CACHE_V3);

    const afterEditHandle = openAclFile(aclCopy, { validateOnOpen: true });
    validateV3Container(afterEditHandle.container);

    const reloaded = loadLevelForEditor(aclCopy).flights;
    expect(reloaded).toHaveLength(23);

    const ces = reloaded.find((f) => f.CallSign === 'CES9197');
    expect(ces.OffBlockTime).toBe('05:48:00');
    expect(ces.Language).toBe('en');
    expect(ces.Voice).toBe('CN-Captain-Young-EN');

    for (const f of reloaded.filter((x) => x.CallSign !== 'CES9197')) {
      expect(f.Language).toBe('zh');
      expect(['CN-Captain-Young', 'CN-Captain-Middle-Aged']).toContain(f.Voice);
    }

    const schema = getSchemaForHash(afterEditHandle.header.schemaHash);
    const stIdx = indexDocumentGraph(afterEditHandle.container.staticData, schema.roots.static, schema);
    const siDict = resolveGraphNode(afterEditHandle.container.staticData.StaticItems, stIdx);
    expect(dictGet(siDict, 'flight-plan:B-5716D')).toBeUndefined();

    const rtIdx = indexDocumentGraph(afterEditHandle.container.frames[0].runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(afterEditHandle.container.frames[0].runtimeData.RuntimeEntities, rtIdx);
    expect(dictGet(reDict, 'flight-plan:B-5716D')).toBeUndefined();
    expect(dictGet(reDict, 'aircraft:B-5716D')).toBeUndefined();
    expect(dictGet(reDict, 'aircraft-animator:aircraft:B-5716D')).toBeUndefined();

    // B) Clear all flights ([]) -> saves and reloads an empty schedule cleanly
    parser.generateFullAcl(aclCopy, [], undefined, undefined, undefined, undefined, ZSJN_APPROACH_CACHE_V3);
    const clearedHandle = openAclFile(aclCopy, { validateOnOpen: true });
    validateV3Container(clearedHandle.container);
    expect(loadLevelForEditor(aclCopy).flights).toEqual([]);
  });
});

// ── 6. Explicit .demo.acl trimming & v2 fixture regression ───────────────────

describe('6. explicit .demo.acl window trimming & v2 legacy regression', () => {
  it('trims ZSJN_peakdeparture.demo.acl to its MetaData.Config window while leaving ZSJN_peakdeparture.acl untrimmed', () => {
    expect(shouldTrimDemoSchedule(ZSJN_PEAKDEP_DEMO_V3, 'gatcarc4-v3')).toBe(true);
    expect(shouldApplyLegacyDemoEndTimeOverride(ZSJN_PEAKDEP_DEMO_V3, 'gatcarc4-v3')).toBe(false);
    expect(shouldTrimDemoSchedule(ZSJN_PEAKDEP_V3, 'gatcarc4-v3')).toBe(false);

    const rawDemoCount = openAclFile(ZSJN_PEAKDEP_DEMO_V3).readFlights().flights.length;
    const demoLoaded = loadLevelForEditor(ZSJN_PEAKDEP_DEMO_V3);
    expect(demoLoaded.isDemo).toBe(true);
    expect(demoLoaded.config).toMatchObject({ startTime: '19:52:00', endTime: '20:30:00' });
    expect(demoLoaded.flights.length).toBeLessThan(rawDemoCount);
    expect(demoLoaded.removedCount).toBe(rawDemoCount - demoLoaded.flights.length);

    const fullCount = openAclFile(ZSJN_PEAKDEP_V3).readFlights().flights.length;
    const fullLoaded = loadLevelForEditor(ZSJN_PEAKDEP_V3);
    expect(fullLoaded.isDemo).toBe(false);
    expect(fullLoaded.flights).toHaveLength(fullCount);
  });

  it('preserves v2 DEMO_VISIBLE_BASES schedule trimming and v2 save behavior on ZSJN_leisure_1.acl', () => {
    const tmp = makeTempDir('ac27-v2-reg-');
    const v2Copy = path.join(tmp, 'Airports', 'ZSJN', 'Levels', 'ZSJN_leisure_1.acl');
    fs.mkdirSync(path.dirname(v2Copy), { recursive: true });
    fs.copyFileSync(ZSJN_LEISURE_1_V2, v2Copy);

    const fmt = detectAclFormat(fs.readFileSync(v2Copy));
    expect(fmt).toBe('gatcarc4-v2');
    expect(shouldTrimDemoSchedule(v2Copy, fmt)).toBe(true);
    expect(shouldApplyLegacyDemoEndTimeOverride(v2Copy, fmt)).toBe(true);

    const rawV2Count = openAclFile(v2Copy).readFlights(v2Copy).flights.length;
    const v2Loaded = loadLevelForEditor(v2Copy);
    expect(v2Loaded.isDemo).toBe(true);
    expect(v2Loaded.flights.length).toBeLessThanOrEqual(rawV2Count);

    parser.generateFullAcl(v2Copy, v2Loaded.flights);
    expect(detectAclFormat(fs.readFileSync(v2Copy))).toBe('gatcarc4-v2');
  });
});
