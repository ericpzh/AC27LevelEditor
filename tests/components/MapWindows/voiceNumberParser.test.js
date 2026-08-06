import { describe, it, expect } from 'vitest';
import {
  parseEnglishFlightNumber,
  parseChineseFlightNumber,
  generateCallsignCandidates,
  parseSpokenNumberValue,
  lookupEnNumberToken,
  lookupUnitWord,
} from '../../../src/components/MapWindows/voiceNumberParser';

// ─── English ───────────────────────────────────────────────────────────

describe('parseEnglishFlightNumber', () => {
  it('parses individual digits', () => {
    const r = parseEnglishFlightNumber(['one', 'two', 'three', 'four']);
    expect(r.candidates).toContain('1234');
    expect(r.consumed).toBe(4);
  });

  it('parses "oh" as zero', () => {
    const r = parseEnglishFlightNumber(['oh', 'four']);
    expect(r.candidates).toContain('04');
  });

  it('parses bare "o" as zero (speech engines render "oh" as "o")', () => {
    const r = parseEnglishFlightNumber(['o', 'four']);
    expect(r.candidates).toContain('04');
  });

  it('parses teen numbers', () => {
    const r = parseEnglishFlightNumber(['eleven', 'eleven']);
    expect(r.candidates).toContain('1111');
  });

  it('parses grouped pairs (twelve thirty four) → both readings', () => {
    const r = parseEnglishFlightNumber(['twelve', 'thirty', 'four']);
    // "thirty four" is ambiguous: "34" (thirty-four) and "304" (30 + 4).
    // Both readings stay as candidates; the aircraft list disambiguates.
    expect(r.candidates).toContain('1234');
    expect(r.candidates).toContain('12304');
  });

  it('composes tens + ones ("thirty four" → 34, keeping the 304 reading)', () => {
    const r = parseEnglishFlightNumber(['thirty', 'four']);
    expect(r.candidates).toContain('34');
    expect(r.candidates).toContain('304');
  });

  it('parses tens + "o" + ones ("thirty four o one" → 3401)', () => {
    const r = parseEnglishFlightNumber(['thirty', 'four', 'o', 'one']);
    expect(r.candidates).toContain('3401');
    expect(r.consumed).toBe(4);
  });

  it('keeps "thirty oh" as 300 only (no two-digit composition with zero)', () => {
    const r = parseEnglishFlightNumber(['thirty', 'oh']);
    expect(r.candidates).toEqual(['300']);
  });

  it('mixes literal digits with words ("34 oh one" → 3401)', () => {
    const r = parseEnglishFlightNumber(['34', 'oh', 'one']);
    expect(r.candidates).toContain('3401');
  });

  it('normalizes comma-suffixed word tokens ("three, four, o, one" → 3401)', () => {
    const r = parseEnglishFlightNumber(['three,', 'four,', 'o,', 'one']);
    expect(r.candidates).toContain('3401');
  });

  it('parses "triple X" aviation shorthand', () => {
    const r = parseEnglishFlightNumber(['triple', 'one']);
    expect(r.candidates).toContain('111');
  });

  it('parses "double X" shorthand', () => {
    const r = parseEnglishFlightNumber(['double', 'seven']);
    expect(r.candidates).toContain('77');
  });

  it('stops consuming at non-number words', () => {
    const r = parseEnglishFlightNumber(['one', 'two', 'cleared', 'to', 'land']);
    expect(r.candidates).toContain('12');
    expect(r.consumed).toBe(2);
  });

  it('returns empty when first token is not a number', () => {
    const r = parseEnglishFlightNumber(['cleared', 'to', 'land']);
    expect(r.candidates).toEqual([]);
    expect(r.consumed).toBe(0);
  });

  it('returns empty for empty input', () => {
    const r = parseEnglishFlightNumber([]);
    expect(r.candidates).toEqual([]);
    expect(r.consumed).toBe(0);
  });

  it('handles "zero" digit', () => {
    const r = parseEnglishFlightNumber(['one', 'zero', 'zero']);
    expect(r.candidates).toContain('100');
  });

  it('filters unreasonable length (>6 digits)', () => {
    // 7+ digit flight numbers don't exist
    const r = parseEnglishFlightNumber([
      'one', 'two', 'three', 'four', 'five', 'six', 'seven',
    ]);
    // 7 digits should be filtered
    expect(r.candidates.every(c => c.length <= 6)).toBe(true);
  });

  it('skips mid-number "the" ("for the eight thirty eight" → 4838, position-aware)', () => {
    const r = parseEnglishFlightNumber(['for', 'the', 'eight', 'thirty', 'eight']);
    expect(r.candidates).toContain('4838');
    expect(r.consumed).toBe(5);   // 'the' counts — remainingText slicing stays correct
  });

  it('skips leading "the" ("the one two" → 12)', () => {
    const r = parseEnglishFlightNumber(['the', 'one', 'two']);
    expect(r.candidates).toContain('12');
    expect(r.consumed).toBe(3);
  });

  it('digit confusables: "new one" → 21 and 91 readings (aircraft list disambiguates)', () => {
    const r = parseEnglishFlightNumber(['new', 'one']);
    expect(r.candidates).toContain('21');
    expect(r.candidates).toContain('91');
    expect(r.consumed).toBe(2);
  });

  it('digit confusables: "new york" → single-digit readings — list-match-gated, like "delta one" → DAL1', () => {
    const r = parseEnglishFlightNumber(['new', 'york']);
    expect(r.candidates).toEqual(['2', '9']);
  });
});

// ─── Chinese ───────────────────────────────────────────────────────────

