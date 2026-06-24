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

  it('parses teen numbers', () => {
    const r = parseEnglishFlightNumber(['eleven', 'eleven']);
    expect(r.candidates).toContain('1111');
  });

  it('parses grouped pairs (twelve thirty four)', () => {
    const r = parseEnglishFlightNumber(['twelve', 'thirty', 'four']);
    // twelve=12, thirty=30, four=4 → "12304"
    // Actually "thirty four" as spoken → "30"+"4" = "304" or "thirty-four" = "34"
    // Our tokenizer sees "twelve"=12, "thirty"=30, "four"=4 → "12304"
    expect(r.candidates).toContain('12304');
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
