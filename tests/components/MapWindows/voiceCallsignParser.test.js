import { describe, it, expect } from 'vitest';
import { detectLanguage, parseCallsign } from '../../../src/components/MapWindows/voiceCallsignParser';

// ─── detectLanguage ────────────────────────────────────────────────────

describe('detectLanguage', () => {
  it('returns en for English text', () => {
    expect(detectLanguage('united eleven eleven cleared to land')).toBe('en');
  });

  it('returns en for empty string', () => {
    expect(detectLanguage('')).toBe('en');
  });

  it('returns zh for Chinese text', () => {
    expect(detectLanguage('东方五八八八可以起飞')).toBe('zh');
  });

  it('returns zh for mixed text with any CJK', () => {
    expect(detectLanguage('CES五八八八 cleared to land')).toBe('zh');
  });
});

// ─── parseCallsign ─────────────────────────────────────────────────────

// Mock aircraft list matching what we'd see from UDP
function makeAircraft(callSign) {
  return {
    callSign,
    controlSeat: 1,
    flightDirection: 0,
    position: { x: 0, y: 0, z: 0 },
    runway: '13L/31R',
    aircraftType: 'B738',
    stand: '12',
    route: '',
    star: '',
    airSpeedKnot: 0,
    telemetryStatus: 1,
    seatSequence: 1,
    noseDirection: { x: 0, y: 0, z: 0 },
    taxiSpeed: 0,
  };
}

describe('parseCallsign', () => {
  const aircraftList = [
    makeAircraft('UAL1111'),
    makeAircraft('CES5888'),
    makeAircraft('CCA1234'),
    makeAircraft('DAL456'),
    makeAircraft('KLM631'),
    makeAircraft('BAW5224'),
    makeAircraft('AFR3661'),
    makeAircraft('AAL683'),
  ];

  it('parses "united eleven eleven" → UAL1111', () => {
    const r = parseCallsign('united eleven eleven cleared to land', 'en', aircraftList);
    expect(r).not.toBeNull();
    expect(r.callsign).toBe('UAL1111');
    expect(r.aircraft.callSign).toBe('UAL1111');
    expect(r.remainingText).toBe('cleared to land');
    expect(r.airlineName).toBe('united');
  });

  it('parses "united airlines one one one one" → UAL1111', () => {
    const r = parseCallsign('united airlines one one one one cleared to land', 'en', aircraftList);
    expect(r).not.toBeNull();
    expect(r.callsign).toBe('UAL1111');
    expect(r.remainingText).toBe('cleared to land');
  });

  it('parses digit-by-digit "UAL one two three four" → UAL is a 3-letter code', () => {
    const acList = [makeAircraft('UAL1234')];
    const r = parseCallsign('ual one two three four', 'en', acList);
    // "ual" matches the 3-letter code entry (lowercase lookup), remaining="one two three four"
    expect(r).not.toBeNull();
    expect(r.callsign).toBe('UAL1234');
  });

  it('parses "delta four five six" → DAL456', () => {
    const r = parseCallsign('delta four five six contact ground', 'en', aircraftList);
    expect(r).not.toBeNull();
    expect(r.callsign).toBe('DAL456');
    expect(r.remainingText).toBe('contact ground');
  });

  it('parses "KLM six three one" → KLM631', () => {
    const r = parseCallsign('klm six three one', 'en', aircraftList);
    expect(r).not.toBeNull();
    expect(r.callsign).toBe('KLM631');
  });

  it('matches longest airline name first ("air china" over "air")', () => {
    // "air" alone should not win over "air china"
    const r = parseCallsign('air china one two three four cleared to land', 'en', aircraftList);
    expect(r).not.toBeNull();
    expect(r.callsign).toBe('CCA1234');
  });

  it('parses teen numbers correctly', () => {
    const acList = [makeAircraft('UAL1212')];
    const r = parseCallsign('united twelve twelve', 'en', acList);
    expect(r).not.toBeNull();
    expect(r.callsign).toBe('UAL1212');
  });

  it('returns null when no aircraft matches', () => {
    const r = parseCallsign('united nine nine nine nine', 'en', aircraftList);
    // UAL9999 is not in the list
    expect(r).toBeNull();
  });

  it('returns null when no airline recognized', () => {
    const r = parseCallsign('cleared to land', 'en', aircraftList);
    expect(r).toBeNull();
  });

  it('returns null for empty transcript', () => {
    const r = parseCallsign('', 'en', aircraftList);
    expect(r).toBeNull();
  });

  it('returns null for empty aircraft list', () => {
    const r = parseCallsign('united eleven eleven', 'en', []);
    expect(r).toBeNull();
  });

  // ─── Chinese ─────────────────────────────────────────────────────

  it('parses Chinese airline name + digits (东方五八八八)', () => {
    const r = parseCallsign('东方五八八八可以起飞', 'zh', aircraftList);
    expect(r).not.toBeNull();
    expect(r.callsign).toBe('CES5888');
    expect(r.remainingText).toBe('可以起飞');
  });

  it('parses Chinese airline with digit-by-digit (中国东方航空五八八八)', () => {
    const r = parseCallsign('中国东方航空五八八八', 'zh', aircraftList);
    expect(r).not.toBeNull();
    expect(r.callsign).toBe('CES5888');
  });

  it('parses Chinese short form (国航一二三四)', () => {
    const r = parseCallsign('国航一二三四', 'zh', aircraftList);
    expect(r).not.toBeNull();
    expect(r.callsign).toBe('CCA1234');
  });

  it('handles callsign without following command', () => {
    const r = parseCallsign('united eleven eleven', 'en', aircraftList);
    expect(r).not.toBeNull();
    expect(r.callsign).toBe('UAL1111');
    expect(r.remainingText).toBe('');
  });
});
