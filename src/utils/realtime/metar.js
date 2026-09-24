/**
 * Pure mapping helpers that turn aviationweather.gov observations into AC27
 * timeline frames.
 *
 * - METAR history (`/api/data/metar?ids=XXXX&format=json&hours=24`) drives
 *   the full 24h weather timeline: one frame per observation, consecutive
 *   duplicates collapsed.
 * - Wind frames are clipped to the level's scenario window — only
 *   observations inside [configStartTime, configEndTime] become wind frames
 *   (with a single fallback frame at window start when nothing falls inside).
 * - Stations without METAR (e.g. ZSJN) fall back to TAF forecast periods.
 *
 * Observation clocks are converted to the airport's local timezone (the
 * level's scenario times are local wall-clock). Wind speeds from both
 * endpoints are already normalized to knots by the API, matching the
 * editor store unit (see references/data-flow.md "Wind speed conversion").
 *
 * No network access here; history is fetched by the main process
 * (`fetch-live-metar` IPC → `electron/live-metar.js`).
 */

/** Local timezone per supported airport; everything else falls back to UTC. */
export const AIRPORT_TIMEZONES = {
  ZSJN: 'Asia/Shanghai',
  ZGSZ: 'Asia/Shanghai',
  KJFK: 'America/New_York',
  KDCA: 'America/New_York',
};

export function timezoneForIcao(icao) {
  return AIRPORT_TIMEZONES[String(icao || '').toUpperCase()] || 'UTC';
}

