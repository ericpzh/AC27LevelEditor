import { describe, it, expect } from 'vitest';
import { cascadeAirlineChange } from '../../src/store/flightCascade';

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
