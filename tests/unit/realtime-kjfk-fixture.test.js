/**
 * Mock test driven by a saved aviationstack KJFK response.
 *
 * The fixture (tests/fixtures/aviationstack-kjfk.json) was captured once from
 * the real free-plan API and is replayed here — no network access.
 *
 * It reproduces the reported case: KJFK level window 10:15–11:00, where the
 * real local flight times are spread across the day, so the importer must
 * retime them into the window instead of dropping everything.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildFlightsFromAviationstack, isoToLocalHHMM,
} from '../../src/utils/realtime/aviationstack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/aviationstack-kjfk.json'), 'utf8')
);

/** Airline code the mapper would derive for a record (permissive, so the pool matches). */
function derivedCode(r) {
  const icao = String(r.airline?.icao || '').toUpperCase();
  if (/^[A-Z]{3}$/.test(icao)) return icao;
  const m = String(r.flight?.icao || '').toUpperCase().match(/^([A-Z]{3})\d/);
  if (m) return m[1];
  return icao;
}

/**
 * A permissive airport value pool so the test isolates TIME handling: every
 * airline/type is "known", runways/STARs/stands exist.
 */
function permissiveVals(records) {
  const airlineCodes = [...new Set(records.map(derivedCode).filter(Boolean))];
  const designators = [...new Set(records.map(r => r.aircraft?.icao || r.aircraft?.iata).filter(Boolean))];
  const designatorToType = {};
  for (const d of designators) designatorToType[d] = d;
  const runways = ['04L', '04R', '13L', '13R', '22L', '22R', '31L', '31R'];
  const runwayStarMap = {};
  for (const r of runways) runwayStarMap[r] = ['STARA'];
  return {
    AirlineCode: airlineCodes,
    AircraftType: designators,
    Registration: [],
    Stand: Array.from({ length: 40 }, (_, i) => 'S' + (i + 1)),
    Runway: runways,
    Voice: ['pilot-en'],
    Language: ['en'],
    _designatorToType: designatorToType,
    _compat: { airlineToAircraft: Object.fromEntries(airlineCodes.map(c => [c, designators])) },
    _flightNums: {},
    _registrationMap: {},
    _runwayStarMap: runwayStarMap,
    _starRunwayMap: { STARA: runways },
    _voiceLanguages: { 'pilot-en': 'en' },
  };
}

const allRecords = [...fixture.arrivals, ...fixture.departures];

function importKjfk(start, end) {
  return buildFlightsFromAviationstack(allRecords, {
    airportIcao: 'KJFK',
    vals: permissiveVals(allRecords),
    configStartTime: start,
    configEndTime: end,
  });
}

describe('aviationstack KJFK fixture', () => {
  it('loaded 100 arrivals + 100 departures', () => {
    expect(fixture.arrivals).toHaveLength(100);
    expect(fixture.departures).toHaveLength(100);
  });

  it('reads local wall-clock times (not UTC-converted)', () => {
    // ETD1 AUH->JFK: API scheduled 2026-09-20T08:35:00+00:00 is the local JFK
    // arrival time. If this regresses to a UTC->America/New_York conversion it
    // would read 04:35.
    const etd1 = fixture.arrivals.find(r => r.flight?.icao === 'ETD1');
    expect(etd1).toBeTruthy();
    expect(isoToLocalHHMM(etd1.arrival.scheduled, etd1.arrival.timezone)).toBe('08:35');
  });

  it('retimes the whole batch into the 10:15–11:00 window (no time drops)', () => {
    const { candidates, summary } = importKjfk('10:15', '11:00');
    expect(summary.total).toBe(200);
    expect(summary.matched).toBeGreaterThan(0);
    expect(summary.retimed).toBe(true);
    expect(summary.reasons.realtime_note_time_out_of_range).toBeUndefined();

    const kept = candidates.filter(c => c.keep && c.flight);
    expect(kept.length).toBe(summary.matched);
    for (const c of kept) {
      const t = c.flight.isDeparture ? c.flight.OffBlockTime : c.flight.LandingTime;
      expect(t >= '10:15:00' && t <= '11:00:00', `${c.flight.CallSign} time ${t}`).toBe(true);
    }
  });

  it('leaves times alone when they already fit the window', () => {
    const { summary } = importKjfk('00:00', '23:59');
    expect(summary.retimed).toBe(false);
  });
});
