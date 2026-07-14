import { describe, it, expect } from 'vitest';
import {
  randomPick,
  pickRandomAirlineCode,
  pickRandomFlightNumber,
  pickRandomUnusedStand,
  pickFirstFlightNumber,
  pickDefaultAirlineCode,
  createDefaultFlight,
  createArrivalFlight,
  createDepartureFlight,
  makeEmptyFlight,
  computeDefaultBaseMin,
  minutesToTimeString,
} from '../../src/store/flightDefaults';

// ─── randomPick ──────────────────────────────────────────────────

describe('randomPick', () => {
  it('returns null for empty array', () => {
    expect(randomPick([])).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(randomPick(undefined)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(randomPick(null)).toBeNull();
  });

  it('returns the only element for single-item array', () => {
    expect(randomPick(['CCA'])).toBe('CCA');
  });

  it('returns an element from multi-item array', () => {
    const arr = ['CCA', 'CES', 'CSN'];
    const result = randomPick(arr);
    expect(arr).toContain(result);
  });

  it('eventually returns both elements from a 2-item array', () => {
    const arr = ['A', 'B'];
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      seen.add(randomPick(arr));
      if (seen.size === 2) break;
    }
    expect(seen.has('A')).toBe(true);
    expect(seen.has('B')).toBe(true);
  });
});

// ─── pickRandomAirlineCode ───────────────────────────────────────

describe('pickRandomAirlineCode', () => {
  it('picks from audioData.allAirlines when available', () => {
    const audioData = { allAirlines: ['CCA', 'CES'] };
    const values = {};
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      seen.add(pickRandomAirlineCode(audioData, values));
      if (seen.size === 2) break;
    }
    expect(seen.has('CCA')).toBe(true);
    expect(seen.has('CES')).toBe(true);
  });

  it('falls back to values.AirlineCode when no audio data', () => {
    const audioData = { allAirlines: [] };
    const values = { AirlineCode: ['CSN', 'CAL'] };
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      seen.add(pickRandomAirlineCode(audioData, values));
      if (seen.size === 2) break;
    }
    expect(seen.has('CSN')).toBe(true);
    expect(seen.has('CAL')).toBe(true);
  });

  it('falls back to values.AirlineCode when audioData has no allAirlines', () => {
    const audioData = { byAirline: {}, allCallsigns: [] };
    const values = { AirlineCode: ['CCA'] };
    expect(pickRandomAirlineCode(audioData, values)).toBe('CCA');
  });

  it('falls back to values.AirlineName (converted) when no AirlineCode', () => {
    const audioData = { allAirlines: [] };
    const values = { AirlineName: ['China Eastern', 'Air China'] };
    // 'China Eastern' → 'CES', 'Air China' → 'CCA'
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      seen.add(pickRandomAirlineCode(audioData, values));
      if (seen.size === 2) break;
    }
    expect(seen.has('CES')).toBe(true);
    expect(seen.has('CCA')).toBe(true);
  });

  it('returns "NEW" when all sources are empty', () => {
    const audioData = { allAirlines: [] };
    const values = {};
    expect(pickRandomAirlineCode(audioData, values)).toBe('NEW');
  });

  it('returns "NEW" when all sources are undefined', () => {
    const audioData = {};
    const values = {};
    expect(pickRandomAirlineCode(audioData, values)).toBe('NEW');
  });

  it('does NOT return "NEW" when values.AirlineCode is populated (the bug fix)', () => {
    // This is the key regression test: previously pickDefaultAirlineCode
    // would return 'NEW' when audioData was empty and AirlineName was empty,
    // even though AirlineCode (the dropdown source) was populated.
    const audioData = { allAirlines: [] };
    const values = { AirlineCode: ['CCA', 'CES', 'CSN'] };
    const result = pickRandomAirlineCode(audioData, values);
    expect(result).not.toBe('NEW');
    expect(['CCA', 'CES', 'CSN']).toContain(result);
  });

  it('prefers audioData.allAirlines over values.AirlineCode', () => {
    const audioData = { allAirlines: ['UAL'] };
    const values = { AirlineCode: ['CCA', 'CES'] };
    // Should always pick from audio data
    for (let i = 0; i < 10; i++) {
      expect(pickRandomAirlineCode(audioData, values)).toBe('UAL');
    }
  });
});

