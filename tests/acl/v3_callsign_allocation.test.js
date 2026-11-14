/**
 * @vitest-environment node
 *
 * GATCARC4 v3 Callsign & Voice Audio Allocation Validation Suite.
 *
 * Covers `plan-v3-callsign-allocation.md`:
 *   1a. UI preflight (`runTripleValidation`), MCP (`validateFlightObjects`,
 *       `applyCascades`), and authoritative v3 save handler (`saveToFile` +
 *       `saveV3GroundPainterData`) against rebuilt static plans, including
 *       each stored leg (`InitialArrival` and `InitialDeparture`), resolving
 *       audio metadata from the level's game root and airport via `gamePaths`.
 *   1b. Actionable error for `AXM1416` with `Yeager` (`flight-plan:B-13Q2`)
 *       identifying registration, callsign, missing captain recording, and
 *       compatible captain voices. Rejects before touching `.acl`, `.acl.bak`,
 *       `.csv`, or sidecars; keeps invalid existing `.acl` files openable for
 *       repair; leaves v2 audio behavior unchanged.
 *   1c. Distinguishes absent recording in a loaded index (`missing_captain_clip`
 *       / `missing_atc_clip`) from unavailable or unreadable metadata
 *       (`audio_metadata_unavailable`), and tests the captain clip requirement
 *       independently of ATC coverage while enforcing session ATC coverage.
 *   2a/2b. E2E staging paths (`gamePaths`) + startup/replace capability gate
 *       (`verifyV3AudioCapabilities`).
 *   3b/3c/3d. Saved-output game-compat & `--replace` gate
 *       (`analyzeAclFile` + `runChecks` + `verifyAndCopyReplacedLevel`),
 *       deterministic `AXM1416` + `Yeager` negative regression, and positive
 *       pairing with `CN-Captain-Young-EN` and `CN-Captain-Middle-Aged-EN`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const gamePaths = require('../../src/utils/gamePaths');
const {
  GAME_ROOT,
  FIXTURES_GAME_ROOT_V3,
  levelPath,
  gameLevelExists,
  stageV3AudioIntoRoot,
} = require('../helpers/gameRoot.cjs');
const { openAclFile, detectAclFormat } = require('../../src/acl/archive');
const { encodeV3Container } = require('../../src/acl/v3/framing');
const { getSchemaForHash } = require('../../src/acl/v3/schema_registry');
const { dictEntries, dictSet, indexDocumentGraph, resolveGraphNode } = require('../../src/acl/v3/graph');
const {
  clearV3AudioCache,
  loadV3AirportAudio,
} = require('../../src/acl/v3/audio');
const {
  CallsignAllocationError,
  extractV3StaticPlansForCallsigns,
  verifyV3AudioCapabilities,
  validateV3CallsignAllocation,
} = require('../../src/acl/v3/callsign_validation');
const { saveV3GroundPainterData } = require('../../src/acl/v3/ground_painter_save');
const { buildConstraints, validateFlightObjects, applyCascades } = require('../../electron/api-server');
const {
  analyzeAclFile,
  runChecks,
  verifyAndCopyReplacedLevel,
} = require('../integration/gamecompat-utils.cjs');
const parser = require('../../src/acl/parser');
import { runTripleValidation } from '../../src/utils/validators.js';

const V3_ZSJN_FIXTURE = path.join(
  gamePaths.levelsDir(FIXTURES_GAME_ROOT_V3, 'ZSJN'),
  'ZSJN_leisure_1.acl',
);
const V2_FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/game-root');
const V2_ZSJN_FIXTURE = path.join(
  gamePaths.levelsDir(V2_FIXTURE_ROOT, 'ZSJN'),
  'ZSJN_leisure_1.acl',
);

function resolveCleanZgszLeisure1() {
  try {
    if (!gameLevelExists('ZGSZ', 'ZGSZ_leisure_1.acl')) return null;
    const mainPath = levelPath('ZGSZ', 'ZGSZ_leisure_1.acl');
    const bakPath = `${mainPath}.bak`;
    for (const candidate of [bakPath, mainPath]) {
      if (!fs.existsSync(candidate)) continue;
      const buf = fs.readFileSync(candidate);
      if (detectAclFormat(buf) !== 'gatcarc4-v3') continue;
      const h = openAclFile(candidate);
      const check = validateV3CallsignAllocation(h.container, null, {
        gameRoot: GAME_ROOT,
        airportIcao: 'ZGSZ',
        requireAudioMetadata: true,
      });
      if (check.ok) return candidate;
    }
  } catch (_) {}
  return null;
}

const CLEAN_ZGSZ_LEISURE_1 = resolveCleanZgszLeisure1();

const tmpDirs = [];
function makeTmpDir(prefix = 'ac27-v3-cs-alloc-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function sha256File(fp) {
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

function stageLevelCopy(rootDir, icao, levelFileName, srcAclPath, audioSourceRoot = FIXTURES_GAME_ROOT_V3) {
  stageV3AudioIntoRoot(rootDir, icao, audioSourceRoot);
  const lvlDir = gamePaths.levelsDir(rootDir, icao);
  fs.mkdirSync(lvlDir, { recursive: true });
  const dstAclPath = path.join(lvlDir, levelFileName);
  fs.copyFileSync(srcAclPath, dstAclPath);
  return dstAclPath;
}

function buildAirportValuesForTest(gameRoot, icao, handle) {
  const v3Bundle = loadV3AirportAudio(gameRoot, icao);
  const loaded = handle.readFlights();
  const stands = Object.keys(handle.readStandPositions() || {});
  const scenery = handle.readScenery() || {};
  const { runwayStarMap } = handle.readStarRunwayMappings
    ? handle.readStarRunwayMappings()
    : { runwayStarMap: {} };
  const starMap = { ...(runwayStarMap || {}) };
  const sceneryRunwayEnds = (Array.isArray(scenery.runways) ? scenery.runways : []).flatMap((r) =>
    typeof r === 'string' ? [r] : (Array.isArray(r?.names) ? r.names : []),
  );
  const runways = [...new Set([
    ...sceneryRunwayEnds,
    ...Object.keys(starMap),
    ...loaded.flights.map((f) => f.Runway).filter(Boolean),
  ])];
  for (const r of runways) {
    if (!starMap[r]) starMap[r] = [];
  }
  for (const f of loaded.flights) {
    if (f.Runway && f.Airway) {
      if (!starMap[f.Runway]) starMap[f.Runway] = [];
      if (!starMap[f.Runway].includes(f.Airway)) starMap[f.Runway].push(f.Airway);
    }
  }
  const existingAirlines = [...new Set(loaded.flights.map((f) => (f.CallSign || '').slice(0, 3)).filter(Boolean))];
  const existingTypes = [...new Set(loaded.flights.map((f) => f.AircraftType).filter(Boolean))];
  return {
    AirlineCode: existingAirlines,
    Stand: stands.length ? stands : ['604R', '101', '102'],
    Runway: runways.length ? runways : ['01', '15', '19'],
    AircraftType: existingTypes.length ? existingTypes : ['A320', 'B738'],
    Voice: [...v3Bundle.captainVoices],
    Language: v3Bundle.languages ? [...v3Bundle.languages] : ['en', 'zh'],
    _voiceLanguages: { ...v3Bundle.voiceLanguages },
    _flightNums: { ...v3Bundle.audioCallsigns.byAirline },
    _runwayStarMap: starMap,
    _compat: { airlineToAircraft: {} },
    _registrationMap: {},
    _v3Audio: v3Bundle.v3Audio,
    _isV3: true,
  };
}

function injectBrokenPlanIntoContainer(container, {
  registration = 'B-13Q2',
  callSign = 'AXM1416',
  airlineCode = 'AXM',
  flightNumber = '1416',
  language = 'en',
  voice = 'Yeager',
  secondLegCallSign = null,
} = {}) {
  const cloned = structuredClone(container);
  const schema = getSchemaForHash(cloned.header.schemaHash);
  const stIdx = indexDocumentGraph(cloned.staticData, schema.roots.static, schema);
  const siDict = resolveGraphNode(cloned.staticData.StaticItems, stIdx);

  let templatePlan = null;
  let templateArrLeg = null;
  let templateDepLeg = null;
  for (const [k, rawV] of dictEntries(siDict)) {
    if (!String(k).startsWith('flight-plan:')) continue;
    const fp = resolveGraphNode(rawV, stIdx);
    if (!fp) continue;
    if (!templatePlan) templatePlan = fp;
    const arr = resolveGraphNode(fp.InitialArrival, stIdx);
    const dep = resolveGraphNode(fp.InitialDeparture, stIdx);
    if (arr && !templateArrLeg) templateArrLeg = arr;
    if (dep && !templateDepLeg) templateDepLeg = dep;
  }

  const newArr = structuredClone(templateArrLeg || templateDepLeg);
  delete newArr.$id;
  newArr.CallSign = callSign;
  newArr.AirlineCode = airlineCode;
  newArr.FlightNumber = flightNumber;

  let newDep = null;
  if (secondLegCallSign !== null) {
    newDep = structuredClone(templateDepLeg || templateArrLeg);
    delete newDep.$id;
    newDep.CallSign = secondLegCallSign;
    newDep.AirlineCode = secondLegCallSign.slice(0, 3);
    newDep.FlightNumber = secondLegCallSign.slice(3);
  }

  const newPlan = structuredClone(templatePlan);
  delete newPlan.$id;
  newPlan.Registration = registration;
  newPlan.Language = language;
  newPlan.Voice = voice;
  newPlan.InitialArrival = newArr;
  newPlan.InitialDeparture = newDep;

  dictSet(siDict, `flight-plan:${registration}`, newPlan);
  cloned.dirtyStaticData = true;
  return cloned;
}

afterEach(() => {
  clearV3AudioCache();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
});

it.each([
  ['B-7964', 'ANA1201', 'CN-Captain-Middle-Aged-EN'],
  ['B-6451', 'EPA6383', 'CN-Captain-Young-EN'],
])('rejects flight %s outside the ZSJN session pool while keeping its captain available', (registration, callSign, voice) => {
  const root = makeTmpDir('ac27-zsjn-session-pool-');
  const aclPath = stageLevelCopy(root, 'ZSJN', 'ZSJN_leisure_1.acl', V3_ZSJN_FIXTURE);
  const clipPath = gamePaths.radioClipDurationsPath(root);
  const clipIndex = JSON.parse(fs.readFileSync(clipPath, 'utf8'));
  for (const name of [voice, 'Hanser-EN']) {
    clipIndex.clips[`${name}/${callSign}`] = Object.values(clipIndex.clips)[0];
  }
  fs.writeFileSync(clipPath, JSON.stringify(clipIndex));
  const originalHash = sha256File(aclPath);
  const audio = loadV3AirportAudio(root, 'ZSJN');
  expect(audio.captainVoices).toContain(voice);
  expect(audio.v3Audio.allocatableAirlines).not.toContain(callSign.slice(0, 3));

  const handle = openAclFile(aclPath);
  const flights = handle.readFlights().flights;
  flights[0] = { ...flights[0], _Registration: registration, CallSign: callSign, Language: 'en', Voice: voice };
  handle.applyEdits({ flights });
  expect(() => handle.saveToFile(aclPath, { createBackup: true })).toThrow(/Hanser.*no audio recording/);
  expect(sha256File(aclPath)).toBe(originalHash);
  expect(fs.existsSync(`${aclPath}.bak`)).toBe(false);
});

describe('1c. Absent Recording vs Unavailable Metadata & Captain vs ATC Rule', () => {
  it('distinguishes an absent clip in a loaded index from missing or unreadable audio metadata', () => {
    const srcHandle = openAclFile(V3_ZSJN_FIXTURE);
    const brokenContainer = injectBrokenPlanIntoContainer(srcHandle.container, {
      registration: 'B-13Q2',
      callSign: 'AXM1416',
      language: 'en',
      voice: 'Yeager',
    });

    // Case A: Loaded clip index -> missing_captain_clip (metadataUnavailable: false)
    const loadedRes = validateV3CallsignAllocation(brokenContainer, null, {
      gameRoot: FIXTURES_GAME_ROOT_V3,
      airportIcao: 'ZGSZ',
      requireAudioMetadata: true,
    });
    expect(loadedRes.ok).toBe(false);
    expect(loadedRes.metadataUnavailable).toBe(false);
    const capIss = loadedRes.issues.find((i) => i.kind === 'missing_captain_clip' && i.registration === 'B-13Q2');
    expect(capIss).toBeTruthy();
    expect(capIss).toMatchObject({
      planKey: 'flight-plan:B-13Q2',
      registration: 'B-13Q2',
      callSign: 'AXM1416',
      voice: 'Yeager',
      language: 'en',
      compatibleCaptainVoices: ['CN-Captain-Middle-Aged-EN', 'CN-Captain-Young-EN'],
    });

    // Case B: Missing radio_clip_durations.json -> audio_metadata_unavailable (metadataUnavailable: true)
    const missingClipsRoot = makeTmpDir('ac27-missing-clips-');
    stageV3AudioIntoRoot(missingClipsRoot, 'ZGSZ', FIXTURES_GAME_ROOT_V3);
    fs.rmSync(gamePaths.radioClipDurationsPath(missingClipsRoot), { force: true });

    const noClipsRes = validateV3CallsignAllocation(brokenContainer, null, {
      gameRoot: missingClipsRoot,
      airportIcao: 'ZGSZ',
      requireAudioMetadata: true,
    });
    expect(noClipsRes.ok).toBe(false);
    expect(noClipsRes.metadataUnavailable).toBe(true);
    expect(noClipsRes.missingResources.map((r) => r.resource)).toContain('radio_clip_durations.json');
    expect(noClipsRes.issues[0].kind).toBe('audio_metadata_unavailable');
    expect(noClipsRes.issues.some((i) => i.kind === 'missing_captain_clip')).toBe(false);

    // Case C: Empty voice_catalog.json (voices: []) -> audio_metadata_unavailable
    const emptyCatalogRoot = makeTmpDir('ac27-empty-cat-');
    stageV3AudioIntoRoot(emptyCatalogRoot, 'ZGSZ', FIXTURES_GAME_ROOT_V3);
    fs.writeFileSync(gamePaths.voiceCatalogPath(emptyCatalogRoot), '{"voices":[]}', 'utf8');

    const emptyCatRes = validateV3CallsignAllocation(brokenContainer, null, {
      gameRoot: emptyCatalogRoot,
      airportIcao: 'ZGSZ',
      requireAudioMetadata: true,
    });
    expect(emptyCatRes.ok).toBe(false);
    expect(emptyCatRes.metadataUnavailable).toBe(true);
    expect(emptyCatRes.missingResources.find((r) => r.resource === 'Voices/voice_catalog.json')?.status).toBe('empty');

    // Case D: Corrupt radio_channel_config.json -> audio_metadata_unavailable (status: unreadable)
    const corruptChannelRoot = makeTmpDir('ac27-corrupt-ch-');
    stageV3AudioIntoRoot(corruptChannelRoot, 'ZGSZ', FIXTURES_GAME_ROOT_V3);
    fs.writeFileSync(gamePaths.radioChannelConfigPath(corruptChannelRoot, 'ZGSZ'), '{not-json', 'utf8');

    const corruptChRes = validateV3CallsignAllocation(brokenContainer, null, {
      gameRoot: corruptChannelRoot,
      airportIcao: 'ZGSZ',
      requireAudioMetadata: true,
    });
    expect(corruptChRes.ok).toBe(false);
    expect(corruptChRes.metadataUnavailable).toBe(true);
    expect(corruptChRes.missingResources.find((r) => r.resource.endsWith('radio_channel_config.json'))?.status).toBe('unreadable');

    // UI + MCP also surface inability to verify when audio metadata is missing
    const incompleteBundle = loadV3AirportAudio(missingClipsRoot, 'ZGSZ');
    const uiMetaIssues = runTripleValidation(
      [{
        CallSign: 'AXM1416',
        Registration: 'B-13Q2',
        DepartureAirport: 'WMKK',
        ArrivalAirport: '',
        Stand: '101',
        Runway: '01',
        OffBlockTime: '',
        TakeoffTime: '',
        LandingTime: '08:10:00',
        InBlockTime: '08:15:00',
        AirlineName: 'AXM',
        AircraftType: 'A320',
        Airway: 'STAR1',
        Voice: 'Yeager',
        Language: 'en',
      }],
      {
        ZGSZ: {
          AirlineCode: ['AXM'],
          Stand: ['101'],
          Runway: ['01'],
          AircraftType: ['A320'],
          Voice: ['Yeager'],
          Language: ['en'],
          _flightNums: { AXM: ['1416'] },
          _runwayStarMap: { '01': ['STAR1'] },
          _v3Audio: incompleteBundle.v3Audio,
          _isV3: true,
        },
      },
      'ZGSZ',
      { byAirline: {}, allCallsigns: [], allAirlines: [] },
      null,
      '08:00:00',
      '09:00:00',
      null,
    );
    expect(uiMetaIssues.some((m) => m.includes('radio_clip_durations.json'))).toBe(true);
  });

  it('enforces the captain clip requirement independently of ATC coverage and checks session ATC voices when known', () => {
    const srcHandle = openAclFile(V3_ZSJN_FIXTURE);

    // 1. Captain clip missing (`AXM1416` + `Yeager`) with NO ATC channel config (`EGLC` + ignoreStaticChannelVoices)
    const noAtcContainer = injectBrokenPlanIntoContainer(srcHandle.container, {
      registration: 'B-13Q2',
      callSign: 'AXM1416',
      language: 'en',
      voice: 'Yeager',
    });
    const capOnlyFail = validateV3CallsignAllocation(noAtcContainer, null, {
      gameRoot: FIXTURES_GAME_ROOT_V3,
      airportIcao: 'EGLC', // EGLC has empty radioChannels -> knownChannelConfig: false
      ignoreStaticChannelVoices: true,
      requireAudioMetadata: true,
    });
    expect(capOnlyFail.ok).toBe(false);
    expect(capOnlyFail.issues.some((i) => i.kind === 'missing_captain_clip' && i.callSign === 'AXM1416')).toBe(true);
    expect(capOnlyFail.issues.some((i) => i.kind === 'missing_atc_clip')).toBe(false);

    // 2. Captain clip PRESENT (`ETD8349` + `Yeager`) passes when ATC coverage is unknown (`EGLC`) or Western (`KJFK`),
    //    but FAILS with `missing_atc_clip` when session ATC is `Hanser-EN` (`ZGSZ`).
    const etdContainer = injectBrokenPlanIntoContainer(srcHandle.container, {
      registration: 'A6-UYY',
      callSign: 'ETD8349',
      airlineCode: 'ETD',
      flightNumber: '8349',
      language: 'en',
      voice: 'Yeager',
    });

    const eglcCheck = validateV3CallsignAllocation(etdContainer, null, {
      gameRoot: FIXTURES_GAME_ROOT_V3,
      airportIcao: 'EGLC',
      ignoreStaticChannelVoices: true,
      requireAudioMetadata: true,
    });
    expect(eglcCheck.issues.filter((i) => i.registration === 'A6-UYY')).toEqual([]);

    const kjfkCheck = validateV3CallsignAllocation(etdContainer, null, {
      gameRoot: FIXTURES_GAME_ROOT_V3,
      airportIcao: 'KJFK',
      requireAudioMetadata: true,
    });
    expect(kjfkCheck.issues.filter((i) => i.registration === 'A6-UYY')).toEqual([]);

    const zgszCheck = validateV3CallsignAllocation(etdContainer, null, {
      gameRoot: FIXTURES_GAME_ROOT_V3,
      airportIcao: 'ZGSZ',
      requireAudioMetadata: true,
    });
    const atcFail = zgszCheck.issues.find((i) => i.registration === 'A6-UYY' && i.kind === 'missing_atc_clip');
    expect(atcFail).toBeTruthy();
    expect(atcFail.missingAtcVoices).toEqual(['Hanser-EN', 'ZGSZ-Female-ATC']);
  });
});

describe('1a. Multi-Leg Static Plans (`InitialArrival` + `InitialDeparture`) & Role Validation', () => {
  it('validates every stored leg on turnaround plans and catches second-leg clip mismatches & duplicate pair callsigns', () => {
    const srcHandle = openAclFile(V3_ZSJN_FIXTURE);

    // InitialArrival (`CCA2761`) has a clip for `CN-Captain-Young` (zh),
    // while InitialDeparture (`AXM1416`) has NO clip for `CN-Captain-Young`.
    const dualLegContainer = injectBrokenPlanIntoContainer(srcHandle.container, {
      registration: 'B-9988',
      callSign: 'CCA2761',
      airlineCode: 'CCA',
      flightNumber: '2761',
      language: 'zh',
      voice: 'CN-Captain-Young',
      secondLegCallSign: 'AXM1416',
    });

    const extracted = extractV3StaticPlansForCallsigns(dualLegContainer);
    const dualPlan = extracted.find((p) => p.registration === 'B-9988');
    expect(dualPlan).toBeTruthy();
    expect(dualPlan.legs.map((l) => ({ slot: l.slot, callSign: l.callSign }))).toEqual([
      { slot: 'InitialArrival', callSign: 'CCA2761' },
      { slot: 'InitialDeparture', callSign: 'AXM1416' },
    ]);

    const res = validateV3CallsignAllocation(dualLegContainer, null, {
      gameRoot: FIXTURES_GAME_ROOT_V3,
      airportIcao: 'ZGSZ',
      requireAudioMetadata: true,
    });
    expect(res.ok).toBe(false);
    const depClipIss = res.issues.find(
      (i) => i.registration === 'B-9988' && i.slot === 'InitialDeparture' && i.kind === 'missing_captain_clip',
    );
    expect(depClipIss).toBeTruthy();
    expect(depClipIss.callSign).toBe('AXM1416');
    expect(res.issues.some((i) => i.registration === 'B-9988' && i.slot === 'InitialArrival')).toBe(false);

    // Same callsign on both turnaround legs -> duplicate_pair_callsign
    const dupPairContainer = injectBrokenPlanIntoContainer(srcHandle.container, {
      registration: 'B-7766',
      callSign: 'CCA2761',
      airlineCode: 'CCA',
      flightNumber: '2761',
      language: 'zh',
      voice: 'CN-Captain-Young',
      secondLegCallSign: 'CCA2761',
    });
    const dupRes = validateV3CallsignAllocation(dupPairContainer, null, {
      gameRoot: FIXTURES_GAME_ROOT_V3,
      airportIcao: 'ZGSZ',
      requireAudioMetadata: true,
    });
    expect(dupRes.issues.some((i) => i.registration === 'B-7766' && i.kind === 'duplicate_pair_callsign')).toBe(true);

    // ATC voice assigned as FlightPlan.Voice -> invalid_captain_voice
    const atcAsCaptain = injectBrokenPlanIntoContainer(srcHandle.container, {
      registration: 'B-5544',
      callSign: 'AXM1416',
      language: 'en',
      voice: 'Hanser-EN',
    });
    const roleRes = validateV3CallsignAllocation(atcAsCaptain, null, {
      gameRoot: FIXTURES_GAME_ROOT_V3,
      airportIcao: 'ZGSZ',
      requireAudioMetadata: true,
    });
    expect(roleRes.issues.some((i) => i.registration === 'B-5544' && i.kind === 'invalid_captain_voice')).toBe(true);
  });
});

describe('1b, 3b, 3c. Deterministic Negative Regression: AXM1416 + Yeager (flight-plan:B-13Q2)', () => {
  it('fails UI preflight, MCP validation, v3 saveToFile, ground painter save, and replacement gate while leaving files intact', () => {
    const tmpRoot = makeTmpDir('ac27-axm-neg-');
    const stagedAcl = stageLevelCopy(tmpRoot, 'ZGSZ', 'ZGSZ_leisure_1.acl', V3_ZSJN_FIXTURE);
    const bakPath = `${stagedAcl}.bak`;
    const csvPath = path.join(path.dirname(stagedAcl), 'flight_schedule_leisure_1.csv');
    fs.writeFileSync(bakPath, 'ORIGINAL_BACKUP_SENTINEL', 'utf8');
    fs.writeFileSync(csvPath, 'ORIGINAL_CSV_SENTINEL', 'utf8');

    const origAclHash = sha256File(stagedAcl);
    const origBakHash = sha256File(bakPath);
    const origCsvHash = sha256File(csvPath);

    const handle = openAclFile(stagedAcl);
    const airportValues = buildAirportValuesForTest(tmpRoot, 'ZGSZ', handle);
    const loaded = handle.readFlights();
    const rwyTimeline = handle.readTimelines().runwayTimeline;
    const baseArrival = loaded.flights.find((f) => !f.isDeparture && f.Airway) || loaded.flights[0];

    const badAxmFlight = {
      ...baseArrival,
      CallSign: 'AXM1416',
      AirlineName: 'AXM',
      Registration: 'B-13Q2',
      _Registration: 'B-13Q2',
      DepartureAirport: 'WMKK',
      ArrivalAirport: '',
      LandingTime: baseArrival.LandingTime || '08:15:00',
      InBlockTime: baseArrival.InBlockTime || '08:22:00',
      OffBlockTime: '',
      TakeoffTime: '',
      isDeparture: false,
      Language: 'en',
      Voice: 'Yeager',
    };

    // 1. UI preflight (`runTripleValidation`)
    const uiIssues = runTripleValidation(
      [badAxmFlight],
      { ZGSZ: airportValues },
      'ZGSZ',
      { byAirline: {}, allCallsigns: [], allAirlines: [] },
      null,
      null,
      null,
      rwyTimeline,
    );
    const uiClipMsg = uiIssues.find(
      (m) => m.includes('AXM1416') && m.includes('B-13Q2') && m.includes('Yeager'),
    );
    expect(uiClipMsg).toBeTruthy();
    expect(uiClipMsg).toContain('CN-Captain-Middle-Aged-EN');
    expect(uiClipMsg).toContain('CN-Captain-Young-EN');

    // 2. MCP validation (`validateFlightObjects` & `applyCascades`)
    const constraints = buildConstraints(
      { currentAirport: 'ZGSZ', airportValues: { ZGSZ: airportValues }, runwayTimeline: rwyTimeline },
      null,
    );
    const mcpDetails = validateFlightObjects([badAxmFlight], [], constraints);
    expect(mcpDetails).toBeTruthy();
    const mcpClipErr = mcpDetails.find((d) => d.issue === 'callsign_voice_mismatch');
    expect(mcpClipErr).toBeTruthy();
    expect(mcpClipErr.message).toContain('AXM1416');
    expect(mcpClipErr.message).toContain('B-13Q2');
    expect(mcpClipErr.message).toContain('Yeager');
    expect(mcpClipErr.valid).toEqual(['CN-Captain-Middle-Aged-EN', 'CN-Captain-Young-EN']);

    const cascaded = applyCascades(
      { ...badAxmFlight, CallSign: 'CCA2761', Language: 'zh', Voice: 'CN-Captain-Young' },
      { AirlineCode: 'AXM', FlightNum: '1416', Language: 'en' },
      constraints,
    );
    expect(cascaded.CallSign).toBe('AXM1416');
    expect(['CN-Captain-Middle-Aged-EN', 'CN-Captain-Young-EN']).toContain(cascaded.Voice);

    // 3. Authoritative v3 save handler (`saveToFile`) rejects before touching .acl, .acl.bak, or .csv
    let caughtSaveErr = null;
    try {
      handle.applyEdits({ flights: [badAxmFlight] });
      handle.saveToFile(stagedAcl, { createBackup: true });
    } catch (err) {
      caughtSaveErr = err;
    }
    expect(caughtSaveErr).toBeInstanceOf(CallsignAllocationError);
    expect(caughtSaveErr.message).toContain('flight-plan:B-13Q2');
    expect(caughtSaveErr.message).toContain('B-13Q2');
    expect(caughtSaveErr.message).toContain('AXM1416');
    expect(caughtSaveErr.message).toContain('Yeager');
    expect(caughtSaveErr.message).toContain('CN-Captain-Young-EN');
    expect(sha256File(stagedAcl)).toBe(origAclHash);
    expect(sha256File(bakPath)).toBe(origBakHash);
    expect(sha256File(csvPath)).toBe(origCsvHash);

    // 4. Existing invalid .acl on disk still opens cleanly for repair, and Ground Painter save rejects it cleanly
    const cleanSourceHandle = openAclFile(stagedAcl);
    const brokenRoot = makeTmpDir('ac27-broken-open-');
    stageV3AudioIntoRoot(brokenRoot, 'ZGSZ', FIXTURES_GAME_ROOT_V3);
    const brokenLvlDir = gamePaths.levelsDir(brokenRoot, 'ZGSZ');
    fs.mkdirSync(brokenLvlDir, { recursive: true });
    const brokenAclPath = path.join(brokenLvlDir, 'ZGSZ_leisure_1.acl');
    const brokenContainer = injectBrokenPlanIntoContainer(cleanSourceHandle.container, {
      registration: 'B-13Q2',
      callSign: 'AXM1416',
      language: 'en',
      voice: 'Yeager',
    });
    fs.writeFileSync(brokenAclPath, encodeV3Container(brokenContainer));
    fs.writeFileSync(`${brokenAclPath}.bak`, 'BROKEN_ORIG_BAK', 'utf8');
    const brokenCsvPath = path.join(brokenLvlDir, 'flight_schedule_leisure_1.csv');
    fs.writeFileSync(brokenCsvPath, 'BROKEN_ORIG_CSV', 'utf8');
    const osmPath = path.join(gamePaths.airportDir(brokenRoot, 'ZGSZ'), 'geo_data.osm');
    fs.writeFileSync(osmPath, '<osm/>', 'utf8');
    const bgPath = `${brokenAclPath}.bg.json`;
    fs.writeFileSync(bgPath, '{"opacity":0.5}', 'utf8');

    const brokenAclHash = sha256File(brokenAclPath);
    const brokenOsmHash = sha256File(osmPath);
    const brokenBgHash = sha256File(bgPath);

    // Opens cleanly for repair!
    const reopenedBroken = openAclFile(brokenAclPath);
    const parsedBroken = parser.loadFlights(brokenAclPath);
    expect(reopenedBroken.format).toBe('gatcarc4-v3');
    expect(parsedBroken.flights.some((f) => f.CallSign === 'AXM1416' && f.Voice === 'Yeager')).toBe(true);

    // Scenery save (`saveV3GroundPainterData`) also enforces the callsign gate before touching files
    const gpScenery = reopenedBroken.readSceneryGraph();
    expect(() =>
      saveV3GroundPainterData({
        filePath: brokenAclPath,
        snapshotText: reopenedBroken.createPainterSnapshotToken(),
        graph: gpScenery.graph,
        meta: gpScenery.meta,
        createBackup: true,
      }),
    ).toThrow(CallsignAllocationError);
    expect(sha256File(brokenAclPath)).toBe(brokenAclHash);
    expect(sha256File(osmPath)).toBe(brokenOsmHash);
    expect(sha256File(bgPath)).toBe(brokenBgHash);

    // 5. Saved-output game-compat & `--replace` gate (`analyzeAclFile` + `runChecks` + `verifyAndCopyReplacedLevel`)
    const destRoot = makeTmpDir('ac27-replace-dest-');
    const destAclPath = stageLevelCopy(destRoot, 'ZGSZ', 'ZGSZ_leisure_1.acl', V3_ZSJN_FIXTURE);
    const destBakPath = `${destAclPath}.bak`;
    const destCsvPath = path.join(path.dirname(destAclPath), 'flight_schedule_leisure_1.csv');
    fs.writeFileSync(destBakPath, 'DEST_ORIG_BAK', 'utf8');
    fs.writeFileSync(destCsvPath, 'DEST_ORIG_CSV', 'utf8');

    const destAclHash = sha256File(destAclPath);
    const destBakHash = sha256File(destBakPath);
    const destCsvHash = sha256File(destCsvPath);

    const gcA = analyzeAclFile(brokenAclPath, {
      gameRoot: destRoot,
      airportIcao: 'ZGSZ',
      requireV3Audio: true,
    });
    const gc = runChecks(gcA, {
      gameRoot: destRoot,
      airportIcao: 'ZGSZ',
      requireV3Audio: true,
    });
    const gcClipIss = gc.issues.find((i) => i.code === 'v3-missing-captain-clip' && i.registration === 'B-13Q2');
    expect(gcClipIss).toBeTruthy();
    expect(gcClipIss).toMatchObject({
      code: 'v3-missing-captain-clip',
      registration: 'B-13Q2',
      callSign: 'AXM1416',
      voice: 'Yeager',
      compatibleCaptainVoices: ['CN-Captain-Middle-Aged-EN', 'CN-Captain-Young-EN'],
    });

    const dbgDir = makeTmpDir('ac27-gc-dbg-');
    let replaceErr = null;
    try {
      verifyAndCopyReplacedLevel(brokenAclPath, {
        tmpDir: brokenRoot,
        gameRoot: destRoot,
        seed: 987654321,
        debugDir: dbgDir,
      });
    } catch (err) {
      replaceErr = err;
    }
    expect(replaceErr).toBeTruthy();
    expect(replaceErr.message).toContain('v3-missing-captain-clip');
    expect(replaceErr.message).toContain('AXM1416');
    expect(replaceErr.message).toContain('Yeager');
    expect(sha256File(destAclPath)).toBe(destAclHash);
    expect(sha256File(destBakPath)).toBe(destBakHash);
    expect(sha256File(destCsvPath)).toBe(destCsvHash);

    // Failing artifact + seed persisted with structured missing-clip error
    const artifactJsonPath = path.join(dbgDir, 'fuzz-gc-fail-ZGSZ_leisure_1.json');
    const artifactAclPath = path.join(dbgDir, 'fuzz-gc-fail-ZGSZ_leisure_1.acl');
    expect(fs.existsSync(artifactAclPath)).toBe(true);
    expect(fs.existsSync(artifactJsonPath)).toBe(true);
    const savedArtifact = JSON.parse(fs.readFileSync(artifactJsonPath, 'utf8'));
    expect(savedArtifact.seed).toBe(987654321);
    expect(savedArtifact.issues.some((i) => i.code === 'v3-missing-captain-clip' && i.callSign === 'AXM1416')).toBe(true);
  });
});

describe('3d & 2b. Positive AXM1416 Pairing, Missing-Audio Capability Gate, & Legacy v2 Non-Regression', () => {
  it.each([
    'CN-Captain-Young-EN',
    'CN-Captain-Middle-Aged-EN',
  ])('accepts AXM1416 (B-13Q2) paired with %s across UI, MCP, v3 saveToFile, reload, and replace gate', (validVoice) => {
    const useZgsz = Boolean(CLEAN_ZGSZ_LEISURE_1);
    const icao = useZgsz ? 'ZGSZ' : 'ZSJN';
    const fileName = useZgsz ? 'ZGSZ_leisure_1.acl' : 'ZSJN_leisure_1.acl';
    const srcAcl = useZgsz ? CLEAN_ZGSZ_LEISURE_1 : V3_ZSJN_FIXTURE;
    const audioSrc = useZgsz ? GAME_ROOT : FIXTURES_GAME_ROOT_V3;

    const tmpRoot = makeTmpDir('ac27-axm-pos-');
    const stagedAcl = stageLevelCopy(tmpRoot, icao, fileName, srcAcl, audioSrc);
    const destRoot = makeTmpDir('ac27-axm-pos-dest-');
    const destAcl = stageLevelCopy(destRoot, icao, fileName, srcAcl, audioSrc);

    const handle = openAclFile(stagedAcl);
    const airportValues = buildAirportValuesForTest(tmpRoot, icao, handle);
    const loaded = handle.readFlights();
    const rwyTimeline = handle.readTimelines().runwayTimeline;
    const templateArr = loaded.flights.find((f) => !f.isDeparture && f.Airway) || loaded.flights[0];
    const usedStands = new Set(loaded.flights.map((f) => f.Stand));
    const freeStand = airportValues.Stand.find((s) => !usedStands.has(s)) || '604R';
    const useZgszRwy15 = Boolean(useZgsz && (airportValues._runwayStarMap['15'] || []).includes('SAREX4.15'));
    const posTimeline = useZgszRwy15
      ? {
          initialRunways: [...(rwyTimeline?.initialRunways || [])],
          timeline: [
            ...(rwyTimeline?.timeline || []),
            { time: '06:25:00', changes: [{ source: '33', dest: '15' }] },
          ],
        }
      : rwyTimeline;

    const goodAxmFlight = {
      ...templateArr,
      CallSign: 'AXM1416',
      AirlineName: 'AXM',
      Registration: 'B-13Q2',
      _Registration: 'B-13Q2',
      DepartureAirport: 'WMKK',
      ArrivalAirport: '',
      Stand: useZgsz && airportValues.Stand.includes('604R') && !usedStands.has('604R') ? '604R' : freeStand,
      Runway: useZgszRwy15 ? '15' : templateArr.Runway,
      Airway: useZgszRwy15 ? 'SAREX4.15' : templateArr.Airway,
      LandingTime: useZgsz ? '06:29:38' : (templateArr.LandingTime || '08:15:00'),
      InBlockTime: useZgsz ? '06:36:38' : (templateArr.InBlockTime || '08:22:00'),
      OffBlockTime: '',
      TakeoffTime: '',
      isDeparture: false,
      Language: 'en',
      Voice: validVoice,
    };

    const nextSchedule = [
      ...loaded.flights.filter(
        (f) => f.CallSign !== 'AXM1416' && (f._Registration || f.Registration) !== 'B-13Q2',
      ),
      goodAxmFlight,
    ];

    const uiIssues = runTripleValidation(
      nextSchedule,
      { [icao]: airportValues },
      icao,
      { byAirline: {}, allCallsigns: [], allAirlines: [] },
      null,
      null,
      null,
      posTimeline,
    );
    expect(uiIssues.filter((m) => m.includes('AXM1416'))).toEqual([]);

    const constraints = buildConstraints(
      { currentAirport: icao, airportValues: { [icao]: airportValues }, runwayTimeline: posTimeline },
      null,
    );
    const mcpErrs = validateFlightObjects(
      [goodAxmFlight],
      nextSchedule.slice(0, -1),
      constraints,
    );
    expect(mcpErrs).toBeNull();

    handle.applyEdits({ flights: nextSchedule, runwayTimeline: posTimeline });
    handle.saveToFile(stagedAcl, { createBackup: true });
    expect(fs.existsSync(`${stagedAcl}.bak`)).toBe(true);

    const reloaded = parser.loadFlights(stagedAcl);
    const savedRow = reloaded.flights.find((f) => f.CallSign === 'AXM1416');
    expect(savedRow).toBeTruthy();
    expect(savedRow.Voice).toBe(validVoice);
    expect(savedRow.Language).toBe('en');
    expect(savedRow._Registration || savedRow.Registration).toBe('B-13Q2');

    const gcA = analyzeAclFile(stagedAcl, {
      gameRoot: destRoot,
      airportIcao: icao,
      requireV3Audio: true,
    });
    const gc = runChecks(gcA, {
      gameRoot: destRoot,
      airportIcao: icao,
      requireV3Audio: true,
    });
    expect(gc.issues.filter((i) => !['docked-stand-before-offblock'].includes(i.code))).toEqual([]);

    const copied = verifyAndCopyReplacedLevel(stagedAcl, {
      tmpDir: tmpRoot,
      gameRoot: destRoot,
      debugDir: false,
    });
    expect(copied.dest).toBe(destAcl);
    expect(sha256File(destAcl)).toBe(sha256File(stagedAcl));
  });

  it('repairs a disposable copy of the fuzzed 61-flight ZGSZ_leisure_1.acl (AXM1416/B-13Q2 -> CN-Captain-Young-EN) and passes all v3 & game-compat gates without touching the installed file', () => {
    const installedZgszPath = gameLevelExists('ZGSZ', 'ZGSZ_leisure_1.acl')
      ? levelPath('ZGSZ', 'ZGSZ_leisure_1.acl')
      : null;
    const hasBrokenInstalledZgsz = (() => {
      if (!installedZgszPath || !fs.existsSync(installedZgszPath)) return false;
      try {
        const h = openAclFile(installedZgszPath);
        const res = validateV3CallsignAllocation(h.container, null, {
          gameRoot: GAME_ROOT,
          airportIcao: 'ZGSZ',
          requireAudioMetadata: true,
        });
        return !res.ok && res.issues.some((i) => i.registration === 'B-13Q2' && i.callSign === 'AXM1416');
      } catch (_) {
        return false;
      }
    })();

    const origInstalledHash = hasBrokenInstalledZgsz ? sha256File(installedZgszPath) : null;
    const tmpRoot = makeTmpDir('ac27-disposable-zgsz-');
    let disposableAcl;
    if (hasBrokenInstalledZgsz) {
      disposableAcl = stageLevelCopy(tmpRoot, 'ZGSZ', 'ZGSZ_leisure_1.acl', installedZgszPath, GAME_ROOT);
    } else {
      disposableAcl = stageLevelCopy(tmpRoot, 'ZGSZ', 'ZGSZ_leisure_1.acl', V3_ZSJN_FIXTURE, FIXTURES_GAME_ROOT_V3);
      const seedHandle = openAclFile(disposableAcl);
      const broken = injectBrokenPlanIntoContainer(seedHandle.container, {
        registration: 'B-13Q2',
        callSign: 'AXM1416',
        language: 'en',
        voice: 'Yeager',
      });
      fs.writeFileSync(disposableAcl, encodeV3Container(broken));
    }

    const beforeHandle = openAclFile(disposableAcl);
    const beforeCheck = validateV3CallsignAllocation(beforeHandle.container, null, {
      levelPath: disposableAcl,
      requireAudioMetadata: true,
    });
    expect(beforeCheck.ok).toBe(false);
    expect(beforeCheck.issues.some((i) => i.registration === 'B-13Q2' && i.callSign === 'AXM1416' && i.voice === 'Yeager')).toBe(true);

    const v3Bundle = loadV3AirportAudio(tmpRoot, 'ZGSZ');
    const allocMap = v3Bundle.v3Audio.allocatableCallsignsByVoice;
    const loaded = beforeHandle.readFlights();
    const repairedFlights = loaded.flights.map((f) => {
      if (f.Voice !== 'Yeager') return f;
      if ((f._Registration || f.Registration) === 'B-13Q2' && f.CallSign === 'AXM1416') {
        return { ...f, Language: 'en', Voice: 'CN-Captain-Young-EN' };
      }
      const compatVoice = ['CN-Captain-Young-EN', 'CN-Captain-Middle-Aged-EN'].find(
        (v) => (allocMap[v] || []).includes(f.CallSign),
      );
      return compatVoice ? { ...f, Language: 'en', Voice: compatVoice } : f;
    });

    beforeHandle.applyEdits({ flights: repairedFlights });
    beforeHandle.saveToFile(disposableAcl, { createBackup: true, requireAudioMetadata: true });

    const afterHandle = openAclFile(disposableAcl);
    const afterCheck = validateV3CallsignAllocation(afterHandle.container, null, {
      levelPath: disposableAcl,
      requireAudioMetadata: true,
    });
    expect(afterCheck.ok).toBe(true);
    expect(afterCheck.issues).toEqual([]);

    const reloaded = afterHandle.readFlights();
    expect(reloaded.flights.length).toBe(loaded.flights.length);
    const b13q2 = reloaded.flights.find((f) => (f._Registration || f.Registration) === 'B-13Q2');
    expect(b13q2).toBeTruthy();
    expect(b13q2.CallSign).toBe('AXM1416');
    expect(b13q2.Voice).toBe('CN-Captain-Young-EN');
    if (hasBrokenInstalledZgsz) {
      expect(reloaded.flights.length).toBe(61);
      expect(b13q2.LandingTime).toBe('06:29:38');
      expect(b13q2.Runway).toBe('15');
      expect(b13q2.Airway).toBe('SAREX4.15');
      expect(b13q2.Stand).toBe('604R');
      expect(sha256File(installedZgszPath)).toBe(origInstalledHash);
    }

    const gcA = analyzeAclFile(disposableAcl, {
      gameRoot: tmpRoot,
      airportIcao: 'ZGSZ',
      requireV3Audio: true,
    });
    const gc = runChecks(gcA, {
      gameRoot: tmpRoot,
      airportIcao: 'ZGSZ',
      requireV3Audio: true,
    });
    expect(gc.issues).toEqual([]);
  });

  it('withholds --replace and reports missing resources when staged sandbox omits v3 audio inputs', () => {
    const sourceRoot = makeTmpDir('ac27-cap-src-');
    const destAcl = stageLevelCopy(sourceRoot, 'ZGSZ', 'ZGSZ_leisure_1.acl', V3_ZSJN_FIXTURE);
    fs.writeFileSync(`${destAcl}.bak`, 'ORIG_DEST_BAK', 'utf8');

    const incompleteSandbox = makeTmpDir('ac27-cap-sandbox-');
    const stagedAcl = stageLevelCopy(incompleteSandbox, 'ZGSZ', 'ZGSZ_leisure_1.acl', V3_ZSJN_FIXTURE);
    fs.writeFileSync(`${stagedAcl}.bak`, 'SANDBOX_BAK', 'utf8');
    // Simulate pre-fix E2E staging that omitted radio_clip_durations.json and radio_channel_config.json
    fs.rmSync(gamePaths.radioClipDurationsPath(incompleteSandbox), { force: true });
    fs.rmSync(gamePaths.radioChannelConfigPath(incompleteSandbox, 'ZGSZ'), { force: true });

    const cap = verifyV3AudioCapabilities({
      targetRoot: incompleteSandbox,
      icao: 'ZGSZ',
      sourceRoot,
      requireUsable: true,
    });
    expect(cap.ok).toBe(false);
    expect(cap.missingOrUnreadable.map((m) => m.resource)).toEqual([
      'radio_clip_durations.json',
      'Airports/ZGSZ/radio_channel_config.json',
    ]);

    const origDestHash = sha256File(destAcl);
    expect(() =>
      verifyAndCopyReplacedLevel(stagedAcl, {
        tmpDir: incompleteSandbox,
        gameRoot: sourceRoot,
        debugDir: false,
      }),
    ).toThrow(/withholding replacement.*radio_clip_durations\.json.*Airports\/ZGSZ\/radio_channel_config\.json/);
    expect(sha256File(destAcl)).toBe(origDestHash);
  });

  it('leaves legacy v2 audio validation and save behavior completely unchanged', () => {
    const tmpV2Root = makeTmpDir('ac27-v2-nonreg-');
    fs.cpSync(V2_FIXTURE_ROOT, tmpV2Root, { recursive: true });
    const v2Acl = path.join(gamePaths.levelsDir(tmpV2Root, 'ZSJN'), 'ZSJN_leisure_1.acl');

    const handle = openAclFile(v2Acl);
    expect(handle.format).not.toBe('gatcarc4-v3');
    const loaded = handle.readFlights();
    expect(loaded.flights.length).toBeGreaterThan(0);

    parser.generateFullAcl(v2Acl, loaded.flights);
    const gcA = analyzeAclFile(v2Acl);
    const gc = runChecks(gcA);
    expect(gc.issues.filter((i) => String(i.code).startsWith('v3-'))).toEqual([]);
  });
});
