import { describe, it, expect } from 'vitest';
import { validateCallsigns, detectStandConflicts } from '../../src/utils/validators';

describe('validateCallsigns', () => {
  it('returns empty array when no duplicates', () => {
    const flights = [
      { CallSign: 'CES1234' },
      { CallSign: 'CAL5678' },
      { CallSign: 'CSN9012' },
    ];
    expect(validateCallsigns(flights)).toEqual([]);
  });

  it('returns duplicate callsigns', () => {
    const flights = [
      { CallSign: 'CES1234' },
      { CallSign: 'CES1234' },
      { CallSign: 'CAL5678' },
      { CallSign: 'CAL5678' },
    ];
    const dupes = validateCallsigns(flights);
    expect(dupes).toHaveLength(2);
    expect(dupes).toContain('CES1234');
    expect(dupes).toContain('CAL5678');
  });

  it('ignores empty callsigns', () => {
    const flights = [
      { CallSign: '' },
      { CallSign: '  ' },
      { CallSign: 'CES1234' },
    ];
    expect(validateCallsigns(flights)).toEqual([]);
  });

  it('returns each duplicate only once', () => {
    const flights = [
      { CallSign: 'CES1234' },
      { CallSign: 'CES1234' },
      { CallSign: 'CES1234' },
    ];
    const dupes = validateCallsigns(flights);
    expect(dupes).toEqual(['CES1234']);
  });

  it('handles empty flight array', () => {
    expect(validateCallsigns([])).toEqual([]);
  });
});

describe('detectStandConflicts', () => {
  it('returns empty array for empty flight list', () => {
    expect(detectStandConflicts([])).toEqual([]);
  });

  it('returns empty array when no flights have Stand', () => {
    const flights = [
      { CallSign: 'CES1234', LandingTime: '10:00', InBlockTime: '10:20' },
      { CallSign: 'CAL5678', LandingTime: '10:30', InBlockTime: '10:50' },
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('returns empty array for single flight with Stand', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:20' },
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('returns empty array when flights on different stands overlap', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:20' },
      { CallSign: 'CAL5678', Stand: 'A02', LandingTime: '10:05', InBlockTime: '10:25' },
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('returns empty array for non-overlapping times on same stand', () => {
    // Arrival parks at 10:20, departure leaves at 10:00 — no overlap
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:20' },
      { CallSign: 'CAL5678', Stand: 'A01', OffBlockTime: '09:55', TakeoffTime: '10:10' },
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('allows overlapping arrivals on same stand (game does not enforce arr/arr)', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01', LandingTime: '10:15', InBlockTime: '10:45' },
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('detects two overlapping departures on same stand', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', OffBlockTime: '10:00', TakeoffTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01', OffBlockTime: '10:15', TakeoffTime: '10:45' },
    ];
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('CES1234');
    expect(issues[0]).toContain('CAL5678');
  });

  it('allows arrival after departure on same stand when offblock < landing', () => {
    // Game rule: departure offblock must be strictly before arrival landing.
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01', OffBlockTime: '09:59', TakeoffTime: '10:30' },
    ];
    // departure vacates at 09:59, arrival lands at 10:00 — no conflict
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('detects arrival + departure conflict on same stand when windows truly overlap', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01', OffBlockTime: '10:35', TakeoffTime: '11:05' },
    ];
    // departure vacates stand at 10:35 but was there since ~10:15,
    // arrival occupies [10:30, 10:50) — windows overlap
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('CES1234');
    expect(issues[0]).toContain('CAL5678');
  });

  it('flags departure vacating at same minute as arrival landing (= is a conflict)', () => {
    // Game rule: offblock must be STRICTLY before landing.  = is not allowed.
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:30', InBlockTime: '11:00' },
      { CallSign: 'CAL5678', Stand: 'A01', OffBlockTime: '10:30', TakeoffTime: '11:00' },
    ];
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('CAL5678');
    expect(issues[0]).toContain('CES1234');
  });

  it('allows departure strictly before arrival landing', () => {
    // Game rule: offblock < landing is OK.
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:30', InBlockTime: '11:00' },
      { CallSign: 'CAL5678', Stand: 'A01', OffBlockTime: '10:29', TakeoffTime: '11:00' },
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('uses 20-minute default for start when departure has OffBlockTime only', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', OffBlockTime: '10:00', TakeoffTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01', OffBlockTime: '09:50' }, // no Takeoff — start defaults to 09:30
    ];
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(1);
  });

  it('allows arrivals on same stand even when landing times overlap', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01', LandingTime: '10:25' },
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('skips flights with no LandingTime or OffBlockTime', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01' }, // no time data
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('allows three arrivals on same stand (game does not enforce arr/arr)', () => {
    const flights = [
      { CallSign: 'AAA1111', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'BBB2222', Stand: 'A01', LandingTime: '10:05', InBlockTime: '10:35' },
      { CallSign: 'CCC3333', Stand: 'A01', LandingTime: '10:10', InBlockTime: '10:40' },
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('dep/dep conflict message contains both callsigns and stand name', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'B05', OffBlockTime: '08:00', TakeoffTime: '08:30' },
      { CallSign: 'CAL5678', Stand: 'B05', OffBlockTime: '09:00', TakeoffTime: '09:30' },
    ];
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('CES1234');
    expect(issues[0]).toContain('CAL5678');
    expect(issues[0]).toContain('B05');
  });

  it('dep/arr conflict message shows game-rule violation with formatted times', () => {
    const flights = [
      { CallSign: 'CDG5166', Stand: '26', OffBlockTime: '07:58:00', TakeoffTime: '08:15' },
      { CallSign: 'CCA2761', Stand: '26', LandingTime: '07:50:00', InBlockTime: '07:55' },
    ];
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('CDG5166');
    expect(issues[0]).toContain('CCA2761');
    expect(issues[0]).toContain('26');
    // Times are normalised to HH:MM:00
    expect(issues[0]).toContain('07:58:00');
    expect(issues[0]).toContain('07:50:00');
    // Should NOT have extra :00 appended
    expect(issues[0]).not.toMatch(/07:58:00:00/);
    expect(issues[0]).not.toMatch(/07:50:00:00/);
  });
});