const MINUTES_PER_DAY = 24 * 60;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function minutesToHHMMSS(m) {
  const mm = ((m % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad2(Math.floor(mm / 60))}:${pad2(mm % 60)}:00`;
}

/** Epoch seconds → local "HH:MM:SS" in the given IANA timezone. */
export function epochToLocalHHMMSS(epochSec, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(epochSec * 1000)).map(p => [p.type, p.value]));
  // en-GB can emit "24" for midnight — normalize to "00".
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return `${hh}:${parts.minute}:${parts.second}`;
}

/** Epoch seconds → local minutes-from-midnight in the given IANA timezone. */
export function epochToLocalMinutes(epochSec, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(epochSec * 1000)).map(p => [p.type, p.value]));
  const hh = parts.hour === '24' ? 0 : parseInt(parts.hour, 10);
  return hh * 60 + parseInt(parts.minute, 10);
}

/** Observation epoch: `obsTime` (sec) preferred, `reportTime` (ISO) fallback. */
export function reportEpochSec(report) {
  if (Number.isFinite(report?.obsTime)) return report.obsTime;
  const t = Date.parse(report?.reportTime);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

/** "10+" → 10, 2.17 → 2.17, null/garbage → null (statute miles). */
export function parseVisibility(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.match(/[\d.]+/);
    if (m) return parseFloat(m[0]);
  }
  return null;
}

// Present-weather tokens that mean wet conditions on the airframe/field:
// rain, drizzle, snow, ice pellets, hail, showers, thunderstorm, freezing,
// unknown precipitation. Matched against rawOb / wxString. Longer compounds
// come first; the (?![A-Z]) guard keeps e.g. BR (mist) from matching RA.
const PRECIP_RE = /\b[+-]?(FZRA|FZDZ|SHRA|SHSN|TSRA|VCTS|RA|DZ|SN|SG|PL|GR|GS|UP|SH|TS)(?![A-Z])/;

export function hasPrecipitation(wxText) {
  return PRECIP_RE.test(String(wxText || '').toUpperCase());
}

// Sky-cover severity rank (highest wins when `cover` is absent).
const COVER_RANK = { SKC: 0, CLR: 0, NSC: 0, CAVOK: 0, FEW: 1, SCT: 2, BKN: 3, OVC: 4, VV: 4 };

function resolveCover(report) {
  const top = String(report?.cover || '').toUpperCase();
  if (top && top in COVER_RANK) return top;
  let best = '';
  for (const c of (report?.clouds || [])) {
    const cov = String(c?.cover || '').toUpperCase();
    if (cov in COVER_RANK && (best === '' || COVER_RANK[cov] > COVER_RANK[best])) best = cov;
  }
  return best;
}

/**
 * Map one observation to a WEATHER_PRESETS entry.
 * The game only offers six presets, so the mapping is by dominant condition:
 * precipitation wins, then ceiling coverage, then visibility (murk → overcast
 * is the closest of the six — there is no fog preset).
 */
export function metarToPreset(report) {
  const wxText = report?.wxString || report?.rawOb || '';
  if (hasPrecipitation(wxText)) return 'AfterRain';
  const cover = resolveCover(report);
  if (cover === 'OVC' || cover === 'VV') return 'OvercastSky';
  if (cover === 'BKN') return 'MidCloudy';
  if (cover === 'SCT') return 'PartlyCloudy';
  if (cover === 'FEW') return 'FewCloudy';
  const visib = parseVisibility(report?.visib);
  if (visib !== null && visib < 3) return 'OvercastSky';
  return 'Sunny';
}

/** Map one observation's wind to a timeline entry (knots, as stored). */
export function reportToWind(report) {
  const dir = Number.isFinite(report?.wdir) ? Math.round(report.wdir) % 360 : 0;
  const spd = Number.isFinite(report?.wspd) ? Math.max(0, Math.round(report.wspd)) : 0;
  return { direction: dir < 0 ? dir + 360 : dir, speed: spd };
}

/** Is minute-of-day `m` inside [startMin, endMin] (window may cross midnight)? */
export function inWindow(m, startMin, endMin) {
  if (startMin === null || endMin === null) return true;
  return startMin <= endMin ? (m >= startMin && m <= endMin) : (m >= startMin || m <= endMin);
}

function withEpoch(reports) {
  return (reports || [])
    .map(r => ({ report: r, epoch: reportEpochSec(r) }))
    .filter(e => e.epoch !== null)
    .sort((a, b) => a.epoch - b.epoch);
}

/**
 * Full-day weather frames from METAR history: chronological, consecutive
 * identical presets collapsed to the first frame of each run.
 * @returns {Array<{ preset: string, time: "HH:MM:SS" }>}
 */
export function buildWeatherFrames(reports, timeZone) {
  const frames = [];
  for (const { report, epoch } of withEpoch(reports)) {
    const preset = metarToPreset(report);
    if (frames.length > 0 && frames[frames.length - 1].preset === preset) continue;
    frames.push({ preset, time: epochToLocalHHMMSS(epoch, timeZone) });
  }
  return frames;
}

/**
 * Wind frames on a 15-minute grid across the level window.
 *
 * Every 15-min tick from window start to window end (inclusive) gets a frame
 * carrying the latest observation at/before that tick — even when the value
 * is unchanged from the previous tick. METAR cadence is ~hourly, so a
 * collapsed "one frame per change" timeline would show a single wind frame
 * for the whole level; the game interpolates wind between frames, and an
 * explicit grid keeps the timeline inspectable and editable per quarter-hour.
 *
 * Day-shifted candidates ({m-1440, m, m+1440}) make "latest at/before tick"
 * well-defined across midnight-crossing windows without unwrap heuristics.
 * Without a level window there is no grid to sample — one frame per
 * observation, consecutive duplicates collapsed.
 * @returns {Array<{ direction: number, speed: number, time: "HH:MM:SS" }>}
 */
export const WIND_FRAME_STEP_MIN = 15;
const MAX_WIND_FRAMES = 97; // 24h at 15-min cadence + end tick

export function buildWindFrames(reports, timeZone, startMin, endMin) {
  const chrono = withEpoch(reports);
  if (chrono.length === 0) return [];
  const winds = chrono.map(({ report, epoch }) => ({
    ...reportToWind(report),
    min: epochToLocalMinutes(epoch, timeZone),
  }));

  if (startMin === null || endMin === null) {
    const frames = [];
    for (const w of winds) {
      const prev = frames[frames.length - 1];
      if (prev && prev.direction === w.direction && prev.speed === w.speed) continue;
      frames.push({ direction: w.direction, speed: w.speed, time: minutesToHHMMSS(w.min) });
    }
    return frames;
  }

  const crossMidnight = endMin < startMin;
  const startAbs = startMin;
  const endAbs = crossMidnight ? endMin + MINUTES_PER_DAY : endMin;
  // Latest observation at/before absolute tick t (day-shifted candidates).
  const valueAt = (t) => {
    let best = null;
    for (const w of winds) {
      for (const c of [w.min - MINUTES_PER_DAY, w.min, w.min + MINUTES_PER_DAY]) {
        if (c <= t && (best === null || c > best.c)) best = { c, w };
      }
    }
    return (best && best.w) || winds[0];
  };

  const frames = [];
  for (let t = startAbs; t <= endAbs && frames.length < MAX_WIND_FRAMES; t += WIND_FRAME_STEP_MIN) {
    const v = valueAt(t);
    frames.push({ direction: v.direction, speed: v.speed, time: minutesToHHMMSS(t % MINUTES_PER_DAY) });
  }
  // Ensure the exact window end is represented when off-grid.
  const endTime = minutesToHHMMSS(endAbs % MINUTES_PER_DAY);
  if (frames.length > 0 && frames[frames.length - 1].time !== endTime && frames.length < MAX_WIND_FRAMES) {
    const v = valueAt(endAbs);
    frames.push({ direction: v.direction, speed: v.speed, time: endTime });
  }
  return frames;
}

/** Expand a TAF report's forecast periods into observation-like entries. */
export function tafPeriodsToEntries(tafReport) {
  const fcsts = Array.isArray(tafReport?.fcsts) ? tafReport.fcsts : [];
  return fcsts
    .filter(f => Number.isFinite(f?.timeFrom))
    .sort((a, b) => a.timeFrom - b.timeFrom)
    .map(f => ({
      obsTime: f.timeFrom,
      cover: f?.clouds?.[0]?.cover || '',
      clouds: f.clouds || [],
      visib: f.visib,
      wxString: f.wxString || '',
      rawOb: '',
      wdir: f.wdir,
      wspd: f.wspd,
    }));
}

/**
 * Build both timelines from a `fetch-live-metar` payload.
 * @param {{ source: 'METAR'|'TAF', reports?: object[], report?: object }} payload
 * @param {{ timeZone: string, startMin: number|null, endMin: number|null }} ctx
 * @returns {{ weatherFrames: Array, windFrames: Array }}
 */
export function buildLiveTimelines(payload, ctx = {}) {
  const timeZone = ctx.timeZone || 'UTC';
  const startMin = ctx.startMin ?? null;
  const endMin = ctx.endMin ?? null;
  const entries = payload?.source === 'TAF'
    ? tafPeriodsToEntries(payload?.report)
    : (payload?.reports || []);
  return {
    weatherFrames: buildWeatherFrames(entries, timeZone),
    windFrames: buildWindFrames(entries, timeZone, startMin, endMin),
  };
}
