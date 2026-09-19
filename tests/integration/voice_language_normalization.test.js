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
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { readAclText } = require('../../src/acl/gatcarc');
const { _normalizeFlightsForGameCompat } = require('../../src/acl/flight_plans');
const { runChecks } = require('./gamecompat-utils.cjs');

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
