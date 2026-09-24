/**
 * Unit tests for the aviationweather.gov → AC27 weather/wind mapper.
 * Fixtures replay real API responses captured 2026-09-24 (no network).
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  timezoneForIcao, epochToLocalHHMMSS, reportEpochSec,
  parseVisibility, hasPrecipitation, inWindow,
  metarToPreset, reportToWind,
  buildWeatherFrames, buildWindFrames,
  tafPeriodsToEntries, buildLiveTimelines,
} from '../../src/utils/realtime/metar.js';

// Real METAR objects (shape as returned by /api/data/metar?format=json).
const KJFK_SCT = {
  icaoId: 'KJFK', obsTime: 1790214660, reportTime: '2026-09-24T02:00:00.000Z',
  wdir: 60, wspd: 16, wgst: 25, visib: '10+', cover: 'SCT',
  clouds: [{ cover: 'FEW', base: 4900 }, { cover: 'SCT', base: 25000 }],
  rawOb: 'METAR KJFK 240151Z 06016G25KT 10SM FEW049 SCT250 15/06 A3046 RMK AO2 PK WND 06027/0141 SLP314 T01500056 $',
};

const KDCA_BKN = {
  icaoId: 'KDCA', obsTime: 1790214720, reportTime: '2026-09-24T02:00:00.000Z',
  wdir: 60, wspd: 12, visib: '10+', cover: 'BKN',
  clouds: [{ cover: 'FEW', base: 5500 }, { cover: 'BKN', base: 11000 }],
  rawOb: 'METAR KDCA 240152Z 06012KT 10SM FEW055 BKN110 BKN250 17/09 A3038 RMK AO2 PK WND 08027/0112 SLP287 T01720094',
};

const ZGSZ_SCT = {
  icaoId: 'ZGSZ', obsTime: 1790215200, reportTime: '2026-09-24T02:00:00.000Z',
  wdir: 110, wspd: 4, visib: '6+', cover: 'SCT',
  clouds: [{ cover: 'SCT', base: 2600 }],
  rawOb: 'METAR ZGSZ 240200Z 11002MPS 030V170 9999 SCT026 30/24 Q1016 NOSIG',
};

// Real TAF object for ZSJN (no METAR available — HTTP 204).
const ZSJN_TAF = {
  icaoId: 'ZSJN', rawTAF: 'TAF ZSJN 232103Z 2400/2424 18003MPS 3500 BR NSC TX32/2406Z TN19/2421Z',
  fcsts: [{
    timeFrom: 1790208000, timeTo: 1790294400, wdir: 180, wspd: 6,
    visib: 2.17, wxString: 'BR', clouds: [{ cover: 'NSC', base: null }],
  }],
};

describe('timezoneForIcao', () => {
  it('maps the 4 supported airports to local zones', () => {
    expect(timezoneForIcao('KJFK')).toBe('America/New_York');
    expect(timezoneForIcao('KDCA')).toBe('America/New_York');
    expect(timezoneForIcao('ZSJN')).toBe('Asia/Shanghai');
    expect(timezoneForIcao('ZGSZ')).toBe('Asia/Shanghai');
  });
  it('falls back to UTC for unknown stations', () => {
    expect(timezoneForIcao('EGLL')).toBe('UTC');
    expect(timezoneForIcao('')).toBe('UTC');
  });
});

describe('epochToLocalHHMMSS', () => {
  it('converts a KJFK obs to EDT wall-clock (03:00Z → 23:00)', () => {
    const epoch = Date.parse('2026-09-24T03:00:00.000Z') / 1000;
    expect(epochToLocalHHMMSS(epoch, 'America/New_York')).toBe('23:00:00');
  });
  it('converts a ZGSZ obs to CST wall-clock (02:00Z → 10:00)', () => {
    const epoch = Date.parse('2026-09-24T02:00:00.000Z') / 1000;
    expect(epochToLocalHHMMSS(epoch, 'Asia/Shanghai')).toBe('10:00:00');
  });
});

describe('reportEpochSec', () => {
  it('prefers obsTime, falls back to reportTime', () => {
    expect(reportEpochSec(KJFK_SCT)).toBe(1790214660);
    expect(reportEpochSec({ reportTime: '2026-09-24T02:00:00.000Z' })).toBe(1790215200);
    expect(reportEpochSec({})).toBe(null);
  });
});

describe('parseVisibility / hasPrecipitation / inWindow', () => {
  it('parses AWC visibility forms', () => {
    expect(parseVisibility('10+')).toBe(10);
    expect(parseVisibility('6+')).toBe(6);
    expect(parseVisibility(2.17)).toBe(2.17);
    expect(parseVisibility(null)).toBe(null);
  });
  it('detects wet present-weather tokens', () => {
    expect(hasPrecipitation('METAR KJFK 240251Z 04014G21KT 10SM +TSRA BKN250')).toBe(true);
    expect(hasPrecipitation('-RA')).toBe(true);
    expect(hasPrecipitation('BR')).toBe(false);
    expect(hasPrecipitation(KJFK_SCT.rawOb)).toBe(false);
  });
  it('handles midnight-crossing windows', () => {
    expect(inWindow(23 * 60, 22 * 60, 60)).toBe(true);
    expect(inWindow(30, 22 * 60, 60)).toBe(true);
    expect(inWindow(120, 22 * 60, 60)).toBe(false);
    expect(inWindow(500, null, null)).toBe(true);
  });
});

describe('metarToPreset', () => {
  it('maps cover classes to distinct presets', () => {
    expect(metarToPreset(KJFK_SCT)).toBe('PartlyCloudy');
    expect(metarToPreset(KDCA_BKN)).toBe('MidCloudy');
    expect(metarToPreset(ZGSZ_SCT)).toBe('PartlyCloudy');
    expect(metarToPreset({ cover: 'FEW', visib: '10+', rawOb: 'METAR XXX 240151Z 06005KT 10SM FEW049' })).toBe('FewCloudy');
    expect(metarToPreset({ cover: 'OVC', visib: '10+', rawOb: 'METAR XXX 240151Z 06005KT 10SM OVC010' })).toBe('OvercastSky');
    expect(metarToPreset({ cover: 'CLR', visib: '10+', rawOb: 'METAR XXX 240151Z 06005KT 10SM CLR' })).toBe('Sunny');
  });
  it('derives cover from the clouds array when top-level cover is missing', () => {
    expect(metarToPreset({ clouds: [{ cover: 'BKN', base: 11000 }], visib: '10+', rawOb: '' })).toBe('MidCloudy');
  });
  it('precipitation wins over cover', () => {
    expect(metarToPreset({ ...KDCA_BKN, rawOb: 'METAR KDCA 240152Z 06012KT 10SM +TSRA BKN110 17/09 A3038' })).toBe('AfterRain');
  });
  it('low visibility falls back to OvercastSky (no fog preset exists)', () => {
    expect(metarToPreset({ cover: 'NSC', visib: 2.17, wxString: 'BR', rawOb: '' })).toBe('OvercastSky');
  });
});

describe('reportToWind', () => {
  it('reads direction/speed in knots', () => {
    expect(reportToWind(KJFK_SCT)).toEqual({ direction: 60, speed: 16 });
    expect(reportToWind(ZGSZ_SCT)).toEqual({ direction: 110, speed: 4 });
  });
  it('rounds and defaults missing values', () => {
    expect(reportToWind({ wdir: 60.6, wspd: 12.4 })).toEqual({ direction: 61, speed: 12 });
    expect(reportToWind({})).toEqual({ direction: 0, speed: 0 });
  });
});

function hourlyReports() {
  // Newest-first as returned by the API, alternating cover.
  const base = Date.parse('2026-09-24T03:00:00.000Z') / 1000;
  return [0, 1, 2].map(i => ({
    obsTime: base - i * 3600,
    wdir: 60, wspd: 10 + i, visib: '10+',
    cover: i === 1 ? 'BKN' : 'SCT',
    rawOb: `METAR KJFK 240${3 - i}51Z 0601${i}KT 10SM ${i === 1 ? 'BKN250' : 'SCT250'}`,
  }));
}

describe('buildWeatherFrames', () => {
  it('sorts chrono, collapses consecutive duplicates, formats HH:MM:SS', () => {
    const frames = buildWeatherFrames(hourlyReports(), 'America/New_York');
    expect(frames).toEqual([
      { preset: 'PartlyCloudy', time: '21:00:00' }, // 01:00Z → 21:00 EDT prev day
      { preset: 'MidCloudy', time: '22:00:00' },
      { preset: 'PartlyCloudy', time: '23:00:00' },
    ]);
  });
  it('collapses a fully uniform day to one frame', () => {
    const reps = hourlyReports().map(r => ({ ...r, cover: 'SCT' }));
    expect(buildWeatherFrames(reps, 'America/New_York')).toHaveLength(1);
  });
});

describe('buildWindFrames — 15-minute grid', () => {
  // hourlyReports local EDT: 21:00 spd12, 22:00 spd11, 23:00 spd10 (dir 60).
  it('emits a frame every 15 min across the window, forward-filled', () => {
    const frames = buildWindFrames(hourlyReports(), 'America/New_York', 22 * 60 + 30, 23 * 60 + 30);
    expect(frames).toEqual([
      { direction: 60, speed: 11, time: '22:30:00' },
      { direction: 60, speed: 11, time: '22:45:00' },
      { direction: 60, speed: 10, time: '23:00:00' },
      { direction: 60, speed: 10, time: '23:15:00' },
      { direction: 60, speed: 10, time: '23:30:00' },
    ]);
  });
  it('still emits every tick when the value never changes', () => {
    // Nothing in-window: every tick seeds from the latest prior obs
    // (day-shifted 23:00 → speed 10) and repeats it across the grid.
    const frames = buildWindFrames(hourlyReports(), 'America/New_York', 10 * 60, 11 * 60);
    expect(frames).toEqual([
      { direction: 60, speed: 10, time: '10:00:00' },
      { direction: 60, speed: 10, time: '10:15:00' },
      { direction: 60, speed: 10, time: '10:30:00' },
      { direction: 60, speed: 10, time: '10:45:00' },
      { direction: 60, speed: 10, time: '11:00:00' },
    ]);
  });
  it('handles midnight-crossing windows', () => {
    const frames = buildWindFrames(hourlyReports(), 'America/New_York', 23 * 60, 60);
    expect(frames).toHaveLength(9);
    expect(frames[0]).toEqual({ direction: 60, speed: 10, time: '23:00:00' });
    expect(frames[4]).toEqual({ direction: 60, speed: 10, time: '00:00:00' });
    expect(frames[8]).toEqual({ direction: 60, speed: 10, time: '01:00:00' });
  });
  it('represents an off-grid window end with an extra tick', () => {
    const frames = buildWindFrames(hourlyReports(), 'America/New_York', 22 * 60, 22 * 60 + 20);
    expect(frames).toEqual([
      { direction: 60, speed: 11, time: '22:00:00' },
      { direction: 60, speed: 11, time: '22:15:00' },
      { direction: 60, speed: 11, time: '22:20:00' },
    ]);
  });
  it('falls back to per-observation frames without a level window', () => {
    const frames = buildWindFrames(hourlyReports(), 'America/New_York', null, null);
    expect(frames).toEqual([
      { direction: 60, speed: 12, time: '21:00:00' },
      { direction: 60, speed: 11, time: '22:00:00' },
      { direction: 60, speed: 10, time: '23:00:00' },
    ]);
  });
});

describe('TAF fallback', () => {
  it('expands forecast periods into entries', () => {
    const entries = tafPeriodsToEntries(ZSJN_TAF);
    expect(entries).toHaveLength(1);
    expect(entries[0].wdir).toBe(180);
    expect(metarToPreset(entries[0])).toBe('OvercastSky');
  });
  it('buildLiveTimelines dispatches on source', () => {
    const metar = buildLiveTimelines(
      { source: 'METAR', reports: hourlyReports() },
      { timeZone: 'America/New_York', startMin: 0, endMin: 60 }
    );
    expect(metar.weatherFrames.length).toBe(3);
    // 00:00–01:00 grid: 5 ticks, all seeded from the previous evening's obs.
    expect(metar.windFrames).toHaveLength(5);
    expect(metar.windFrames[0].time).toBe('00:00:00');
    expect(metar.windFrames[4].time).toBe('01:00:00');
    const taf = buildLiveTimelines(
      { source: 'TAF', report: ZSJN_TAF },
      { timeZone: 'Asia/Shanghai', startMin: 480, endMin: 525 }
    );
    expect(taf.weatherFrames).toEqual([{ preset: 'OvercastSky', time: '08:00:00' }]);
    expect(taf.windFrames).toEqual([
      { direction: 180, speed: 6, time: '08:00:00' },
      { direction: 180, speed: 6, time: '08:15:00' },
      { direction: 180, speed: 6, time: '08:30:00' },
      { direction: 180, speed: 6, time: '08:45:00' },
    ]);
  });
});