// ─── pickRandomFlightNumber ──────────────────────────────────────

describe('pickRandomFlightNumber', () => {
  it('picks random from _flightNums for the given airline', () => {
    const airportValues = { _flightNums: { CCA: ['1234', '5678', '9012'] } };
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      seen.add(pickRandomFlightNumber(airportValues, 'CCA'));
      if (seen.size === 3) break;
    }
    expect(seen.has('1234')).toBe(true);
    expect(seen.has('5678')).toBe(true);
    expect(seen.has('9012')).toBe(true);
  });

  it('returns "1" when no flight numbers exist for airline', () => {
    const airportValues = { _flightNums: {} };
    expect(pickRandomFlightNumber(airportValues, 'CCA')).toBe('1');
  });

  it('returns "1" when _flightNums is undefined', () => {
    expect(pickRandomFlightNumber(undefined, 'CCA')).toBe('1');
  });

  it('returns "1" when airportValues is null', () => {
    expect(pickRandomFlightNumber(null, 'CCA')).toBe('1');
  });

  it('returns "1" when airline has empty array', () => {
    const airportValues = { _flightNums: { CCA: [] } };
    expect(pickRandomFlightNumber(airportValues, 'CCA')).toBe('1');
  });
});

// ─── pickFirstFlightNumber (existing, keep working) ─────────────

describe('pickFirstFlightNumber', () => {
  it('picks first from _flightNums', () => {
    const airportValues = { _flightNums: { CCA: ['9999', '1234'] } };
    expect(pickFirstFlightNumber(airportValues, 'CCA')).toBe('9999');
  });

  it('returns "1" as fallback', () => {
    expect(pickFirstFlightNumber({}, 'CCA')).toBe('1');
  });
});

// ─── pickDefaultAirlineCode (existing, keep working) ────────────

describe('pickDefaultAirlineCode', () => {
  it('returns first from audioData.allAirlines', () => {
    const audioData = { allAirlines: ['CCA', 'CES'] };
    expect(pickDefaultAirlineCode(audioData, {})).toBe('CCA');
  });

  it('returns first from AirlineName converted', () => {
    const audioData = { allAirlines: [] };
    const values = { AirlineName: ['China Eastern', 'Air China'] };
    // First AirlineName is 'China Eastern' → 'CES'
    expect(pickDefaultAirlineCode(audioData, values)).toBe('CES');
  });

  it('returns "NEW" when nothing available', () => {
    expect(pickDefaultAirlineCode({}, {})).toBe('NEW');
  });
});

// ─── pickRandomUnusedStand ──────────────────────────────────────

describe('pickRandomUnusedStand', () => {
  it('returns a stand not in existing flights', () => {
    const values = { Stand: ['G1', 'G2', 'G3'] };
    const existingFlights = [
      { Stand: 'G1' },
      { Stand: 'G2' },
    ];
    // G3 is the only unused stand
    for (let i = 0; i < 10; i++) {
      expect(pickRandomUnusedStand(values, existingFlights)).toBe('G3');
    }
  });

  it('returns a stand when all stands are taken (fallback to random reuse)', () => {
    const values = { Stand: ['G1', 'G2'] };
    const existingFlights = [
      { Stand: 'G1' },
      { Stand: 'G2' },
    ];
    const result = pickRandomUnusedStand(values, existingFlights);
    expect(['G1', 'G2']).toContain(result);
  });

  it('returns empty string when no stands in values', () => {
    const values = {};
    const existingFlights = [];
    expect(pickRandomUnusedStand(values, existingFlights)).toBe('');
  });

  it('returns empty string when Stand array is empty', () => {
    const values = { Stand: [] };
    const existingFlights = [];
    expect(pickRandomUnusedStand(values, existingFlights)).toBe('');
  });

  it('handles flights without Stand field', () => {
    const values = { Stand: ['G1', 'G2'] };
    const existingFlights = [
      { CallSign: 'CES1234' }, // no Stand
      { Stand: 'G1' },
    ];
    const result = pickRandomUnusedStand(values, existingFlights);
    expect(result).toBe('G2');
  });

  it('handles empty existingFlights', () => {
    const values = { Stand: ['G1', 'G2', 'G3'] };
    const result = pickRandomUnusedStand(values, []);
    expect(['G1', 'G2', 'G3']).toContain(result);
  });

  it('handles undefined existingFlights', () => {
    const values = { Stand: ['G1'] };
    expect(pickRandomUnusedStand(values, undefined)).toBe('G1');
  });

  it('eventually returns both unused stands when multiple are free', () => {
    const values = { Stand: ['G1', 'G2', 'G3', 'G4'] };
    const existingFlights = [
      { Stand: 'G1' },
      { Stand: 'G2' },
    ];
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      seen.add(pickRandomUnusedStand(values, existingFlights));
      if (seen.size === 2) break;
    }
    expect(seen.has('G3')).toBe(true);
    expect(seen.has('G4')).toBe(true);
  });
});

