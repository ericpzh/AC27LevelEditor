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
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:20' },
      { CallSign: 'CAL5678', Stand: 'A01', LandingTime: '10:20', InBlockTime: '10:40' },
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('detects two overlapping arrivals on same stand', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01', LandingTime: '10:15', InBlockTime: '10:45' },
    ];
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('CES1234');
    expect(issues[0]).toContain('CAL5678');
    expect(issues[0]).toContain('A01');
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

  it('detects arrival + departure overlapping on same stand', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01', OffBlockTime: '10:15', TakeoffTime: '10:45' },
    ];
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('CES1234');
    expect(issues[0]).toContain('CAL5678');
  });

  it('does not flag adjacent windows (one ends when next starts)', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01', LandingTime: '10:30', InBlockTime: '11:00' },
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('uses 20-minute default when departure has OffBlockTime only', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', OffBlockTime: '10:00', TakeoffTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01', OffBlockTime: '10:25' }, // default end = 10:45, overlaps with 10:00-10:30
    ];
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(1);
  });

  it('uses 20-minute default when arrival has LandingTime only', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01', LandingTime: '10:25' }, // default end = 10:45, overlaps with 10:00-10:30
    ];
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(1);
  });

  it('skips flights with no LandingTime or OffBlockTime', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'CAL5678', Stand: 'A01' }, // no time data
    ];
    expect(detectStandConflicts(flights)).toEqual([]);
  });

  it('reports all pairwise conflicts for three overlapping flights', () => {
    const flights = [
      { CallSign: 'AAA1111', Stand: 'A01', LandingTime: '10:00', InBlockTime: '10:30' },
      { CallSign: 'BBB2222', Stand: 'A01', LandingTime: '10:15', InBlockTime: '10:45' },
      { CallSign: 'CCC3333', Stand: 'A01', LandingTime: '10:10', InBlockTime: '10:20' },
    ];
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(3); // A-B, A-C, B-C
  });

  it('issue message contains both callsigns and stand name', () => {
    const flights = [
      { CallSign: 'CES1234', Stand: 'B05', LandingTime: '08:00', InBlockTime: '08:30' },
      { CallSign: 'CAL5678', Stand: 'B05', LandingTime: '08:15', InBlockTime: '08:45' },
    ];
    const issues = detectStandConflicts(flights);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('CES1234');
    expect(issues[0]).toContain('CAL5678');
    expect(issues[0]).toContain('B05');
    expect(issues[0]).toContain('08:00');
    expect(issues[0]).toContain('08:30');
    expect(issues[0]).toContain('08:15');
    expect(issues[0]).toContain('08:45');
  });
});
