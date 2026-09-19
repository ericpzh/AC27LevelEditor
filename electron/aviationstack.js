/**
 * aviationstack API client (main process only).
 *
 * The free aviationstack plan does NOT support HTTPS — every request must be
 * plain HTTP. We intentionally do not auto-upgrade and do not follow redirects.
 * The access key is passed as the `access_key` query parameter.
 *
 * https://aviationstack.com/documentation
 */
const http = require('http');

const HOST = 'api.aviationstack.com';
const FLIGHTS_PATH = '/v1/flights';
const DEFAULT_TIMEOUT_MS = 12000;

function buildQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  return q.toString();
}

function requestOnce(query, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const req = http.get(
      { host: HOST, path: FLIGHTS_PATH + '?' + query, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => done({ status: res.statusCode, body }));
        res.on('error', (err) => done({ error: err }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => done({ error: err }));
  });
}

/**
 * Fetch flights from aviationstack.
 * @param {{ key: string, params?: object, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: true, data: object[], pagination: object }
 *   | { ok: false, error: { code: string, message: string } }>}
 */
async function fetchFlights({ key, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!key || !String(key).trim()) {
    return { ok: false, error: { code: 'missing_access_key', message: 'No aviationstack API key configured.' } };
  }
  const query = buildQuery({ access_key: String(key).trim(), ...params });
  const res = await requestOnce(query, timeoutMs);

  if (res.error) {
    return { ok: false, error: { code: 'network_error', message: res.error.message || 'Network request failed.' } };
  }
  if (res.status !== 200) {
    return { ok: false, error: { code: 'http_' + res.status, message: 'aviationstack returned HTTP ' + res.status + '.' } };
  }

  let json;
  try {
    json = JSON.parse(res.body);
  } catch (_) {
    return { ok: false, error: { code: 'invalid_response', message: 'Could not parse aviationstack response.' } };
  }

  // aviationstack reports errors in-band with HTTP 200
  if (json && json.error) {
    return {
      ok: false,
      error: {
        code: json.error.code || 'unknown_error',
        message: json.error.message || 'aviationstack request failed.',
      },
    };
  }

  return { ok: true, data: Array.isArray(json?.data) ? json.data : [], pagination: json?.pagination || {} };
}

module.exports = { fetchFlights, buildQuery, HOST, FLIGHTS_PATH };
