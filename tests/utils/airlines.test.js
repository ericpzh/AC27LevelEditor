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

  it('maps Tibet Airlines to its ICAO code TBA (not UEA)', () => {
    expect(AIRLINE_CODE_MAP['Tibet Airlines']).toBe('TBA');
    expect(AIRLINE_CODE_MAP['西藏航空']).toBe('TBA');
    expect(airlineDisplayName('TBA', 'en')).toBe('Tibet Airlines');
    expect(airlineDisplayName('TBA', 'zh')).toBe('西藏航空');
  });

  it('resolves the added carriers by code', () => {
    expect(airlineDisplayName('UEA', 'en')).toBe('Chengdu Airlines');
    expect(airlineDisplayName('UEA', 'zh')).toBe('成都航空');
    expect(airlineDisplayName('CSH', 'en')).toBe('Shanghai Airlines');
    expect(airlineDisplayName('CSH', 'zh')).toBe('上海航空');
    expect(airlineDisplayName('SWA', 'en')).toBe('Southwest Airlines');
    expect(airlineDisplayName('FFT', 'en')).toBe('Frontier Airlines');
    expect(airlineDisplayName('HAL', 'en')).toBe('Hawaiian Airlines');
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
