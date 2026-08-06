import { describe, it, expect } from 'vitest';
import {
  parseEnglishFlightNumber,
  parseChineseFlightNumber,
  generateCallsignCandidates,
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
