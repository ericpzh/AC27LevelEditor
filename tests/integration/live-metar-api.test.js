/**
 * Live-endpoint coverage for the aviationweather.gov import.
 *
 * Hits the REAL API (`/api/data/metar?ids=XXXX&format=json&hours=24`, TAF
 * fallback) through the real main-process client — no mocks. Gated on
 * `AC27_LIVE_API=1` so normal runs (and CI) never touch the network, mirroring
 * the `FUZZ_RUN` gate for fuzz specs and the game-root gates for fixture
 * tests. Run with:
 *
 *   AC27_LIVE_API=1 npx vitest run tests/integration/live-metar-api.test.js
 *
 * Request budget: ~5 sequential HTTPS calls, well under the API's 100/min.
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { WEATHER_PRESETS } from '../../src/utils/constants/index.js';
import {
  buildLiveTimelines, timezoneForIcao,
} from '../../src/utils/realtime/metar.js';

const describeLive = process.env.AC27_LIVE_API === '1' ? describe : describe.skip;
const TIMEOUT = 30000;

function loadClient() {
  delete require.cache[require.resolve('../../electron/live-metar')];
  const mod = require('../../electron/live-metar');
  mod._clearCache();
  return mod;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

describeLive('live aviationweather.gov API', () => {
  it('KJFK: 24h METAR history is fresh and well-formed', { timeout: TIMEOUT }, async () => {
    const live = loadClient();
    const res = await live.fetchLiveHistory({ icao: 'KJFK' });
    expect(res.ok).toBe(true);
    expect(res.source).toBe('METAR');
    expect(res.reports.length).toBeGreaterThanOrEqual(12); // hourly cadence, tolerant of gaps
    for (const r of res.reports) {
      expect(Number.isFinite(r.obsTime)).toBe(true);
      expect(typeof r.cover).toBe('string');
      expect(r.wdir === null || (r.wdir >= 0 && r.wdir <= 360)).toBe(true);
      expect(Number.isFinite(r.wspd) && r.wspd >= 0).toBe(true);
    }
    const newest = Math.max(...res.reports.map(r => r.obsTime));
    expect(Date.now() / 1000 - newest).toBeLessThan(3 * 3600); // latest obs < 3h old
  });

  it.each(['KDCA', 'ZGSZ'])('%s: METAR history is well-formed', { timeout: TIMEOUT }, async (icao) => {
    const live = loadClient();
    const res = await live.fetchLiveHistory({ icao });
    expect(res.ok).toBe(true);
    expect(res.source).toBe('METAR');
    expect(res.reports.length).toBeGreaterThan(0);
    for (const r of res.reports) {
      expect(Number.isFinite(r.obsTime)).toBe(true);
      expect(Number.isFinite(r.wspd) && r.wspd >= 0).toBe(true);
    }
  });

  it('ZSJN: METAR or TAF fallback yields a usable payload', { timeout: TIMEOUT }, async () => {
    const live = loadClient();
    const res = await live.fetchLiveHistory({ icao: 'ZSJN' });
    expect(res.ok).toBe(true);
    if (res.source === 'METAR') {
      expect(res.reports.length).toBeGreaterThan(0);
    } else {
      expect(res.source).toBe('TAF');
      expect(Array.isArray(res.report.fcsts)).toBe(true);
      expect(res.report.fcsts.length).toBeGreaterThan(0);
    }
  });

  it('KJFK: live payload maps to valid 24h timelines', { timeout: TIMEOUT }, async () => {
    const live = loadClient();
    const res = await live.fetchLiveHistory({ icao: 'KJFK' });
    expect(res.ok).toBe(true);
    // Representative level window (10:15–11:00 local).
    const { weatherFrames, windFrames } = buildLiveTimelines(res, {
      timeZone: timezoneForIcao('KJFK'), startMin: 615, endMin: 660,
    });
    expect(weatherFrames.length).toBeGreaterThan(0);
    for (const f of weatherFrames) {
      expect(WEATHER_PRESETS).toContain(f.preset);
      expect(f.time).toMatch(TIME_RE);
    }
    // 15-min grid over a 45-min window: exactly 4 frames.
    expect(windFrames).toHaveLength(4);
    expect(windFrames.map(f => f.time)).toEqual(['10:15:00', '10:30:00', '10:45:00', '11:00:00']);
    for (const f of windFrames) {
      expect(f.direction).toBeGreaterThanOrEqual(0);
      expect(f.direction).toBeLessThan(360);
      expect(f.speed).toBeGreaterThanOrEqual(0);
    }
  });

  it('second call for the same station is served from cache', { timeout: TIMEOUT }, async () => {
    const live = loadClient();
    const first = await live.fetchLiveHistory({ icao: 'KJFK' });
    expect(first.ok).toBe(true);
    const second = await live.fetchLiveHistory({ icao: 'KJFK' });
    expect(second.ok).toBe(true);
    expect(second.cached).toBe(true);
  });
});