// ─── makeEmptyFlight ─────────────────────────────────────────────

describe('makeEmptyFlight', () => {
  it('returns an object with all 15 fields as empty strings', () => {
    const flight = makeEmptyFlight();
    expect(flight.CallSign).toBe('');
    expect(flight.DepartureAirport).toBe('');
    expect(flight.ArrivalAirport).toBe('');
    expect(flight.Stand).toBe('');
    expect(flight.Runway).toBe('');
    expect(flight.OffBlockTime).toBe('');
    expect(flight.TakeoffTime).toBe('');
    expect(flight.LandingTime).toBe('');
    expect(flight.InBlockTime).toBe('');
    expect(flight.AirlineName).toBe('');
    expect(flight.AircraftType).toBe('');
    expect(flight.Airway).toBe('');
    expect(flight.Registration).toBe('');
    expect(flight.Voice).toBe('');
    expect(flight.Language).toBe('');
  });
});

// ─── computeDefaultBaseMin ───────────────────────────────────────

describe('computeDefaultBaseMin', () => {
  it('returns FALLBACK_BASE_MINUTES when configEndTime is null', () => {
    // FALLBACK_BASE_MINUTES = 360 (06:00)
    expect(computeDefaultBaseMin(null)).toBe(360);
  });

  it('computes from configEndTime minus DEFAULT_TIME_OFFSET_MIN', () => {
    // DEFAULT_TIME_OFFSET_MIN = 10
    // 18:00 = 1080 min, minus 10 = 1070
    expect(computeDefaultBaseMin('18:00')).toBe(1070);
  });

  it('clamps to 0 when result would be negative', () => {
    // 00:10 = 10 min, minus 30 = -20 → clamp to 0
    expect(computeDefaultBaseMin('00:10')).toBe(0);
  });
});

// ─── minutesToTimeString ────────────────────────────────────────

describe('minutesToTimeString', () => {
  it('formats minutes to HH:MM:00', () => {
    expect(minutesToTimeString(90)).toBe('01:30:00');
    expect(minutesToTimeString(0)).toBe('00:00:00');
    expect(minutesToTimeString(1050)).toBe('17:30:00');
  });
});

// ─── createDefaultFlight ─────────────────────────────────────────

