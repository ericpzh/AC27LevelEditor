import { describe, it, expect } from 'vitest';
import acceptance from './voiceFuzzyAcceptance.json';
import { EN_PATTERNS, EN_PATTERN_KEYS, EN_APPROACH_TYPE_KEYS } from '../../../src/components/MapWindows/voiceTranscriptParser';
import { EN_NUMBER_FUZZY_KEYS, EN_UNIT_FUZZY_KEYS, lookupEnNumberToken, lookupUnitWord } from '../../../src/components/MapWindows/voiceNumberParser';
import { getSpokenNameWords } from '../../../src/components/MapWindows/voiceCallsignParser';
import { fuzzyMatch, fuzzyLookupKey, maxDistForWord, FLIGHT_NUMBER_FUZZY_GUARD } from '../../../src/components/MapWindows/voiceFuzzy';

/**
 * Round-trip: EVERY entry in the generated acceptance table must resolve to
 * its listed token through the RUNTIME lookup helpers — the table is the
 * documented surface, the runtime is the truth, and this pins the two
 * together. Regenerate with: node scripts/gen_voice_fuzzy_acceptance.mjs
 * (--check verifies without writing).
 */

const { slots } = acceptance;

describe('voiceFuzzyAcceptance: token coverage (fixture == real tables)', () => {
  it('pattern slot covers EN_PATTERN_KEYS exactly', () => {
    expect(Object.keys(slots.pattern).sort()).toEqual([...EN_PATTERN_KEYS].sort());
  });

  it('approach slot covers EN_APPROACH_TYPE_KEYS exactly', () => {
    expect(Object.keys(slots.approach).sort()).toEqual([...EN_APPROACH_TYPE_KEYS].sort());
  });

  it('numbers slot covers EN_NUMBER_FUZZY_KEYS exactly', () => {
    expect(Object.keys(slots.numbers).sort()).toEqual([...EN_NUMBER_FUZZY_KEYS].sort());
  });

  it('units slot covers EN_UNIT_FUZZY_KEYS exactly', () => {
    expect(Object.keys(slots.units).sort()).toEqual([...EN_UNIT_FUZZY_KEYS].sort());
  });

  it('airlines slot covers getSpokenNameWords() exactly', () => {
    expect(Object.keys(slots.airlines).sort()).toEqual([...getSpokenNameWords()].sort());
  });
});

describe('voiceFuzzyAcceptance: every variant resolves at runtime', () => {
  it('pattern variants map to their token (per-candidate D-L caps)', () => {
    for (const [token, variants] of Object.entries(slots.pattern)) {
      for (const v of variants) {
        expect(fuzzyLookupKey(v, EN_PATTERN_KEYS, maxDistForWord), `pattern '${v}' → '${token}'`).toBe(token);
      }
    }
  });

  it('approach variants map to their token (D-L ≤ 1)', () => {
    for (const [token, variants] of Object.entries(slots.approach)) {
      for (const v of variants) {
        expect(fuzzyLookupKey(v, EN_APPROACH_TYPE_KEYS, 1), `approach '${v}' → '${token}'`).toBe(token);
      }
    }
  });

  it('number variants map to their token via lookupEnNumberToken', () => {
    for (const [token, variants] of Object.entries(slots.numbers)) {
      for (const v of variants) {
        expect(lookupEnNumberToken(v), `number '${v}' → '${token}'`).toBe(token);
      }
    }
  });

  it('unit variants map to their token via lookupUnitWord', () => {
    for (const [token, variants] of Object.entries(slots.units)) {
      for (const v of variants) {
        expect(lookupUnitWord(v), `unit '${v}' → '${token}'`).toBe(token);
      }
    }
  });

  it('airline variants map to their name word (single-candidate fuzzyMatch)', () => {
    for (const [token, variants] of Object.entries(slots.airlines)) {
      for (const v of variants) {
        expect(fuzzyMatch(v, [token], 1)?.candidate, `airline '${v}' → '${token}'`).toBe(token);
      }
    }
  });
});

describe('voiceFuzzyAcceptance: locked rules', () => {
  it('semantic inversions are absent from the table AND blocked at runtime', () => {
    expect(slots.pattern.descend).not.toContain('ascend');
    expect(slots.pattern.increase).not.toContain('decrease');
    expect(fuzzyLookupKey('ascend', EN_PATTERN_KEYS, 2)).not.toBe('descend');
    expect(fuzzyLookupKey('decrease', EN_PATTERN_KEYS, 2)).not.toBe('increase');
  });

  it('exact table keys never appear as fuzzy variants (exact-first)', () => {
    expect(slots.numbers.eight).not.toContain('eighty');   // 'eighty' is an exact tens key
    expect(slots.units.knots).not.toContain('knot');       // 'knot' is an exact unit key
    expect(slots.units.meters).not.toContain('meter');
  });

  it('fillers never appear as variants', () => {
    const all = Object.values(slots).flatMap((s) => Object.values(s).flat());
    for (const filler of ['uh', 'um', 'er', 'ah', 'okay', 'ok', 'sir', 'please']) {
      expect(all).not.toContain(filler);
    }
  });

  it('airline 3-letter codes are not fuzzy keys', () => {
    const codes = Object.keys(slots.airlines).filter((w) => /^[a-z]{3}$/.test(w));
    expect(codes).not.toContain('dal');
    expect(codes).not.toContain('ual');
    expect(codes).not.toContain('sea');
  });

  it('FLIGHT_NUMBER_FUZZY_GUARD == the pattern words (no drift)', () => {
    const patternWords = [...new Set(EN_PATTERNS.flatMap((p) => p.words))].sort();
    expect([...FLIGHT_NUMBER_FUZZY_GUARD].sort()).toEqual(patternWords);
  });

  it('aviation additions are present (niner → nine)', () => {
    expect(slots.numbers.nine).toContain('niner');
  });

  it('the high-value short-token artifacts are present', () => {
    expect(slots.numbers.two).toContain('to');
    expect(slots.numbers.and).toContain('an');
    expect(slots.numbers.one).toContain('on');
    expect(slots.pattern.off).toContain('of');
  });
});
