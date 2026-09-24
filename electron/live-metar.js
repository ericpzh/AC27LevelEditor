/**
 * Live METAR history client for aviationweather.gov (main process only).
 *
 * The AWC Data API serves machine-readable observations at
 * `https://aviationweather.gov/api/data/metar?ids=XXXX&format=json&hours=24`
 * (`hours` = hours back to search, default 1.5; `date` defaults to now —
 * see `data/schema/openapi.yaml`, mirrored from the live spec 2026-09-24).
 * Browsers are blocked by the API's no-CORS policy, so the renderer goes
 * through the `fetch-live-metar` IPC handler.
 *
 * Request etiquette per https://aviationweather.gov/data/api/ : custom
 * User-Agent, low frequency (responses are cached briefly here).
 *
 * Verified 2026-09-24: `ids=KJFK&hours=24` returns 24 hourly reports,
 * newest-first, wind normalized to knots (ZGSZ rawOb "11002MPS" decodes to
 * wspd:4). ZSJN returns HTTP 204 (no METAR) but has a current TAF, so a
 * METAR miss falls back to TAF automatically.
 */
const https = require('https');

const HOST = 'aviationweather.gov';
const USER_AGENT = 'AC27LevelEditor live-weather import (https://aviationweather.gov/data/api/)';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 48;
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map(); // `${ICAO}|${hours}` -> { at, payload }

function requestJson(path, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const req = https.get(
      {
        host: HOST,
        path,
        timeout: timeoutMs,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      },
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

function parseArray(body) {
  const json = JSON.parse(body);
  return Array.isArray(json) ? json : null;
}

/**
 * Fetch up to `hours` of METAR history for one ICAO station (newest-first
 * as returned by the API). Falls back to the current TAF when the station
 * has no METAR (e.g. ZSJN). Both endpoints normalize wind to knots in JSON.
 *
 * @param {{ icao: string, hours?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: true, source: 'METAR', icao: string, reports: object[] }
 *   | { ok: true, source: 'TAF', icao: string, report: object }
 *   | { ok: false, error: { code: string, message: string } }>}
 */
async function fetchLiveHistory({ icao, hours = DEFAULT_HOURS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const station = String(icao || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(station)) {
    return { ok: false, error: { code: 'invalid_icao', message: 'Invalid airport ICAO code.' } };
  }
  const h = Math.min(Math.max(parseInt(hours, 10) || DEFAULT_HOURS, 1), MAX_HOURS);

  const cacheKey = `${station}|${h}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ok: true, ...hit.payload, cached: true };
  }

  // ── METAR history ────────────────────────────────────────
  const metarRes = await requestJson(
    `/api/data/metar?ids=${station}&format=json&hours=${h}`, timeoutMs
  );
  if (metarRes.error) {
    return { ok: false, error: { code: 'network_error', message: metarRes.error.message || 'Network request failed.' } };
  }
  if (metarRes.status === 200) {
    let arr;
    try {
      arr = parseArray(metarRes.body);
    } catch (_) {
      return { ok: false, error: { code: 'invalid_response', message: 'Could not parse METAR response.' } };
    }
    if (arr && arr.length > 0) {
      const payload = { source: 'METAR', icao: station, reports: arr.filter(Boolean) };
      cache.set(cacheKey, { at: Date.now(), payload });
      return { ok: true, ...payload };
    }
    // 200 with empty array → same as 204, fall through to TAF.
  } else if (metarRes.status !== 204 && metarRes.status !== 404) {
    return { ok: false, error: { code: 'http_' + metarRes.status, message: 'aviationweather.gov returned HTTP ' + metarRes.status + '.' } };
  }

  // ── TAF fallback ─────────────────────────────────────────
  const tafRes = await requestJson(
    `/api/data/taf?ids=${station}&format=json`, timeoutMs
  );
  if (tafRes.error) {
    return { ok: false, error: { code: 'network_error', message: tafRes.error.message || 'Network request failed.' } };
  }
  if (tafRes.status === 204 || tafRes.status === 404) {
    return { ok: false, error: { code: 'no_data', message: 'No METAR history or TAF for ' + station + '.' } };
  }
  if (tafRes.status !== 200) {
    return { ok: false, error: { code: 'http_' + tafRes.status, message: 'aviationweather.gov returned HTTP ' + tafRes.status + '.' } };
  }
  let tafArr;
  try {
    tafArr = parseArray(tafRes.body);
  } catch (_) {
    return { ok: false, error: { code: 'invalid_response', message: 'Could not parse TAF response.' } };
  }
  if (!tafArr || tafArr.length === 0 || !tafArr[0]) {
    return { ok: false, error: { code: 'no_data', message: 'No METAR history or TAF for ' + station + '.' } };
  }
  const payload = { source: 'TAF', icao: station, report: tafArr[0] };
  cache.set(cacheKey, { at: Date.now(), payload });
  return { ok: true, ...payload };
}

function _clearCache() {
  cache.clear();
}

module.exports = { fetchLiveHistory, _clearCache, HOST, DEFAULT_HOURS };
