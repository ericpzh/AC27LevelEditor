/**
 * Airline → captain-language policy — the game's CallsignService records a
 * callsign clip for exactly one captain language, so a flight's Language must
 * follow its callsign's airline (CN → zh, every other → en). A mismatch throws
 * `InvalidOperationException: Flight plan '<reg>' failed to allocate callsign
 * '<cs>' for crew voice '<voice>'` at level load (CAL2017 / CN-Captain-Young).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import {
  languageForAirline,
  airlineCodeForFlight,
  expectedLanguageForFlight,
} from '../../src/utils/airlineLanguage';

const require = createRequire(import.meta.url);
const { parseAirlineCountryRegistry, languageForAirlineCode } = require('../../src/acl/utils');

const COUNTRIES = { CCA: 'CN', CES: 'CN', CAL: 'TW', CPA: 'HK', ANA: 'JP', MAS: 'MY', AAL: 'US' };

describe('languageForAirline', () => {
  it('gives CN carriers zh when the airport supports Chinese', () => {
    expect(languageForAirline('CCA', COUNTRIES, ['en', 'zh'])).toBe('zh');
    expect(languageForAirline('CES', COUNTRIES, ['en', 'zh'])).toBe('zh');
  });

  it('gives every non-CN carrier en, including TW/HK (CAL, CPA)', () => {
    expect(languageForAirline('CAL', COUNTRIES, ['en', 'zh'])).toBe('en');
    expect(languageForAirline('CPA', COUNTRIES, ['en', 'zh'])).toBe('en');
    expect(languageForAirline('ANA', COUNTRIES, ['en'])).toBe('en');
    expect(languageForAirline('AAL', COUNTRIES, ['en'])).toBe('en');
  });

  it('falls a CN carrier back to en when the airport has no Chinese audio (KJFK)', () => {
    expect(languageForAirline('CCA', COUNTRIES, ['en'])).toBe('en');
  });

  it('keeps zh for CN when the airport language list is unknown', () => {
    expect(languageForAirline('CCA', COUNTRIES, null)).toBe('zh');
  });

  it('returns null for airlines missing from the registry', () => {
    expect(languageForAirline('ZZZ', COUNTRIES, ['en'])).toBe(null);
    expect(languageForAirline('', COUNTRIES, ['en'])).toBe(null);
    expect(languageForAirline('CCA', null, ['en'])).toBe(null);
  });
});

describe('airlineCodeForFlight', () => {
  it('prefers the callsign prefix', () => {
    expect(airlineCodeForFlight({ CallSign: 'CAL2017', AirlineName: 'EPA' })).toBe('CAL');
  });

  it('falls back to AirlineName / AirlineCode for a short callsign', () => {
    expect(airlineCodeForFlight({ CallSign: '', AirlineName: 'cpa' })).toBe('CPA');
    expect(airlineCodeForFlight({ CallSign: 'AB', AirlineCode: 'aal' })).toBe('AAL');
    expect(airlineCodeForFlight({})).toBe('');
  });
});

describe('expectedLanguageForFlight', () => {
  it('uses the callsign airline (not the AirlineName field)', () => {
    expect(expectedLanguageForFlight({ CallSign: 'CAL2017', AirlineName: 'CCA', Language: 'zh' }, COUNTRIES, ['en', 'zh'])).toBe('en');
  });
});

describe('parseAirlineCountryRegistry', () => {
  it('parses the game .cfg format into a flat airline -> country map', () => {
    const text = 'CN: BDJ, CCA, CES\nHK: CPA, CRK\nTW: CAL, EVA\n\n# ignored\n';
    const map = parseAirlineCountryRegistry(text);
    expect(map.CCA).toBe('CN');
    expect(map.CES).toBe('CN');
    expect(map.CPA).toBe('HK');
    expect(map.CAL).toBe('TW');
    expect(map.EVA).toBe('TW');
  });

  it('is tolerant of blank/whitespace and malformed lines', () => {
    expect(parseAirlineCountryRegistry('')).toEqual({});
    expect(parseAirlineCountryRegistry(null)).toEqual({});
    expect(parseAirlineCountryRegistry('not a registry line')).toEqual({});
    expect(parseAirlineCountryRegistry('us: aal , dal')).toEqual({ AAL: 'US', DAL: 'US' });
  });

  it('strips a UTF-8 BOM and accepts CRLF (macOS/Windows-saved files)', () => {
    const text = '\uFEFFCN: CCA, CES\r\nTW: CAL\r\nHK: CPA\r\n';
    const map = parseAirlineCountryRegistry(text);
    expect(map.CCA).toBe('CN'); // would be lost if the BOM swallowed line 1
    expect(map.CES).toBe('CN');
    expect(map.CAL).toBe('TW');
    expect(map.CPA).toBe('HK');
  });
});

describe('languageForAirlineCode (CJS backend/MCP copy)', () => {
  it('agrees with the ESM renderer copy when the airport language list is known', () => {
    // The ESM copy treats a *missing* language list as "unknown → zh" (the
    // historical airport default), while the CJS copy always receives an
    // explicit hasZh boolean. They must agree whenever the list is known.
    for (const [code, country] of Object.entries(COUNTRIES)) {
      for (const langs of [['en'], ['en', 'zh'], ['zh']]) {
        const hasZh = langs.includes('zh');
        expect(languageForAirlineCode(code, COUNTRIES, hasZh))
          .toBe(languageForAirline('' + code, COUNTRIES, langs));
      }
    }
  });

  it('returns null for an unknown airline / missing map', () => {
    expect(languageForAirlineCode('ZZZ', COUNTRIES, true)).toBe(null);
    expect(languageForAirlineCode('CAL', null, true)).toBe(null);
    expect(languageForAirlineCode('', COUNTRIES, true)).toBe(null);
  });
});
