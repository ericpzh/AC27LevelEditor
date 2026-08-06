import { describe, it, expect } from 'vitest';
import { parseSpokenNumberValue } from '../../../src/components/MapWindows/voiceNumberParser';

// ─── English ───────────────────────────────────────────────────────────

describe('parseSpokenNumberValue (en)', () => {
  it('parses digit-by-digit (one two zero → 120)', () => {
    const r = parseSpokenNumberValue(['one', 'two', 'zero'], 'en');
    expect(r.value).toBe(120);
    expect(r.consumed).toBe(3);
  });

  it('parses digit-by-digit nine zero zero zero → 9000', () => {
    expect(parseSpokenNumberValue(['nine', 'zero', 'zero', 'zero'], 'en').value).toBe(9000);
  });

  it('parses "oh" as zero', () => {
    expect(parseSpokenNumberValue(['one', 'eight', 'oh'], 'en').value).toBe(180);
  });

  it('parses bare "o" as zero (one eight o → 180)', () => {
    expect(parseSpokenNumberValue(['one', 'eight', 'o'], 'en').value).toBe(180);
  });

  it('parses three oh five → 305', () => {
    expect(parseSpokenNumberValue(['three', 'oh', 'five'], 'en').value).toBe(305);
  });

  it('parses magnitude two thousand → 2000', () => {
    const r = parseSpokenNumberValue(['two', 'thousand'], 'en');
    expect(r.value).toBe(2000);
    expect(r.kind).toBe('magnitude');
  });

  it('parses magnitude nine thousand five hundred → 9500', () => {
    expect(parseSpokenNumberValue(['nine', 'thousand', 'five', 'hundred'], 'en').value).toBe(9500);
  });

  it('parses one hundred eighty → 180', () => {
    expect(parseSpokenNumberValue(['one', 'hundred', 'eighty'], 'en').value).toBe(180);
  });

  it('parses twelve hundred → 1200', () => {
    expect(parseSpokenNumberValue(['twelve', 'hundred'], 'en').value).toBe(1200);
  });

  it('skips "and" inside magnitudes (one hundred and twenty → 120)', () => {
    const r = parseSpokenNumberValue(['one', 'hundred', 'and', 'twenty'], 'en');
    expect(r.value).toBe(120);
    expect(r.consumed).toBe(4);
  });

  it('parses one hundred twenty five → 125', () => {
    expect(parseSpokenNumberValue(['one', 'hundred', 'twenty', 'five'], 'en').value).toBe(125);
  });

  it('parses one hundred and twenty five → 125 ("and" inside magnitude)', () => {
    expect(parseSpokenNumberValue(['one', 'hundred', 'and', 'twenty', 'five'], 'en').value).toBe(125);
  });

  it('parses nine thousand five hundred and twenty five → 9525', () => {
    expect(parseSpokenNumberValue(['nine', 'thousand', 'five', 'hundred', 'and', 'twenty', 'five'], 'en').value).toBe(9525);
  });

  it('parses slot form one eighty → 180', () => {
    expect(parseSpokenNumberValue(['one', 'eighty'], 'en').value).toBe(180);
  });

  it('parses slot form twenty five → 25', () => {
    expect(parseSpokenNumberValue(['twenty', 'five'], 'en').value).toBe(25);
  });

  it('parses five twenty → 520', () => {
    expect(parseSpokenNumberValue(['five', 'twenty'], 'en').value).toBe(520);
  });

  it('parses a lone teen twelve → 12', () => {
    expect(parseSpokenNumberValue(['twelve'], 'en').value).toBe(12);
  });

  it('accepts literal Arabic digits (9000)', () => {
    const r = parseSpokenNumberValue(['9000'], 'en');
    expect(r.value).toBe(9000);
    expect(r.consumed).toBe(1);
  });

  it('ignores trailing punctuation on tokens (180.)', () => {
    expect(parseSpokenNumberValue(['180.'], 'en').value).toBe(180);
  });

  it('returns null when the first token is not a number', () => {
    expect(parseSpokenNumberValue(['cleared', 'to', 'land'], 'en')).toBeNull();
  });

  it('"right" fuzzy-maps to eight WITHOUT the runway guard (three one right → 318)', () => {
    const r = parseSpokenNumberValue(['three', 'one', 'right'], 'en');
    expect(r.value).toBe(318);
    expect(r.consumed).toBe(3);
  });

  it('runway guard stops the suffix swallow (three one right → 31, consumed 2)', () => {
    const r = parseSpokenNumberValue(['three', 'one', 'right'], 'en', new Set(['right', 'left', 'center']));
    expect(r.value).toBe(31);
    expect(r.consumed).toBe(2);
  });
});

// ─── Chinese ───────────────────────────────────────────────────────────

describe('parseSpokenNumberValue (zh)', () => {
  it('parses 九千 → 9000 (magnitude, not 900)', () => {
    const r = parseSpokenNumberValue('九千', 'zh');
    expect(r.value).toBe(9000);
    expect(r.kind).toBe('magnitude');
  });

  it('parses 两千 → 2000', () => {
    expect(parseSpokenNumberValue('两千', 'zh').value).toBe(2000);
  });

  it('parses 一百八十 → 180', () => {
    expect(parseSpokenNumberValue('一百八十', 'zh').value).toBe(180);
  });

  it('parses 五千两百 → 5200', () => {
    expect(parseSpokenNumberValue('五千两百', 'zh').value).toBe(5200);
  });

  it('parses 十一 → 11', () => {
    expect(parseSpokenNumberValue('十一', 'zh').value).toBe(11);
  });

  it('parses 一百零五 → 105 (零 resets the colloquial ×10)', () => {
    expect(parseSpokenNumberValue('一百零五', 'zh').value).toBe(105);
  });

  it('parses colloquial 一百八 → 180', () => {
    expect(parseSpokenNumberValue('一百八', 'zh').value).toBe(180);
  });

  it('parses 一千五 → 1500 (colloquial ×100 after 千)', () => {
    expect(parseSpokenNumberValue('一千五', 'zh').value).toBe(1500);
  });

  it('parses digit-by-digit 幺二洞 → 120', () => {
    expect(parseSpokenNumberValue('幺二洞', 'zh').value).toBe(120);
  });

  it('parses digit-by-digit 两洞洞 → 200', () => {
    expect(parseSpokenNumberValue('两洞洞', 'zh').value).toBe(200);
  });

  it('accepts literal Arabic digits (9000)', () => {
    expect(parseSpokenNumberValue('9000', 'zh').value).toBe(9000);
  });

  it('returns null for non-number text', () => {
    expect(parseSpokenNumberValue('进近', 'zh')).toBeNull();
  });
});
