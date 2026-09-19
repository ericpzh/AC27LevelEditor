/**
 * Unit tests for electron/aviationstack.js — the free-plan HTTP client.
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import Module from 'module';

const httpPath = require.resolve('http');

function loadWithMockedHttp(handler) {
  const httpMock = { get: vi.fn(handler) };
  require.cache[httpPath] = {
    id: httpPath, filename: httpPath, loaded: true, exports: httpMock,
  };
  delete require.cache[require.resolve('../../electron/aviationstack')];
  const mod = require('../../electron/aviationstack');
  return { mod, httpMock };
}

function clearCache() {
  delete require.cache[httpPath];
  delete require.cache[require.resolve('../../electron/aviationstack')];
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

/** Build an http.get mock that responds with the given status/body. */
function respondWith(status, body) {
  return (opts, cb) => {
    const req = fakeRequest();
    process.nextTick(() => cb(fakeResponse(status, body)));
    return req;
  };
}

describe('aviationstack.fetchFlights', () => {
  it('rejects a missing key without making a request', async () => {
    const { mod, httpMock } = loadWithMockedHttp(() => { throw new Error('should not call'); });
    const res = await mod.fetchFlights({ key: '' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('missing_access_key');
    expect(httpMock.get).not.toHaveBeenCalled();
  });

  it('requests plain HTTP with the access key and params', async () => {
    let captured;
    const { mod } = loadWithMockedHttp((opts, cb) => {
      captured = opts;
      const req = fakeRequest();
      process.nextTick(() => cb(fakeResponse(200, JSON.stringify({ data: [{ a: 1 }], pagination: {} }))));
      return req;
    });
    const res = await mod.fetchFlights({ key: 'abc', params: { arr_icao: 'ZSJN', limit: 10 } });
    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(captured.host).toBe('api.aviationstack.com');
    expect(captured.path).toContain('/v1/flights?');
    expect(captured.path).toContain('access_key=abc');
    expect(captured.path).toContain('arr_icao=ZSJN');
  });

  it('surfaces an in-band aviationstack error (HTTP 200)', async () => {
    const { mod } = loadWithMockedHttp(respondWith(200, JSON.stringify({
      error: { code: 'https_access_restricted', message: 'no https' },
    })));
    const res = await mod.fetchFlights({ key: 'abc' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('https_access_restricted');
  });

  it('maps a non-200 status to an error', async () => {
    const { mod } = loadWithMockedHttp(respondWith(500, 'oops'));
    const res = await mod.fetchFlights({ key: 'abc' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('http_500');
  });

  it('maps a transport error to network_error', async () => {
    const { mod } = loadWithMockedHttp(() => {
      const req = fakeRequest();
      process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
      return req;
    });
    const res = await mod.fetchFlights({ key: 'abc' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('network_error');
  });

  it('handles invalid JSON', async () => {
    const { mod } = loadWithMockedHttp(respondWith(200, '<html>nope</html>'));
    const res = await mod.fetchFlights({ key: 'abc' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('invalid_response');
  });
});

describe('aviationstack.buildQuery', () => {
  it('omits empty values', () => {
    const { mod } = loadWithMockedHttp(() => { throw new Error('unused'); });
    const q = mod.buildQuery({ a: 1, b: '', c: null, d: undefined, e: 'x' });
    expect(q).toContain('a=1');
    expect(q).toContain('e=x');
    expect(q).not.toContain('b=');
    expect(q).not.toContain('c=');
    expect(q).not.toContain('d=');
  });
});
