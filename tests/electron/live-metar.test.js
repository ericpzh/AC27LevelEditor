/**
 * Unit tests for electron/live-metar.js — the aviationweather.gov history client.
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import Module from 'module';

const httpsPath = require.resolve('https');
const modPath = require.resolve('../../electron/live-metar');

function loadWithMockedHttps(handler) {
  const httpsMock = { get: vi.fn(handler) };
  require.cache[httpsPath] = {
    id: httpsPath, filename: httpsPath, loaded: true, exports: httpsMock,
  };
  delete require.cache[modPath];
  const mod = require('../../electron/live-metar');
  mod._clearCache();
  return { mod, httpsMock };
}

function clearCache() {
  delete require.cache[httpsPath];
  delete require.cache[modPath];
}

afterEach(() => clearCache());

function fakeResponse(status, body) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.setEncoding = () => {};
  process.nextTick(() => {
    res.emit('data', body);
    res.emit('end');
  });
  return res;
}

function fakeRequest() {
  const req = new EventEmitter();
  req.destroy = () => {};
  return req;
}

function respondWith(status, body) {
  return (opts, cb) => {
    const req = fakeRequest();
    process.nextTick(() => cb(fakeResponse(status, body)));
    return req;
  };
}

const METAR_ARR = JSON.stringify([
  { icaoId: 'KJFK', obsTime: 1790214660, wdir: 60, wspd: 16, cover: 'SCT', rawOb: 'METAR KJFK 240151Z 06016G25KT 10SM SCT250' },
]);
const TAF_ARR = JSON.stringify([
  { icaoId: 'ZSJN', rawTAF: 'TAF ZSJN 232103Z 2400/2424 18003MPS 3500 BR NSC', fcsts: [] },
]);

describe('live-metar.fetchLiveHistory', () => {
  it('rejects a bad ICAO without a request', async () => {
    const { mod, httpsMock } = loadWithMockedHttps(() => { throw new Error('should not call'); });
    const res = await mod.fetchLiveHistory({ icao: 'XX' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('invalid_icao');
    expect(httpsMock.get).not.toHaveBeenCalled();
  });

  it('requests 24h of METAR history and returns reports newest-first', async () => {
    const { mod, httpsMock } = loadWithMockedHttps(respondWith(200, METAR_ARR));
    const res = await mod.fetchLiveHistory({ icao: 'kjfk' });
    expect(res.ok).toBe(true);
    expect(res.source).toBe('METAR');
    expect(res.icao).toBe('KJFK');
    expect(res.reports).toHaveLength(1);
    expect(res.reports[0].cover).toBe('SCT');
    const path = httpsMock.get.mock.calls[0][0].path;
    expect(path).toContain('ids=KJFK');
    expect(path).toContain('hours=24');
    expect(httpsMock.get.mock.calls[0][0].headers['User-Agent']).toMatch(/AC27LevelEditor/);
  });

  it('falls back to TAF on METAR 204', async () => {
    const { mod } = loadWithMockedHttps((opts, cb) => {
      const req = fakeRequest();
      const isMetar = opts.path.includes('/metar');
      process.nextTick(() => cb(fakeResponse(isMetar ? 204 : 200, isMetar ? '' : TAF_ARR)));
      return req;
    });
    const res = await mod.fetchLiveHistory({ icao: 'ZSJN' });
    expect(res.ok).toBe(true);
    expect(res.source).toBe('TAF');
    expect(res.report.icaoId).toBe('ZSJN');
  });

  it('returns no_data when both METAR and TAF are empty', async () => {
    const { mod } = loadWithMockedHttps(respondWith(204, ''));
    const res = await mod.fetchLiveHistory({ icao: 'ZSJN' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('no_data');
  });

  it('maps network errors', async () => {
    const { mod } = loadWithMockedHttps(() => {
      const req = fakeRequest();
      process.nextTick(() => req.emit('error', new Error('boom')));
      return req;
    });
    const res = await mod.fetchLiveHistory({ icao: 'KJFK' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('network_error');
  });
});