describe('parseChineseFlightNumber', () => {
  it('parses digit-by-digit (幺-series)', () => {
    const r = parseChineseFlightNumber(['幺幺幺幺']);
    expect(r.candidates).toContain('1111');
  });

  it('parses digit-by-digit (一-series)', () => {
    const r = parseChineseFlightNumber(['一二三四']);
    expect(r.candidates).toContain('1234');
  });

  it('parses 洞 as zero', () => {
    const r = parseChineseFlightNumber(['洞四']);
    expect(r.candidates).toContain('04');
  });

  it('parses 两 as two', () => {
    const r = parseChineseFlightNumber(['一两三']);
    expect(r.candidates).toContain('123');
  });

  it('parses 零 as zero', () => {
    const r = parseChineseFlightNumber(['二零五']);
    expect(r.candidates).toContain('205');
  });

  it('parses multi-token input', () => {
    const r = parseChineseFlightNumber(['五', '八', '八', '八']);
    expect(r.candidates).toContain('5888');
  });

  it('stops at non-digit characters', () => {
    const r = parseChineseFlightNumber(['幺幺幺幺可以起飞']);
    expect(r.candidates).toContain('1111');
  });

  it('returns empty for non-number input', () => {
    const r = parseChineseFlightNumber(['可以起飞']);
    expect(r.candidates).toEqual([]);
  });
});

// ─── generateCallsignCandidates ────────────────────────────────────────

describe('generateCallsignCandidates', () => {
  it('generates callsigns from code + numbers', () => {
    const r = generateCallsignCandidates('UAL', ['1111']);
    expect(r).toEqual(['UAL1111']);
  });

  it('handles multiple number candidates', () => {
    const r = generateCallsignCandidates('CES', ['123', '1234']);
    expect(r).toContain('CES123');
    expect(r).toContain('CES1234');
  });
});

// ─── Fuzzy number/unit resolution (F5/F6 — D-L ≤ 1, fillers excluded) ──

describe('parseSpokenNumberValue (fuzzy EN)', () => {
  it('fuzzy digit word: "tree" → 3', () => {
    const r = parseSpokenNumberValue(['tree'], 'en');
    expect(r.value).toBe(3);
  });

  it('aviation addition: "niner" → 9', () => {
    const r = parseSpokenNumberValue(['niner'], 'en');
    expect(r.value).toBe(9);
  });

  it('fuzzy multiplier: "eight thousan" → 8000', () => {
    const r = parseSpokenNumberValue(['eight', 'thousan'], 'en');
    expect(r.value).toBe(8000);
  });

  it('fuzzy "and": "one hundred an fifty" → 150', () => {
    const r = parseSpokenNumberValue(['one', 'hundred', 'an', 'fifty'], 'en');
    expect(r.value).toBe(150);
    expect(r.consumed).toBe(4);
  });

  it('"to" carve-out: "to zero" → 20', () => {
    const r = parseSpokenNumberValue(['to', 'zero'], 'en');
    expect(r.value).toBe(20);
  });

  it('filler blocks the scan at position 0 ("uh four" → null)', () => {
    expect(parseSpokenNumberValue(['uh', 'four'], 'en')).toBeNull();
  });

  it('filler mid-scan still breaks the scan, value = scanned prefix', () => {
    const r = parseSpokenNumberValue(['three', 'uh', 'four'], 'en');
    expect(r.value).toBe(3); // 'uh' stays unknown — same as pre-fuzzy behavior
    expect(r.consumed).toBe(1);
  });
});

describe('lookupEnNumberToken', () => {
  it('exact-first over all keys incl. "oh"/"o"', () => {
    expect(lookupEnNumberToken('oh')).toBe('oh');
    expect(lookupEnNumberToken('o')).toBe('o');
    expect(lookupEnNumberToken('eighty')).toBe('eighty');
  });

  it('fuzzy D-L ≤ 1', () => {
    expect(lookupEnNumberToken('tree')).toBe('three');
    expect(lookupEnNumberToken('to')).toBe('two');
    expect(lookupEnNumberToken('thousan')).toBe('thousand');
    expect(lookupEnNumberToken('niner')).toBe('nine');
  });

  it('fillers and unknown words → null', () => {
    expect(lookupEnNumberToken('uh')).toBeNull();
    expect(lookupEnNumberToken('xyzzy')).toBeNull();
  });

  it('fuzzy guard blocks the fallback only ("right" must not become "eight")', () => {
    expect(lookupEnNumberToken('right')).toBe('eight');
    expect(lookupEnNumberToken('right', new Set(['right', 'left', 'center']))).toBeNull();
    expect(lookupEnNumberToken('eight', new Set(['right', 'left', 'center']))).toBe('eight');   // exact unaffected
  });

  it('exact "hundred" resolves (flight-number path rejects it separately)', () => {
    expect(lookupEnNumberToken('hundred')).toBe('hundred');
  });
});

describe('lookupUnitWord', () => {
  it('exact-first over all keys incl. "m"/"ft"', () => {
    expect(lookupUnitWord('m')).toBe('m');
    expect(lookupUnitWord('ft')).toBe('ft');
    expect(lookupUnitWord('knots')).toBe('knots');
  });

  it('fuzzy D-L ≤ 1', () => {
    expect(lookupUnitWord('feat')).toBe('feet');
    expect(lookupUnitWord('knotts')).toBe('knots');
    expect(lookupUnitWord('nots')).toBe('knots');   // SAPI drops the k
    expect(lookupUnitWord('metre')).toBe('meter');  // UK spelling
  });

  it('fillers never resolve ("um" must not become "m")', () => {
    expect(lookupUnitWord('um')).toBeUndefined();
  });
});
