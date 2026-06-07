import { describe, it, expect } from 'vitest';
import {
  ticksToTime,
  timeToTicks,
  timeToMinutes,
  timeToSeconds,
  minutesToTimeStr,
  sortTimelineByTime,
  getTimelineActiveRange,
  getDefaultTime,
  _extractBaseDateFromText,
} from '../../src/utils/timeUtils';

// ─── ticksToTime ────────────────────────────────────────────────

describe('ticksToTime', () => {
  it('returns empty string for 0', () => {
    expect(ticksToTime(0)).toBe('');
  });

  it('returns empty string for "0"', () => {
    expect(ticksToTime('0')).toBe('');
  });

  it('returns empty string for 0n', () => {
    expect(ticksToTime(0n)).toBe('');
  });

  it('converts ticks to HH:MM:SS format', () => {
    // NET_EPOCH_OFFSET = 621355968000000000n (Jan 1, 0001 offset)
    // Adding 0 ticks = midnight 0001-01-01 in ISO = "00:00:00"
    const midnightTicks = '621355968000000000'; // NET_EPOCH_OFFSET
    const result = ticksToTime(midnightTicks);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

// ─── timeToTicks ────────────────────────────────────────────────

describe('timeToTicks', () => {
  it('returns 0 for empty string', () => {
    expect(timeToTicks('')).toBe(0);
    expect(timeToTicks('  ')).toBe(0);
  });

  it('returns 0 for invalid format', () => {
    expect(timeToTicks('abc')).toBe(0);
  });

  it('converts HH:MM:SS to ticks', () => {
    const result = timeToTicks('01:00:00');
    expect(result).toBeGreaterThan(0);
  });

  it('adds baseDateTicks when provided', () => {
    const withoutBase = timeToTicks('01:00:00');
    const withBase = timeToTicks('01:00:00', 1000000);
    expect(withBase).toBe(withoutBase + 1000000);
  });
});

// ─── timeToMinutes ──────────────────────────────────────────────

describe('timeToMinutes', () => {
  it('converts HH:MM to total minutes', () => {
    expect(timeToMinutes('01:30')).toBe(90);
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('12:00')).toBe(720);
  });

  it('handles HH:MM:SS format (ignores seconds)', () => {
    expect(timeToMinutes('01:30:45')).toBe(90);
  });
});

// ─── timeToSeconds ──────────────────────────────────────────────

describe('timeToSeconds', () => {
  it('converts HH:MM:SS to total seconds', () => {
    expect(timeToSeconds('01:00:00')).toBe(3600);
    expect(timeToSeconds('00:01:00')).toBe(60);
    expect(timeToSeconds('00:00:01')).toBe(1);
  });

  it('handles HH:MM format (seconds default to 0)', () => {
    expect(timeToSeconds('01:00')).toBe(3600);
  });
});

// ─── minutesToTimeStr ───────────────────────────────────────────

describe('minutesToTimeStr', () => {
  it('converts minutes to HH:MM:00', () => {
    expect(minutesToTimeStr(90)).toBe('01:30:00');
    expect(minutesToTimeStr(0)).toBe('00:00:00');
    expect(minutesToTimeStr(720)).toBe('12:00:00');
  });

  it('wraps at 24 hours', () => {
    expect(minutesToTimeStr(1500)).toBe('01:00:00');
  });
});

// ─── sortTimelineByTime ─────────────────────────────────────────

describe('sortTimelineByTime', () => {
  it('sorts timeline entries by time', () => {
    const timeline = [
      { time: '12:00' },
      { time: '06:00' },
      { time: '18:00' },
    ];
    sortTimelineByTime(timeline);
    expect(timeline[0].time).toBe('06:00');
    expect(timeline[1].time).toBe('12:00');
    expect(timeline[2].time).toBe('18:00');
  });
});

// ─── getTimelineActiveRange ─────────────────────────────────────

describe('getTimelineActiveRange', () => {
  it('returns all indices active when no config bounds', () => {
    const timeline = [{ time: '06:00' }, { time: '12:00' }];
    const result = getTimelineActiveRange(timeline, null, null);
    expect(result.validMinTime).toBeNull();
    expect(result.validMaxTime).toBeNull();
    expect(result.activeIndices.has(0)).toBe(true);
    expect(result.activeIndices.has(1)).toBe(true);
    expect(result.totalCount).toBe(2);
  });

  it('filters to entries within config bounds', () => {
    const timeline = [{ time: '04:00' }, { time: '08:00' }, { time: '12:00' }];
    const result = getTimelineActiveRange(timeline, '06:00', '10:00');
    expect(result.activeIndices.has(0)).toBe(false);
    expect(result.activeIndices.has(1)).toBe(true);
    expect(result.activeIndices.has(2)).toBe(false);
  });
});

// ─── getDefaultTime ─────────────────────────────────────────────

describe('getDefaultTime', () => {
  it('returns midpoint of start/end when both provided', () => {
    const result = getDefaultTime({ _configStartTime: '06:00', _configEndTime: '10:00' });
    expect(result).toBe('08:00:00');
  });

  it('returns 12:00:00 when neither provided', () => {
    const result = getDefaultTime({});
    expect(result).toBe('12:00:00');
  });

  it('returns start time when only start provided', () => {
    const result = getDefaultTime({ _configStartTime: '08:30:00' });
    expect(result).toBe('08:30:00');
  });
});

// ─── _extractBaseDateFromText ───────────────────────────────────

describe('_extractBaseDateFromText', () => {
  it('extracts base date from BaseTime field', () => {
    const text = '"BaseTime": { "$type": 3, 637000000000000000 }';
    const result = _extractBaseDateFromText(text);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });

  it('falls back to WorldState time fields when no BaseTime', () => {
    // A tick representing a large value > TICKS_PER_DAY
    const bigTick = '638000000000000000';
    const text = `"WorldState": { "someField": {}, "LandingTime": { "$type": 3, ${bigTick} } }`;
    const result = _extractBaseDateFromText(text);
    expect(typeof result).toBe('number');
  });

  it('returns FALLBACK_BASE_DATE_TICKS when nothing found', () => {
    const text = '"SomeOtherField": 123';
    const result = _extractBaseDateFromText(text);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });
});
