/**
 * Unit tests for the aviationstack → AC27 flight mapper.
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  buildFlightsFromAviationstack, mapAviationstackFlight,
  isoToLocalHHMM, fitTimeToWindow,
} from '../../src/utils/realtime/aviationstack.js';

function baseVals(overrides = {}) {
  return {
    AirlineCode: ['CSN', 'CCA'],
    AircraftType: ['BOEING 737-800', 'AIRBUS A320'],
    Registration: ['B-1234', 'B-5678'],
    Stand: ['A1', 'A2'],
    Runway: ['01', '19'],
    Voice: ['pilot-en', 'pilot-zh'],
    Language: ['en', 'zh'],
    _designatorToType: { B738: 'BOEING 737-800', A320: 'AIRBUS A320' },
    _compat: { airlineToAircraft: { CSN: ['BOEING 737-800', 'AIRBUS A320'], CCA: ['BOEING 737-800'] } },
    _flightNums: { CSN: ['3115', '3116'], CCA: ['1234'] },
    _registrationMap: {
      'CSN|BOEING 737-800': ['B-1234'],
      'CSN|AIRBUS A320': ['B-5678'],
    },
    _runwayStarMap: { '01': ['STAR01'], '19': ['STAR19'] },
    _voiceLanguages: { 'pilot-en': 'en', 'pilot-zh': 'zh' },
    ...overrides,
  };
}

function arrival(over = {}) {
  return {
    flight_date: '2026-09-19',
    flight_status: 'scheduled',
    departure: { icao: 'ZGGG', iata: 'CAN', timezone: 'Asia/Shanghai', scheduled: '2026-09-19T10:20:00+00:00' },
    arrival: { icao: 'ZSJN', iata: 'TNA', timezone: 'Asia/Shanghai', scheduled: '2026-09-19T12:05:00+00:00' },
    airline: { name: 'China Southern Airlines', iata: 'CZ', icao: 'CSN' },
    flight: { number: '3115', iata: 'CZ3115', icao: 'CSN3115', codeshared: null },
    aircraft: { registration: 'B-1234', iata: '320', icao: 'A320' },
    live: null,
    ...over,
  };
}

describe('isoToLocalHHMM', () => {
  it('reads the wall-clock time as authored (aviationstack tags local time as +00:00)', () => {
    // No timezone shifting: 10:20 is the airport-local time.
    expect(isoToLocalHHMM('2026-09-19T10:20:00+00:00', 'Asia/Shanghai')).toBe('10:20');
    expect(isoToLocalHHMM('2026-09-20T08:35:00+00:00', 'America/New_York')).toBe('08:35');
  });
  it('returns null for missing/invalid input', () => {
    expect(isoToLocalHHMM(null, 'UTC')).toBeNull();
    expect(isoToLocalHHMM('not-a-date', 'UTC')).toBeNull();
  });
});

describe('fitTimeToWindow', () => {
  it('keeps a time already inside the window', () => {
    expect(fitTimeToWindow('12:00', 6 * 60, 20 * 60)).toBe('12:00:00');
  });
  it('handles a window that crosses midnight', () => {
    expect(fitTimeToWindow('01:00', 22 * 60, 2 * 60)).toBe('01:00:00');
    expect(fitTimeToWindow('23:00', 22 * 60, 2 * 60)).toBe('23:00:00');
  });
  it('returns null when the time is outside a non-crossing window', () => {
    expect(fitTimeToWindow('12:00', 13 * 60, 14 * 60)).toBeNull();
    expect(fitTimeToWindow('01:00', 22 * 60, 23 * 60 + 59)).toBeNull();
  });
  it('uses raw time when no window given', () => {
    expect(fitTimeToWindow('12:34', null, null)).toBe('12:34:00');
  });
});

describe('mapAviationstackFlight', () => {
  it('maps an arrival to a full 15-field flight', () => {
    const { flight, keep } = mapAviationstackFlight(arrival(), {
      airportIcao: 'ZSJN',
      vals: baseVals(),
      usedCallsigns: new Set(),
      usedStands: new Set(),
      usedRegs: new Set(),
      configStartTime: '06:00',
      configEndTime: '23:00',
    });
    expect(keep).toBe(true);
    expect(flight.CallSign).toBe('CSN3115');
    expect(flight.isDeparture).toBe(false);
    expect(flight.DepartureAirport).toBe('ZGGG');
    expect(flight.ArrivalAirport).toBe('');
    expect(flight.AircraftType).toBe('AIRBUS A320');
    expect(flight.LandingTime).toMatch(/^\d{2}:\d{2}:00$/);
    expect(flight.Airway).toBeTruthy();
    expect(flight.Stand).toBeTruthy();
    expect(flight.Language).toBe('zh');
    expect(flight.Voice).toBe('pilot-zh');
  });

  it('maps a departure and clears the STAR', () => {
    const raw = arrival({
      departure: { icao: 'ZSJN', timezone: 'Asia/Shanghai', scheduled: '2026-09-19T10:20:00+00:00' },
      arrival: { icao: 'ZGGG', timezone: 'Asia/Shanghai', scheduled: '2026-09-19T12:05:00+00:00' },
    });
    const { flight, keep } = mapAviationstackFlight(raw, {
      airportIcao: 'ZSJN', vals: baseVals(),
      usedCallsigns: new Set(), usedStands: new Set(), usedRegs: new Set(),
      configStartTime: '06:00', configEndTime: '23:00',
    });
    expect(keep).toBe(true);
    expect(flight.isDeparture).toBe(true);
    expect(flight.DepartureAirport).toBe('');
    expect(flight.ArrivalAirport).toBe('ZGGG');
    expect(flight.Airway).toBe('');
    expect(flight.OffBlockTime).toBeTruthy();
  });

  it('keeps codeshare records (they are legitimate flights)', () => {
    const raw = arrival({
      airline: { name: 'China Southern Airlines', iata: 'CZ', icao: 'CSN' },
      flight: { number: '3115', icao: 'CSN3115', iata: 'CZ3115', codeshared: { airline_name: 'X' } },
    });
    const res = mapAviationstackFlight(raw, {
      airportIcao: 'ZSJN', vals: baseVals(),
      usedCallsigns: new Set(), usedStands: new Set(), usedRegs: new Set(),
      configStartTime: '06:00', configEndTime: '23:00',
    });
    expect(res.keep).toBe(true);
    expect(res.flight.CallSign).toBe('CSN3115');
  });

  it('resolves the airline code and number from ICAO-format fields', () => {
    // airline.icao missing; only flight.icao / flight.number are supplied
    const raw = arrival({
      airline: { name: 'China Southern Airlines', iata: 'CZ', icao: null },
      flight: { number: null, icao: 'CSN3115', iata: 'CZ3115', codeshared: null },
    });
    const { flight, keep } = mapAviationstackFlight(raw, {
      airportIcao: 'ZSJN', vals: baseVals(),
      usedCallsigns: new Set(), usedStands: new Set(), usedRegs: new Set(),
      configStartTime: '06:00', configEndTime: '23:00',
    });
    expect(keep).toBe(true);
    expect(flight.CallSign).toBe('CSN3115');
  });

  it('skips an unknown airline', () => {
    const raw = arrival({ airline: { icao: 'XXX', iata: 'X' }, flight: { number: '1' } });
    const res = mapAviationstackFlight(raw, {
      airportIcao: 'ZSJN', vals: baseVals(),
      usedCallsigns: new Set(), usedStands: new Set(), usedRegs: new Set(),
    });
    expect(res.keep).toBe(false);
    expect(res.notes[0].key).toBe('realtime_note_airline_unknown');
  });

  it('skips flights for another airport', () => {
    const raw = arrival({ arrival: { icao: 'KJFK' }, departure: { icao: 'KLAX' } });
    const res = mapAviationstackFlight(raw, {
      airportIcao: 'ZSJN', vals: baseVals(),
      usedCallsigns: new Set(), usedStands: new Set(), usedRegs: new Set(),
    });
    expect(res.keep).toBe(false);
    expect(res.notes[0].key).toBe('realtime_note_not_this_airport');
  });

  it('substitutes a canonical flight number when the real one is invalid', () => {
    const raw = arrival({ flight: { number: '9999' } });
    const { flight, notes } = mapAviationstackFlight(raw, {
      airportIcao: 'ZSJN', vals: baseVals(),
      usedCallsigns: new Set(), usedStands: new Set(), usedRegs: new Set(),
      configStartTime: '06:00', configEndTime: '23:00',
    });
    expect(['CSN3115', 'CSN3116']).toContain(flight.CallSign);
    expect(notes.some(n => n.key === 'realtime_note_flightnum_substituted')).toBe(true);
  });

  it('defaults the aircraft type when the API omits it', () => {
    const raw = arrival({ aircraft: null });
    const { flight, notes } = mapAviationstackFlight(raw, {
      airportIcao: 'ZSJN', vals: baseVals(),
      usedCallsigns: new Set(), usedStands: new Set(), usedRegs: new Set(),
      configStartTime: '06:00', configEndTime: '23:00',
    });
    expect(flight.AircraftType).toBeTruthy();
    expect(notes.some(n => n.key === 'realtime_note_type_defaulted')).toBe(true);
  });

  it('keeps an out-of-window flight at its real time (retimed later by the batch)', () => {
    const res = mapAviationstackFlight(arrival(), {
      airportIcao: 'ZSJN', vals: baseVals(),
      usedCallsigns: new Set(), usedStands: new Set(), usedRegs: new Set(),
      configStartTime: '00:00', configEndTime: '00:30',
    });
    expect(res.keep).toBe(true);
    expect(res.schedMin).not.toBeNull();
    expect(res.flight.LandingTime).toMatch(/^\d{2}:\d{2}:00$/);
  });
});

describe('buildFlightsFromAviationstack', () => {
  it('keeps only the first valid record for a duplicate flight', () => {
    const raw = [arrival(), arrival()]; // identical physical flight twice
    const { candidates, summary } = buildFlightsFromAviationstack(raw, {
      airportIcao: 'ZSJN', vals: baseVals(),
      existingFlights: [], configStartTime: '06:00', configEndTime: '23:00',
    });
    expect(summary.total).toBe(2);
    expect(summary.matched).toBe(1);
    expect(candidates[0].keep).toBe(true);
    expect(candidates[1].keep).toBe(false);
    expect(candidates[1].notes[0].key).toBe('realtime_note_duplicate_flight');
  });

  it('ignores existing flights (import replaces the whole schedule)', () => {
    const { candidates } = buildFlightsFromAviationstack([arrival()], {
      airportIcao: 'ZSJN', vals: baseVals(),
      existingFlights: [{ CallSign: 'CSN3115' }],
      configStartTime: '06:00', configEndTime: '23:00',
    });
    expect(candidates[0].keep).toBe(true);
    expect(candidates[0].flight.CallSign).toBe('CSN3115');
  });

  it('lets a valid later record win over an invalid earlier duplicate', () => {
    const bad = arrival({ airline: { name: 'X', iata: 'X', icao: 'XXX' }, flight: { number: '3115', icao: 'XXX3115' } });
    const good = arrival();
    const { candidates, summary } = buildFlightsFromAviationstack([bad, good], {
      airportIcao: 'ZSJN', vals: baseVals(),
      configStartTime: '06:00', configEndTime: '23:00',
    });
    expect(summary.matched).toBe(1);
    expect(candidates[0].keep).toBe(false);
    expect(candidates[1].keep).toBe(true);
    expect(candidates[1].flight.CallSign).toBe('CSN3115');
  });

  it('drops a later record that reuses a kept callsign', () => {
    const first = arrival();
    const second = arrival({ arrival: { icao: 'ZSJN', timezone: 'Asia/Shanghai', scheduled: '2026-09-19T14:00:00+00:00' } });
    const { candidates, summary } = buildFlightsFromAviationstack([first, second], {
      airportIcao: 'ZSJN', vals: baseVals(),
      configStartTime: '06:00', configEndTime: '23:00',
    });
    expect(summary.matched).toBe(1);
    expect(candidates[1].keep).toBe(false);
    expect(candidates[1].notes[0].key).toBe('realtime_note_duplicate_callsign');
  });

  it('reports per-reason skip counts', () => {
    const other = arrival({ arrival: { icao: 'KJFK' }, departure: { icao: 'KLAX' } });
    const { summary } = buildFlightsFromAviationstack([arrival(), other], {
      airportIcao: 'ZSJN', vals: baseVals(),
      configStartTime: '06:00', configEndTime: '23:00',
    });
    expect(summary.reasons.realtime_note_not_this_airport).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it('retimes out-of-window flights into the level window', () => {
    // Real local times 12:05 / 14:05; window is a 45-min slice that excludes both.
    const a = arrival();
    const b = arrival({
      airline: { name: 'Air China', iata: 'CA', icao: 'CCA' },
      flight: { number: '1234', icao: 'CCA1234', iata: 'CA1234', codeshared: null },
      arrival: { icao: 'ZSJN', timezone: 'Asia/Shanghai', scheduled: '2026-09-19T14:05:00+00:00' },
    });
    const { candidates, summary } = buildFlightsFromAviationstack([a, b], {
      airportIcao: 'ZSJN', vals: baseVals(),
      configStartTime: '10:15', configEndTime: '11:00',
    });
    expect(summary.matched).toBe(2);
    expect(summary.retimed).toBe(true);
    for (const c of candidates.filter(c => c.keep)) {
      const t = c.flight.LandingTime;
      expect(t >= '10:15:00' && t <= '11:00:00').toBe(true);
    }
  });

  it('leaves real times untouched when the whole batch already fits', () => {
    const a = arrival({ arrival: { icao: 'ZSJN', timezone: 'Asia/Shanghai', scheduled: '2026-09-19T12:05:00+00:00' } });
    const { summary } = buildFlightsFromAviationstack([a], {
      airportIcao: 'ZSJN', vals: baseVals(),
      configStartTime: '06:00', configEndTime: '23:00',
    });
    expect(summary.retimed).toBe(false);
  });
});
