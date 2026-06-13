/**
 * Time conversion utilities — Newtonsoft.Json DateTime ticks ↔ HH:MM:SS strings.
 */
import { NET_EPOCH_OFFSET, TICKS_PER_SECOND, TICKS_PER_DAY, FALLBACK_BASE_DATE_TICKS } from './constants.js';

// ─── Tick ↔ Time conversion ─────────────────────────────
export function ticksToTime(ticks) {
  if (ticks === 0 || ticks === '0' || ticks === 0n) return '';
  const ticksBig = BigInt(ticks);
  const ms = Number((ticksBig - NET_EPOCH_OFFSET) / 10000n);
  const d = new Date(ms);
  return d.toISOString().substring(11, 19);
}

export function timeToTicks(timeStr, baseDateTicks) {
  if (!timeStr || !timeStr.trim()) return 0;
  try {
    const parts = timeStr.trim().split(':').map(Number);
    if (parts.length !== 3) return 0;
    const totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    const timeOfDayTicks = totalSeconds * Number(TICKS_PER_SECOND);
    return baseDateTicks ? baseDateTicks + timeOfDayTicks : timeOfDayTicks;
  } catch { return 0; }
}

// ─── Base date extraction from ACL text ─────────────────
export function _extractBaseDateFromText(text) {
  const btMatch = text.match(/"BaseTime"\s*:\s*\{\s*"\$type"\s*:\s*3\s*,\s*(-?\d+)\s*\}/);
  if (btMatch) {
    const ticks = BigInt(btMatch[1]);
    return Number((ticks / TICKS_PER_DAY) * TICKS_PER_DAY);
  }
  const wsIdx = text.indexOf('"WorldState"');
  if (wsIdx >= 0) {
    const wsText = text.substring(wsIdx);
    const timeMatch = wsText.match(/"(?:OffBlockTime|LandingTime|TakeoffTime|InBlockTime)"\s*:\s*\{\s*"\$type"\s*:\s*3\s*,\s*(-?\d+)\s*\}/);
    if (timeMatch) {
      const ticks = BigInt(timeMatch[1]);
      if (ticks > TICKS_PER_DAY) {
        return Number((ticks / TICKS_PER_DAY) * TICKS_PER_DAY);
      }
    }
  }
  return FALLBACK_BASE_DATE_TICKS;
}

// ─── Simple time helpers (used by React frontend) ──────────
export function timeToMinutes(timeStr) {
  const parts = String(timeStr).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}
export function timeToSeconds(timeStr) {
  const parts = String(timeStr).split(':');
  return (parseInt(parts[0], 10) || 0) * 3600 + (parseInt(parts[1], 10) || 0) * 60 + (parseInt(parts[2], 10) || 0);
}
export function minutesToTimeStr(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00';
}
export function sortTimelineByTime(timeline) {
  timeline.sort((a, b) => timeToSeconds(a.time) - timeToSeconds(b.time));
}
export function getTimelineActiveRange(timeline, configStartTime, configEndTime) {
  if (!configStartTime || !configEndTime) {
    return { validMinTime: null, validMaxTime: null, activeIndices: new Set((timeline||[]).map((_, i) => i)), totalCount: (timeline||[]).length };
  }
  const start = timeToMinutes(configStartTime), end = timeToMinutes(configEndTime);
  const activeIndices = new Set();
  for (let i = 0; i < timeline.length; i++) {
    const t = timeToMinutes(timeline[i].time);
    if (t >= start && t <= end) activeIndices.add(i);
  }
  return { validMinTime: start, validMaxTime: end, activeIndices, totalCount: timeline.length };
}
/**
 * Returns the time bounds that a clock OK click should validate against for a given
 * field, mirroring the per‑field logic in runTripleValidation (validators.js).
 *
 * @param {string} col — field name ('OffBlockTime', 'LandingTime', 'InBlockTime',
 *   'TakeoffTime', 'Time', etc.)
 * @param {number|null} _saveSec — scenario snapshot time in seconds since midnight
 * @param {string|null} _configStartTime — scenario start "HH:MM:SS"
 * @param {string|null} _configEndTime — scenario end "HH:MM:SS"
 * @returns {{ minTime: string, maxTime: string } | null}
 *   null means "no bounds validation for this field" (matches save behaviour).
 */
export function getTimeValidationBounds(col, _saveSec, _configStartTime, _configEndTime) {
  // Flight fields OffBlockTime & LandingTime → bound by [_saveSec, _configEndTime]
  if (col === 'OffBlockTime' || col === 'LandingTime') {
    if (_saveSec != null && _configEndTime) {
      const sh = Math.floor(_saveSec / 3600) % 24;
      const sm = Math.floor((_saveSec % 3600) / 60);
      return {
        minTime: String(sh).padStart(2, '0') + ':' + String(sm).padStart(2, '0') + ':00',
        maxTime: _configEndTime,
      };
    }
    return null;
  }

  // InBlockTime & TakeoffTime — save only checks ordering, never bounds
  if (col === 'InBlockTime' || col === 'TakeoffTime') {
    return null;
  }

  // Timeline / generic 'Time' field → bound by [_configStartTime, _configEndTime]
  // (matches runway timeline validation in runTripleValidation)
  if (_configStartTime && _configEndTime) {
    return { minTime: _configStartTime, maxTime: _configEndTime };
  }
  return null;
}

export function getDefaultTime(appState) {
  const s = appState._configStartTime, e = appState._configEndTime;
  if (s && e) {
    const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
    const mid = Math.floor((toMin(s) + toMin(e)) / 2);
    return String(Math.floor(mid / 60) % 24).padStart(2, '0') + ':' + String(mid % 60).padStart(2, '0') + ':00';
  }
  if (s) return String(s).substring(0, 8);
  if (e) return String(e).substring(0, 8);
  return '12:00:00';
}