describe('createDefaultFlight', () => {
  function makeVals(overrides = {}) {
    return {
      AircraftType: ['B738', 'A320'],
      AirlineName: ['China Eastern'],
      Stand: ['G1', 'G2', 'G3'],
      Runway: ['01'],
      Airway: ['STAR1'],
      Registration: ['B-1234'],
      Voice: ['M'],
      ...overrides,
    };
  }

  function makeAirportValues(code, overrides = {}) {
    return {
      _flightNums: { [code]: ['1234', '5678'] },
      _compat: {
        airlineToAircraft: { [code]: ['B738', 'A320'] },
      },
      _registrationMap: {
        [`${code}|B738`]: ['B-1111', 'B-2222'],
        [`${code}|A320`]: ['B-3333', 'B-4444'],
      },
      ...overrides,
    };
  }

  it('builds CallSign from 3-letter airline code + flight number (not "NEW")', () => {
    const audioData = { allAirlines: ['CCA'] };
    const vals = makeVals({ AirlineCode: ['CCA'] });
    const apv = makeAirportValues('CCA');
    const flight = createDefaultFlight('arrival', vals, audioData, 'ZSJN', apv, []);

    expect(flight.CallSign).toMatch(/^CCA\d/);
    expect(flight.CallSign.substring(0, 3)).not.toBe('NEW');
  });

  it('sets ArrivalAirport for arrival type', () => {
    const audioData = { allAirlines: ['CCA'] };
    const vals = makeVals({ AirlineCode: ['CCA'] });
    const apv = makeAirportValues('CCA');
    const flight = createDefaultFlight('arrival', vals, audioData, 'ZSJN', apv, []);

    expect(flight.ArrivalAirport).toBe('ZSJN');
    expect(flight.DepartureAirport).toBe('');
  });

  it('sets DepartureAirport for departure type', () => {
    const audioData = { allAirlines: ['CCA'] };
    const vals = makeVals({ AirlineCode: ['CCA'] });
    const apv = makeAirportValues('CCA');
    const flight = createDefaultFlight('departure', vals, audioData, 'ZSJN', apv, []);

    expect(flight.DepartureAirport).toBe('ZSJN');
    expect(flight.ArrivalAirport).toBe('');
  });

  it('picks AircraftType valid for the chosen airline from _compat', () => {
    const audioData = { allAirlines: ['CCA'] };
    const vals = makeVals({ AirlineCode: ['CCA'] });
    const apv = makeAirportValues('CCA');
    // Run multiple times since airline is random (and aircraft cascades from it)
    for (let i = 0; i < 20; i++) {
      const flight = createDefaultFlight('arrival', vals, audioData, 'ZSJN', apv, []);
      expect(['B738', 'A320']).toContain(flight.AircraftType);
    }
  });

  it('picks Registration valid for the chosen airline + aircraft combo', () => {
    const audioData = { allAirlines: ['CCA'] };
    const vals = makeVals({ AirlineCode: ['CCA'] });
    const apv = makeAirportValues('CCA');
    for (let i = 0; i < 20; i++) {
      const flight = createDefaultFlight('arrival', vals, audioData, 'ZSJN', apv, []);
      // Registration should be one of the valid ones for CCA + that aircraft
      const validRegsForType = apv._registrationMap[`CCA|${flight.AircraftType}`] || [];
      expect(validRegsForType).toContain(flight.Registration);
    }
  });

  it('picks a Stand not used by existing flights', () => {
    const audioData = { allAirlines: ['CCA'] };
    const vals = makeVals({ AirlineCode: ['CCA'], Stand: ['G1', 'G2', 'G3'] });
    const apv = makeAirportValues('CCA');
    const existingFlights = [
      { Stand: 'G1' },
      { Stand: 'G2' },
    ];
    // Only G3 is free
    for (let i = 0; i < 10; i++) {
      const flight = createDefaultFlight('arrival', vals, audioData, 'ZSJN', apv, existingFlights);
      expect(flight.Stand).toBe('G3');
    }
  });

  it('falls back gracefully when airport has no data', () => {
    const audioData = {};
    const vals = {};
    const apv = {};
    const flight = createDefaultFlight('arrival', vals, audioData, 'ZSJN', apv, []);

    expect(flight.Language).toBe('en');
    expect(flight.ArrivalAirport).toBe('ZSJN');
    // With no data, airline will be 'NEW'
    expect(flight.CallSign.substring(0, 3)).toBe('NEW');
    expect(flight.CallSign.substring(3)).toBe('1');
  });

  it('sets Language to "en"', () => {
    const audioData = { allAirlines: ['CCA'] };
    const vals = makeVals({ AirlineCode: ['CCA'] });
    const apv = makeAirportValues('CCA');
    const flight = createDefaultFlight('arrival', vals, audioData, 'ZSJN', apv, []);
    expect(flight.Language).toBe('en');
  });

  it('uses values.AircraftType fallback when _compat has no airline', () => {
    const audioData = { allAirlines: ['CCA'] };
    const vals = makeVals({ AirlineCode: ['CCA'], AircraftType: ['B77W'] });
    const apv = {};  // no _compat
    for (let i = 0; i < 10; i++) {
      const flight = createDefaultFlight('arrival', vals, audioData, 'ZSJN', apv, []);
      expect(flight.AircraftType).toBe('B77W');
    }
  });

  it('uses values.Registration fallback when _registrationMap has no entry', () => {
    const audioData = { allAirlines: ['CCA'] };
    const vals = makeVals({ AirlineCode: ['CCA'], Registration: ['B-9999'] });
    const apv = {};  // no _registrationMap
    for (let i = 0; i < 10; i++) {
      const flight = createDefaultFlight('arrival', vals, audioData, 'ZSJN', apv, []);
      expect(flight.Registration).toBe('B-9999');
    }
  });
});

