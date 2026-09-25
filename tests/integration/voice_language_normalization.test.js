/**
 * Voice/Language consistency regression — the game's VoiceCatalog throws
 * InvalidOperationException at level load when an aircraft's captain voice
 * declares a language other than the flight's Language (fuzz-discovered at
 * ZGSZ leisure_2: `CN-Captain-Middle-Aged-EN` on a `zh` flight).
 *
 * Covers the two defence layers:
 *   - the save-pipeline normalizer `_normalizeFlightsForGameCompat` repairs
 *     mismatched/unknown voices to a same-language captain voice
 *   - the game-compat analyzer `runChecks` reports `voice-language-mismatch`
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { readAclText } = require('../../src/acl/gatcarc');
const { _normalizeFlightsForGameCompat, _loadAirlineCountryRegistryForLevel, _airportSupportsChinese } = require('../../src/acl/flight_plans');
const { runChecks, analyze } = require('./gamecompat-utils.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  __dirname,
  '../fixtures/game-root/GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels/ZSJN_leisure_1.acl'
);
const FIXTURE_TEXT = readAclText(FIXTURE);

const CATALOG = {
  'CN-Captain-Young': { language: 'zh', role: 'captain' },
  'CN-Captain-Middle-Aged': { language: 'zh', role: 'captain' },
  'CN-Captain-Young-EN': { language: 'en', role: 'captain' },
  'CN-Captain-Middle-Aged-EN': { language: 'en', role: 'captain' },
  'Yeager': { language: 'en', role: 'captain' },
  'Hanser': { language: 'zh', role: 'atc' },
};

const noop = () => {};

function normalize(flights, catalog = CATALOG) {
  return _normalizeFlightsForGameCompat(flights, FIXTURE_TEXT, noop, null, null, catalog);
}

describe('_normalizeFlightsForGameCompat — voice/language repair', () => {
  it('repairs an -EN voice on a zh flight to a zh captain voice', () => {
    const flights = [{ CallSign: 'CES1234', Registration: 'B-1', Voice: 'CN-Captain-Middle-Aged-EN', Language: 'zh' }];
    const r = normalize(flights);
    expect(r.voiced).toBe(1);
    expect(CATALOG[flights[0].Voice].language).toBe('zh');
    expect(CATALOG[flights[0].Voice].role).toBe('captain');
  });

  it('repairs a zh voice on an en flight to an en captain voice', () => {
    const flights = [{ CallSign: 'CES1234', Registration: 'B-1', Voice: 'CN-Captain-Young', Language: 'en' }];
    const r = normalize(flights);
    expect(r.voiced).toBe(1);
    expect(CATALOG[flights[0].Voice].language).toBe('en');
  });

  it('repairs a voice unknown to the catalog', () => {
    const flights = [{ CallSign: 'CES1234', Registration: 'B-1', Voice: 'SomeCustomVoice', Language: 'zh' }];
    const r = normalize(flights);
    expect(r.voiced).toBe(1);
    expect(CATALOG[flights[0].Voice].language).toBe('zh');
  });

  it('never selects an atc-role voice as the captain replacement', () => {
    const flights = [{ CallSign: 'CES1234', Registration: 'B-1', Voice: 'cn', Language: 'zh' }];
    normalize(flights);
    expect(flights[0].Voice).not.toBe('Hanser');
    expect(CATALOG[flights[0].Voice].role).toBe('captain');
  });

  it('prefers a same-language voice already used in the level', () => {
    const flights = [
      { CallSign: 'CES0001', Registration: 'B-1', Voice: 'CN-Captain-Young', Language: 'zh' },
      { CallSign: 'CES0002', Registration: 'B-2', Voice: 'CN-Captain-Young-EN', Language: 'zh' },
    ];
    const r = normalize(flights);
    expect(r.voiced).toBe(1);
    expect(flights[1].Voice).toBe('CN-Captain-Young');
  });

  it('leaves a consistent voice untouched', () => {
    const flights = [{ CallSign: 'CES1234', Registration: 'B-1', Voice: 'Yeager', Language: 'en' }];
    const r = normalize(flights);
    expect(r.voiced).toBe(0);
    expect(flights[0].Voice).toBe('Yeager');
  });

  it('leaves voices untouched when no catalog is available', () => {
    const flights = [{ CallSign: 'CES1234', Registration: 'B-1', Voice: 'CN-Captain-Middle-Aged-EN', Language: 'zh' }];
    const r = normalize(flights, null);
    expect(r.voiced).toBe(0);
    expect(flights[0].Voice).toBe('CN-Captain-Middle-Aged-EN');
  });

  it('repairs every mismatch in a mixed batch', () => {
    const flights = [
      { CallSign: 'CES0001', Registration: 'B-1', Voice: 'CN-Captain-Young-EN', Language: 'zh' },
      { CallSign: 'CES0002', Registration: 'B-2', Voice: 'CN-Captain-Young', Language: 'en' },
      { CallSign: 'CES0003', Registration: 'B-3', Voice: 'Yeager', Language: 'en' },
    ];
    const r = normalize(flights);
    expect(r.voiced).toBe(2);
    for (const f of flights) {
      expect(CATALOG[f.Voice].language).toBe(f.Language);
    }
  });
});

describe('_normalizeFlightsForGameCompat — airline/language repair', () => {
  const COUNTRIES = { CCA: 'CN', CES: 'CN', CAL: 'TW', CPA: 'HK', AAL: 'US' };
  function normalizeWithAirlines(flights, countries = COUNTRIES, hasZh = true, catalog = CATALOG) {
    return _normalizeFlightsForGameCompat(flights, FIXTURE_TEXT, noop, null, null, catalog, countries, hasZh);
  }

  it('repairs a non-CN carrier (CAL) from zh to en, including its voice', () => {
    const flights = [{ CallSign: 'CAL2017', Registration: 'B-40N0', Voice: 'CN-Captain-Young', Language: 'zh' }];
    const r = normalizeWithAirlines(flights);
    expect(r.relanguaged).toBe(1);
    expect(r.voiced).toBe(1);
    expect(flights[0].Language).toBe('en');
    expect(CATALOG[flights[0].Voice].language).toBe('en');
  });

  it('repairs a CN carrier from en to zh at a zh-capable airport', () => {
    const flights = [{ CallSign: 'CCA1111', Registration: 'B-1', Voice: 'Yeager', Language: 'en' }];
    const r = normalizeWithAirlines(flights, COUNTRIES, true);
    expect(r.relanguaged).toBe(1);
    expect(r.voiced).toBe(1);
    expect(flights[0].Language).toBe('zh');
    expect(CATALOG[flights[0].Voice].language).toBe('zh');
  });

  it('leaves a CN carrier in en at an en-only airport', () => {
    const flights = [{ CallSign: 'CCA1111', Registration: 'B-1', Voice: 'Yeager', Language: 'en' }];
    const r = normalizeWithAirlines(flights, COUNTRIES, false);
    expect(r.relanguaged).toBe(0);
    expect(flights[0].Language).toBe('en');
    expect(flights[0].Voice).toBe('Yeager');
  });

  it('never touches an airline missing from the registry', () => {
    const flights = [{ CallSign: 'ZZZ1234', Registration: 'B-1', Voice: 'CN-Captain-Young', Language: 'zh' }];
    const r = normalizeWithAirlines(flights);
    expect(r.relanguaged).toBe(0);
    expect(flights[0].Language).toBe('zh');
  });

  it('is a no-op without the registry map', () => {
    const flights = [{ CallSign: 'CAL2017', Registration: 'B-40N0', Voice: 'CN-Captain-Young', Language: 'zh' }];
    const r = _normalizeFlightsForGameCompat(flights, FIXTURE_TEXT, noop, null, null, CATALOG, null, true);
    expect(r.relanguaged).toBe(0);
    expect(flights[0].Language).toBe('zh');
  });
});

describe('runChecks — voice-language-mismatch', () => {
  function base(overrides = {}) {
    return {
      config: {},
      doc0Plans: [],
      frameDocked: [],
      frameAircraftRegs: [],
      frameAircraftMap: new Map(),
      frameFp: new Map(),
      planKeys: new Map(),
      ...overrides,
    };
  }

  it('reports a mismatch when the catalog is supplied', () => {
    const a = base({ doc0Plans: [{ reg: 'B-1', leg: 'A', voice: 'CN-Captain-Middle-Aged-EN', language: 'zh' }] });
    const { issues } = runChecks(a, { voiceLanguages: { 'CN-Captain-Middle-Aged-EN': 'en' } });
    expect(issues.some((i) => i.code === 'voice-language-mismatch')).toBe(true);
  });

  it('does not report when voice and language agree', () => {
    const a = base({ doc0Plans: [{ reg: 'B-1', leg: 'A', voice: 'Yeager', language: 'en' }] });
    const { issues } = runChecks(a, { voiceLanguages: { Yeager: 'en' } });
    expect(issues.some((i) => i.code === 'voice-language-mismatch')).toBe(false);
  });

  it('skips the check when no catalog is supplied', () => {
    const a = base({ doc0Plans: [{ reg: 'B-1', leg: 'A', voice: 'X', language: 'zh' }] });
    const { issues } = runChecks(a);
    expect(issues.some((i) => i.code === 'voice-language-mismatch')).toBe(false);
  });
});

describe('analyze — Voice/Language come from the FlightPlanState', () => {
  it('extracts voice + language for every plan in a real level', () => {
    // Regression: analyze() used to read Voice/Language from the leg node
    // (InitialArrival/InitialDeparture), where they do not exist, so both
    // voice-language-mismatch and airline-language-mismatch were silently inert.
    const a = analyze(FIXTURE_TEXT);
    expect(a.doc0Plans.length).toBeGreaterThan(0);
    for (const p of a.doc0Plans) {
      expect(p.voice).toBeTruthy();
      expect(p.language).toBeTruthy();
    }
  });
});

describe('runChecks — airline-language-mismatch', () => {
  const COUNTRIES = { CCA: 'CN', CAL: 'TW', CPA: 'HK', AAL: 'US' };
  function base(overrides = {}) {
    return {
      config: {},
      doc0Plans: [],
      frameDocked: [],
      frameAircraftRegs: [],
      frameAircraftMap: new Map(),
      frameFp: new Map(),
      planKeys: new Map(),
      ...overrides,
    };
  }

  it('reports a non-CN carrier (CAL) flying a zh language', () => {
    const a = base({ doc0Plans: [{ reg: 'B-40N0', leg: 'A', arrCs: 'CAL2017', language: 'zh' }] });
    const { issues } = runChecks(a, { airlineCountries: COUNTRIES, languages: ['en', 'zh'] });
    expect(issues.some((i) => i.code === 'airline-language-mismatch')).toBe(true);
  });

  it('reports a CN carrier (CCA) flying en at a zh-capable airport', () => {
    const a = base({ doc0Plans: [{ reg: 'B-1', leg: 'D', depCs: 'CCA1111', language: 'en' }] });
    const { issues } = runChecks(a, { airlineCountries: COUNTRIES, languages: ['en', 'zh'] });
    expect(issues.some((i) => i.code === 'airline-language-mismatch')).toBe(true);
  });

  it('accepts a CN carrier flying en at an en-only airport (no zh audio)', () => {
    const a = base({ doc0Plans: [{ reg: 'B-1', leg: 'D', depCs: 'CCA1111', language: 'en' }] });
    const { issues } = runChecks(a, { airlineCountries: COUNTRIES, languages: ['en'] });
    expect(issues.some((i) => i.code === 'airline-language-mismatch')).toBe(false);
  });

  it('accepts a correct combo (CAL en, CPA en, CCA zh)', () => {
    const a = base({ doc0Plans: [
      { reg: 'B-1', leg: 'A', arrCs: 'CAL2017', language: 'en' },
      { reg: 'B-2', leg: 'A', arrCs: 'CPA841', language: 'en' },
      { reg: 'B-3', leg: 'A', arrCs: 'CCA1111', language: 'zh' },
    ] });
    const { issues } = runChecks(a, { airlineCountries: COUNTRIES, languages: ['en', 'zh'] });
    expect(issues.some((i) => i.code === 'airline-language-mismatch')).toBe(false);
  });

  it('skips the check when no registry map is supplied', () => {
    const a = base({ doc0Plans: [{ reg: 'B-40N0', leg: 'A', arrCs: 'CAL2017', language: 'zh' }] });
    const { issues } = runChecks(a, { languages: ['en', 'zh'] });
    expect(issues.some((i) => i.code === 'airline-language-mismatch')).toBe(false);
  });
});

describe('_loadAirlineCountryRegistryForLevel / _airportSupportsChinese — cross-platform paths', () => {
  function seedLevelLayout(dataRoot) {
    // Mirrors the real tree under whatever data root the OS uses:
    //   <dataRoot>/StreamingAssets/airline_country_registry.cfg
    //   <dataRoot>/StreamingAssets/Airports/ZGSZ/Levels/x.acl
    //   <dataRoot>/StreamingAssets/Airports/ZGSZ/Levels/audio_clips_zh.json
    const sa = path.join(dataRoot, 'StreamingAssets');
    const levels = path.join(sa, 'Airports', 'ZGSZ', 'Levels');
    fs.mkdirSync(levels, { recursive: true });
    fs.writeFileSync(path.join(sa, 'airline_country_registry.cfg'), 'CN: CCA, CES\nTW: CAL\nHK: CPA\n');
    fs.writeFileSync(path.join(levels, 'audio_clips_zh.json'), '{}');
    return path.join(levels, 'ZGSZ_test.acl');
  }

  function withTempLayout(dataRootParts, fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-registry-'));
    try {
      const acl = seedLevelLayout(path.join(tmp, ...dataRootParts));
      fn(acl);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('finds the registry from a Windows/Linux level path', () => {
    withTempLayout(['GroundATC_Data'], (acl) => {
      const map = _loadAirlineCountryRegistryForLevel(acl);
      expect(map.CAL).toBe('TW');
      expect(map.CCA).toBe('CN');
      expect(_airportSupportsChinese(acl)).toBe(true);
    });
  });

  it('finds the registry from a macOS .app bundle level path', () => {
    withTempLayout(['GroundATC.app', 'Contents', 'Resources', 'Data'], (acl) => {
      const map = _loadAirlineCountryRegistryForLevel(acl);
      expect(map.CAL).toBe('TW');
      expect(map.CPA).toBe('HK');
      expect(_airportSupportsChinese(acl)).toBe(true);
    });
  });

  it('finds the registry from a macOS bundle that keeps the GroundATC_Data name', () => {
    withTempLayout(['GroundATC.app', 'Contents', 'Resources', 'GroundATC_Data'], (acl) => {
      expect(_loadAirlineCountryRegistryForLevel(acl).CAL).toBe('TW');
    });
  });

  it('returns null / false when the registry or Chinese audio is absent', () => {
    withTempLayout(['GroundATC_Data'], (acl) => {
      fs.rmSync(path.join(path.dirname(acl), '..', '..', '..', 'airline_country_registry.cfg'));
      expect(_loadAirlineCountryRegistryForLevel(acl)).toBeNull();
      expect(_airportSupportsChinese(acl)).toBe(true); // audio file still present
    });
  });
});
