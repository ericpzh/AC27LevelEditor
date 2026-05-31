/**
 * Time conversion utilities — Newtonsoft.Json DateTime ticks ↔ HH:MM:SS strings.
 */
const { NET_EPOCH_OFFSET, TICKS_PER_SECOND, TICKS_PER_DAY, FALLBACK_BASE_DATE_TICKS, AIRCRAFT_DESIGNATOR_MAP } = require('./constants');

// ─── Designator guesser ──────────────────────────────────
function _guessDesignator(aircraftType) {
  if (!aircraftType) return null;
  const key = aircraftType.trim().toUpperCase();
  if (AIRCRAFT_DESIGNATOR_MAP[key]) return AIRCRAFT_DESIGNATOR_MAP[key];
  if (/^[A-Z]\d{2,3}[A-Z]?$/.test(key)) return key;
  for (const prefix of ['BOEING ', 'AIRBUS ', 'EMBRAER ', 'BOMBARDIER ']) {
    if (key.startsWith(prefix)) {
      const suffix = key.substring(prefix.length);
      if (AIRCRAFT_DESIGNATOR_MAP[suffix]) return AIRCRAFT_DESIGNATOR_MAP[suffix];
      if (/^[A-Z]\d{2,3}/.test(suffix)) return suffix;
    }
  }
  return null;
}

// ─── Tick ↔ Time conversion ─────────────────────────────
function ticksToTime(ticks) {
  if (ticks === 0 || ticks === '0' || ticks === 0n) return '';
  const ticksBig = BigInt(ticks);
  const ms = Number((ticksBig - NET_EPOCH_OFFSET) / 10000n);
  const d = new Date(ms);
  return d.toISOString().substring(11, 19);
}

function timeToTicks(timeStr, baseDateTicks) {
  if (!timeStr || !timeStr.trim()) return 0;
  try {
    const parts = timeStr.trim().split(':').map(Number);
    if (parts.length !== 3) return 0;
    const totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    const timeOfDayTicks = totalSeconds * Number(TICKS_PER_SECOND);
    return baseDateTicks ? baseDateTicks + timeOfDayTicks : timeOfDayTicks;
  } catch { return 0; }
}

function ticksToString(ticks) {
  return String(ticks);
}

// ─── Base date extraction from original ACL blocks ──────
function _extractBaseDateTicks(originalBlocks) {
  const { FIELDS } = require('./constants');
  for (const block of originalBlocks) {
    for (const [fn, ft] of FIELDS) {
      if (ft === 'time') {
        const m = block.match(new RegExp(`"${fn}"\\s*:\\s*\\{\\s*"\\$type"\\s*:\\s*(\\d+)\\s*,\\s*(-?\\d+)\\s*\\}`));
        if (m) {
          const absTicks = BigInt(m[2]);
          if (absTicks > TICKS_PER_DAY) {
            return Number((absTicks / TICKS_PER_DAY) * TICKS_PER_DAY);
          }
        }
      }
    }
  }
  return FALLBACK_BASE_DATE_TICKS;
}

function _extractBaseDateFromText(text) {
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

module.exports = {
  _guessDesignator,
  ticksToTime, timeToTicks, ticksToString,
  _extractBaseDateTicks, _extractBaseDateFromText,
};