// ─── createArrivalFlight ─────────────────────────────────────────

describe('createArrivalFlight', () => {
  it('sets LandingTime and InBlockTime', () => {
    const vals = {};
    const audioData = {};
    const apv = {};
    const flight = createArrivalFlight('18:00', vals, audioData, 'ZSJN', apv, []);

    expect(flight.LandingTime).toMatch(/^\d{2}:\d{2}:00$/);
    expect(flight.InBlockTime).toMatch(/^\d{2}:\d{2}:00$/);
  });

  it('InBlockTime is DEFAULT_TAXI_MINUTES after LandingTime', () => {
    const vals = {};
    const audioData = {};
    const apv = {};
    const flight = createArrivalFlight('18:00', vals, audioData, 'ZSJN', apv, []);

    const landParts = flight.LandingTime.split(':');
    const inbParts = flight.InBlockTime.split(':');
    const landMin = parseInt(landParts[0]) * 60 + parseInt(landParts[1]);
    const inbMin = parseInt(inbParts[0]) * 60 + parseInt(inbParts[1]);
    // DEFAULT_TAXI_MINUTES = 5
    expect(inbMin - landMin).toBe(5);
  });

  it('does NOT set OffBlockTime or TakeoffTime', () => {
    const vals = {};
    const audioData = {};
    const apv = {};
    const flight = createArrivalFlight('18:00', vals, audioData, 'ZSJN', apv, []);

    expect(flight.OffBlockTime).toBe('');
    expect(flight.TakeoffTime).toBe('');
  });

  it('sets ArrivalAirport to current airport', () => {
    const vals = {};
    const audioData = {};
    const apv = {};
    const flight = createArrivalFlight('18:00', vals, audioData, 'KJFK', apv, []);

    expect(flight.ArrivalAirport).toBe('KJFK');
  });

  it('forwards existingFlights to createDefaultFlight (stand conflict avoidance)', () => {
    const vals = { Stand: ['G1', 'G2'], AirlineCode: ['CCA'] };
    const audioData = { allAirlines: ['CCA'] };
    const apv = { _flightNums: { CCA: ['1234'] } };
    const existing = [{ Stand: 'G1' }];

    // G1 is taken, so new flight should get G2
    for (let i = 0; i < 10; i++) {
      const flight = createArrivalFlight('18:00', vals, audioData, 'ZSJN', apv, existing);
      expect(flight.Stand).toBe('G2');
    }
  });
});

// ─── createDepartureFlight ───────────────────────────────────────

describe('createDepartureFlight', () => {
  it('sets OffBlockTime and TakeoffTime', () => {
    const vals = {};
    const audioData = {};
    const apv = {};
    const flight = createDepartureFlight('06:00', vals, audioData, 'ZSJN', apv, []);

    expect(flight.OffBlockTime).toMatch(/^\d{2}:\d{2}:00$/);
    expect(flight.TakeoffTime).toMatch(/^\d{2}:\d{2}:00$/);
  });

  it('TakeoffTime is DEFAULT_TAXI_MINUTES after OffBlockTime', () => {
    const vals = {};
    const audioData = {};
    const apv = {};
    const flight = createDepartureFlight('06:00', vals, audioData, 'ZSJN', apv, []);

    const offParts = flight.OffBlockTime.split(':');
    const takeParts = flight.TakeoffTime.split(':');
    const offMin = parseInt(offParts[0]) * 60 + parseInt(offParts[1]);
    const takeMin = parseInt(takeParts[0]) * 60 + parseInt(takeParts[1]);
    expect(takeMin - offMin).toBe(5);
  });

  it('does NOT set LandingTime or InBlockTime', () => {
    const vals = {};
    const audioData = {};
    const apv = {};
    const flight = createDepartureFlight('06:00', vals, audioData, 'ZSJN', apv, []);

    expect(flight.LandingTime).toBe('');
    expect(flight.InBlockTime).toBe('');
  });

  it('sets DepartureAirport to current airport', () => {
    const vals = {};
    const audioData = {};
    const apv = {};
    const flight = createDepartureFlight('06:00', vals, audioData, 'KJFK', apv, []);

    expect(flight.DepartureAirport).toBe('KJFK');
  });
});
