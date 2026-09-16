import { describe, it, expect } from 'vitest';
import { AIRLINE_CODE_MAP, AIRLINE_CODE_TO_NAMES, airlineDisplayName } from '../../src/utils/constants/airlines';

describe('airlineDisplayName', () => {
  it('shows the English name for en', () => {
    expect(airlineDisplayName('CCA', 'en')).toBe('Air China');
    expect(airlineDisplayName('AAL', 'en')).toBe('American Airlines');
  });

  it('shows the Chinese name for zh', () => {
    expect(airlineDisplayName('CCA', 'zh')).toBe('中国国航');
    expect(airlineDisplayName('CES', 'zh')).toBe('中国东方航空');
  });

  it('falls back to the raw code when unknown', () => {
    expect(airlineDisplayName('XYZ', 'en')).toBe('XYZ');
    expect(airlineDisplayName('XYZ', 'zh')).toBe('XYZ');
    expect(airlineDisplayName('', 'en')).toBe('');
  });

  it('collects every name per code without duplicates', () => {
    expect(AIRLINE_CODE_TO_NAMES.CCA).toEqual(['Air China', '中国国航']);
    for (const [code, names] of Object.entries(AIRLINE_CODE_TO_NAMES)) {
      expect(names.length).toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(AIRLINE_CODE_MAP[n]).toBe(code);
    }
  });
});
