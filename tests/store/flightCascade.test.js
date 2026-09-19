import { describe, it, expect } from 'vitest';
import { cascadeAirlineChange, cascadeLanguageChange } from '../../src/store/flightCascade';

describe('cascadeLanguageChange', () => {
  const POOL = ['CN-Captain-Young', 'CN-Captain-Middle-Aged', 'CN-Captain-Young-EN', 'CN-Captain-Middle-Aged-EN'];
  const LANGS = {
    'CN-Captain-Young': 'zh', 'CN-Captain-Middle-Aged': 'zh',
    'CN-Captain-Young-EN': 'en', 'CN-Captain-Middle-Aged-EN': 'en',
  };

  it('returns the first pool voice whose language matches', () => {
    expect(cascadeLanguageChange('zh', { Voice: POOL, _voiceLanguages: LANGS })).toEqual({ Voice: 'CN-Captain-Young' });
    expect(cascadeLanguageChange('en', { Voice: POOL, _voiceLanguages: LANGS })).toEqual({ Voice: 'CN-Captain-Young-EN' });
  });

  it('prefers catalog-unknown voices when nothing matches the new language', () => {
    const vals = { Voice: ['Custom-A', ...POOL], _voiceLanguages: LANGS };
    expect(cascadeLanguageChange('ja', vals)).toEqual({ Voice: 'Custom-A' });
  });

  it('falls back to the first pool voice when every known voice mismatches', () => {
    const vals = { Voice: ['CN-Captain-Young', 'CN-Captain-Middle-Aged'], _voiceLanguages: LANGS };
    expect(cascadeLanguageChange('ja', vals)).toEqual({ Voice: 'CN-Captain-Young' });
  });

  it('returns {} without a catalog map or a voice pool', () => {
    expect(cascadeLanguageChange('zh', { Voice: POOL })).toEqual({});
    expect(cascadeLanguageChange('zh', { _voiceLanguages: LANGS })).toEqual({});
    expect(cascadeLanguageChange('zh', {})).toEqual({});
  });
});

describe('cascadeAirlineChange', () => {
  const airportValues = {
    _registrationMap: {
      'DAL|A320': ['N111DL', 'N222DL'],
      'DAL|B77W': ['N777DL'],
    },
  };

  it('keeps AircraftType and only cascades Registration + AirlineName', () => {
    const flight = { CallSign: 'AAL1001', AircraftType: 'B77W', Registration: 'N123AB' };
    const updates = cascadeAirlineChange('DAL', flight, airportValues);
    // AircraftType is airline-independent — never reset by an airline change.
    expect(updates).not.toHaveProperty('AircraftType');
    expect(updates.AirlineName).toBe('DAL');
    // Registration is invalid for DAL|B77W → cascade to the first valid one.
    expect(updates.Registration).toBe('N777DL');
  });

  it('leaves a still-valid Registration untouched', () => {
    const flight = { AircraftType: 'A320', Registration: 'N222DL' };
    const updates = cascadeAirlineChange('DAL', flight, airportValues);
    expect(updates.AirlineName).toBe('DAL');
    expect(updates).not.toHaveProperty('Registration');
  });

  it('leaves Registration when the new (airline, aircraft) pair has no map', () => {
    const flight = { AircraftType: 'A320', Registration: 'N123AB' };
    const updates = cascadeAirlineChange('XXX', flight, airportValues);
    expect(updates.AirlineName).toBe('XXX');
    expect(updates).not.toHaveProperty('Registration');
  });

  it('reads the internal _Registration when no explicit Registration is set', () => {
    const flight = { AircraftType: 'A320', _Registration: 'N999XX' };
    const updates = cascadeAirlineChange('DAL', flight, airportValues);
    expect(updates.Registration).toBe('N111DL');
  });
});
