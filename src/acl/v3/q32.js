/**
 * Q32.32 SI fixed-point (`GroundAtc.Numerics`), coordinate, wind, angle, and
 * ISO-8601 local wall-clock DateTime conversions for GATCARC4 v3.
 *
 * Wire invariant (`wire.fixed = "si-q32.32-signed-int64"`):
 *   raw_int64 = round(si_value * 2^32), clamped/checked against signed Int64
 *   [-9223372036854775808, 9223372036854775807].
 */
const { RawJsonNumber, MAX_SAFE_BI, MIN_SAFE_BI } = require('./lossless_json');

const Q32_SHIFT = 32n;
const Q32_SCALE_NUM = 4294967296; // 2^32
const Q32_SCALE_BI = 4294967296n;
const Q32_MASK_BI = 0xffffffffn;

const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const UINT64_MIN = 0n;
const UINT64_MAX = 18446744073709551615n;
const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;

// Editor coordinate scale: 1 GU = 100 meters (Config.scaleFactor = 0.01)
const GU_TO_METERS = 100;
const METERS_TO_GU = 0.01;

// Aviation unit constants
const KT_TO_MPS = 1852 / 3600;
const MPS_TO_KT = 3600 / 1852;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

const UNSET_DATETIME_ISO = '0001-01-01T00:00:00';
const DEFAULT_BASE_DATE = '2000-01-01';
const TICKS_EPOCH_2000 = 630822816000000000n; // 2000-01-01T00:00:00 in .NET ticks
const TICKS_PER_SECOND = 10000000n;

function toBigIntStrict(val, label = 'integer') {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') {
    if (!Number.isInteger(val) || !Number.isSafeInteger(val)) {
      throw new RangeError(`${label}: expected safe integer or BigInt, got ${val}`);
    }
    return BigInt(val);
  }
  if (val instanceof RawJsonNumber) {
    if (!/^-?\d+$/.test(val.raw)) {
      throw new RangeError(`${label}: expected integer token, got ${val.raw}`);
    }
    return BigInt(val.raw);
  }
  if (typeof val === 'string' && /^-?\d+$/.test(val.trim())) {
    return BigInt(val.trim());
  }
  throw new RangeError(`${label}: expected integer, got ${typeof val} (${String(val)})`);
}

function fromBigIntToJsonInt(bi) {
  if (bi >= MIN_SAFE_BI && bi <= MAX_SAFE_BI) {
    return Number(bi);
  }
  return bi;
}

function assertSignedInt64(bi, label = 'Int64') {
  if (bi < INT64_MIN || bi > INT64_MAX) {
    throw new RangeError(`${label}: value ${bi.toString()} out of signed Int64 range [${INT64_MIN}, ${INT64_MAX}]`);
  }
  return bi;
}

/**
 * Decode a Q32.32 signed int64 (`number | bigint`) to a JS `number` in SI units.
 * Splits integer and fractional parts in BigInt first so values near Int64 min/max
 * do not overflow or lose precision before shifting.
 */
function decodeQ32(raw, label = 'Fixed64') {
  const bi = assertSignedInt64(toBigIntStrict(raw, label), label);
  if (bi >= 0n) {
    const whole = Number(bi >> Q32_SHIFT);
    const frac = Number(bi & Q32_MASK_BI) / Q32_SCALE_NUM;
    return whole + frac;
  }
  if (bi === INT64_MIN) {
    return -2147483648;
  }
  const pos = -bi;
  const whole = Number(pos >> Q32_SHIFT);
  const frac = Number(pos & Q32_MASK_BI) / Q32_SCALE_NUM;
  return -(whole + frac);
}

/**
 * Encode a finite JS `number` (SI units) into a Q32.32 signed int64 (`number | bigint`).
 * Uses half-away-from-zero / Math.round semantics matching C# conversion and enforces
 * the signed Int64 range [-2^63, 2^63 - 1].
 */
function encodeQ32(siValue, label = 'Fixed64') {
  if (typeof siValue !== 'number' || !Number.isFinite(siValue)) {
    throw new RangeError(`${label}: expected finite number, got ${siValue}`);
  }
  if (siValue === -2147483648) {
    return INT64_MIN; // exact min boundary (-2^31 * 2^32 = -2^63)
  }
  if (siValue < -2147483648 || siValue >= 2147483648) {
    throw new RangeError(`${label}: value ${siValue} overflows Q32.32 signed Int64 range`);
  }
  const neg = siValue < 0;
  const abs = Math.abs(siValue);
  // For moderate values where abs * 2^32 fits safely inside 2^53, direct Math.round is exact
  if (abs < 2097151) { // 2097151 * 2^32 < 9.007e15
    const scaled = Math.round(abs * Q32_SCALE_NUM);
    const bi = neg ? -BigInt(scaled) : BigInt(scaled);
    assertSignedInt64(bi, label);
    return fromBigIntToJsonInt(bi);
  }
  const whole = Math.floor(abs);
  const rem = abs - whole;
  const fracTicks = BigInt(Math.round(rem * Q32_SCALE_NUM));
  let bi = (BigInt(whole) << Q32_SHIFT) + fracTicks;
  if (neg) bi = -bi;
  assertSignedInt64(bi, label);
  return fromBigIntToJsonInt(bi);
}

// ─── Positions & Vectors (Editor GU <-> Wire Position3 meters Q32.32) ─────

function decodePosition3ToGu(tuple) {
  if (!Array.isArray(tuple) || tuple.length !== 3) return null;
  return {
    x: decodeQ32(tuple[0], 'Position3.x') * METERS_TO_GU,
    y: decodeQ32(tuple[1], 'Position3.y') * METERS_TO_GU,
    z: decodeQ32(tuple[2], 'Position3.z') * METERS_TO_GU,
  };
}

function encodeGuToPosition3(pt) {
  if (arguments.length !== 1 || !pt || typeof pt !== 'object' || Array.isArray(pt)) {
    throw new TypeError(
      `encodeGuToPosition3: expected single { x, y, z } object, got ${arguments.length} arg(s) (${typeof pt})`,
    );
  }
  const x = pt.x ?? 0;
  const y = pt.y ?? 0;
  const z = pt.z ?? 0;
  return [
    encodeQ32(x * GU_TO_METERS, 'Position3.x'),
    encodeQ32(y * GU_TO_METERS, 'Position3.y'),
    encodeQ32(z * GU_TO_METERS, 'Position3.z'),
  ];
}

function decodeDirection3(tuple) {
  if (tuple === null || tuple === undefined) return null;
  if (!Array.isArray(tuple) || tuple.length !== 3) return null;
  return {
    x: decodeQ32(tuple[0], 'Direction3.x'),
    y: decodeQ32(tuple[1], 'Direction3.y'),
    z: decodeQ32(tuple[2], 'Direction3.z'),
  };
}

function encodeDirection3(dir) {
  if (arguments.length > 1) {
    throw new TypeError(`encodeDirection3: expected single { x, y, z } object or null, got ${arguments.length} args`);
  }
  if (dir === null || dir === undefined) return null;
  if (typeof dir !== 'object' || Array.isArray(dir)) {
    throw new TypeError(`encodeDirection3: expected { x, y, z } object or null, got ${typeof dir}`);
  }
  return [
    encodeQ32(dir.x ?? 0, 'Direction3.x'),
    encodeQ32(dir.y ?? 0, 'Direction3.y'),
    encodeQ32(dir.z ?? 0, 'Direction3.z'),
  ];
}

// ─── Angles & Wind ────────────────────────────────────────────────────────

function decodeRadiansQ32ToDeg(raw) {
  return decodeQ32(raw, 'angle') * RAD_TO_DEG;
}

function encodeDegToRadiansQ32(deg) {
  return encodeQ32(deg * DEG_TO_RAD, 'angle');
}

function decodeWindDirectionDeg(raw) {
  const deg = Math.round(decodeRadiansQ32ToDeg(raw));
  return ((deg % 360) + 360) % 360;
}

function decodeWindSpeedKnots(raw) {
  return Math.round(decodeQ32(raw, 'wind.speed') * MPS_TO_KT);
}

function encodeWindSpeedFromKnots(knots) {
  return encodeQ32(knots * KT_TO_MPS, 'wind.speed');
}

// ─── ISO-8601 Local Wall-Clock DateTime (no timezone shift) ───────────────

const ISO_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})?$/;

/**
 * Parse a v3 ISO-8601 DateTime string without JS Date local-timezone conversion.
 * Returns null for unset ("0001-01-01T00:00:00") or invalid strings.
 */
function parseIsoWallClock(isoStr) {
  if (typeof isoStr !== 'string' || !isoStr) return null;
  const m = isoStr.match(ISO_LOCAL_RE);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  if (year <= 1) return null; // 0001-01-01T00:00:00 = DateTime.MinValue (unset)
  const hh = m[4];
  const mm = m[5];
  const ss = m[6];
  const fracStr = m[7] || '';
  const hNum = parseInt(hh, 10);
  const mNum = parseInt(mm, 10);
  const sNum = parseInt(ss, 10);
  const fracSec = fracStr ? parseFloat('0.' + fracStr) : 0;
  const secSinceMidnight = hNum * 3600 + mNum * 60 + sNum;
  const exactSecSinceMidnight = secSinceMidnight + fracSec;
  const datePrefix = `${m[1]}-${m[2]}-${m[3]}`;
  const timeHHMMSS = `${hh}:${mm}:${ss}`;
  const timeHHMM = sNum === 0 && !fracStr ? `${hh}:${mm}` : timeHHMMSS;
  // Synthesize .NET ticks relative to 2000-01-01 for callers expecting { ticks, secSinceMidnight, timeString }
  const fracTicks = fracStr ? BigInt((fracStr + '0000000').slice(0, 7)) : 0n;
  const ticks = TICKS_EPOCH_2000 + BigInt(secSinceMidnight) * TICKS_PER_SECOND + fracTicks;
  return {
    datePrefix,
    year,
    hours: hNum,
    minutes: mNum,
    seconds: sNum,
    fracStr,
    secSinceMidnight,
    exactSecSinceMidnight,
    timeString: timeHHMMSS,
    displayTime: timeHHMM,
    ticks,
  };
}

/**
 * Format an editor clock string ("HH:MM" or "HH:MM:SS[.fff]") into a v3 DateTime
 * string ("2000-01-01THH:MM:SS"), or "0001-01-01T00:00:00" when empty/unset.
 */
function formatEditorTimeToIso(timeStr, baseDate = DEFAULT_BASE_DATE) {
  if (!timeStr || typeof timeStr !== 'string') return UNSET_DATETIME_ISO;
  const trimmed = timeStr.trim();
  if (!trimmed) return UNSET_DATETIME_ISO;
  if (ISO_LOCAL_RE.test(trimmed)) return trimmed;
  const m = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  if (!m) {
    throw new Error(`Invalid time string "${timeStr}" (expected HH:MM or HH:MM:SS)`);
  }
  const hh = String(parseInt(m[1], 10)).padStart(2, '0');
  const mm = m[2];
  const ss = m[3] || '00';
  const frac = m[4] ? '.' + m[4] : '';
  return `${baseDate}T${hh}:${mm}:${ss}${frac}`;
}

/**
 * Format fractional seconds since midnight into a v3 ISO DateTime string
 * (matching game's runtime _departureTakeoffTime / _arrivalInBlockTime precision).
 */
function formatSecondsToIso(totalSec, baseDate = DEFAULT_BASE_DATE) {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return UNSET_DATETIME_ISO;
  const daySec = 86400;
  let dayOffset = Math.floor(totalSec / daySec);
  let rem = totalSec - dayOffset * daySec;
  if (rem < 0) { rem += daySec; dayOffset -= 1; }
  // Round to milliseconds (3 decimal places, trimming trailing zeros like Newtonsoft)
  let wholeMs = Math.round(rem * 1000);
  if (wholeMs >= daySec * 1000) {
    wholeMs -= daySec * 1000;
    dayOffset += 1;
  }
  const wholeSec = Math.floor(wholeMs / 1000);
  const ms = wholeMs % 1000;
  const hh = String(Math.floor(wholeSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((wholeSec % 3600) / 60)).padStart(2, '0');
  const ss = String(wholeSec % 60).padStart(2, '0');
  let dateStr = baseDate;
  if (dayOffset !== 0 && /^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
    const [y, mo, d] = baseDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d + dayOffset));
    dateStr = `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }
  if (ms === 0) return `${dateStr}T${hh}:${mm}:${ss}`;
  const frac = String(ms).padStart(3, '0').replace(/0+$/, '');
  return `${dateStr}T${hh}:${mm}:${ss}.${frac}`;
}

module.exports = {
  Q32_SCALE_NUM,
  Q32_SCALE_BI,
  INT64_MIN,
  INT64_MAX,
  UINT64_MIN,
  UINT64_MAX,
  INT32_MIN,
  INT32_MAX,
  GU_TO_METERS,
  METERS_TO_GU,
  KT_TO_MPS,
  MPS_TO_KT,
  DEG_TO_RAD,
  RAD_TO_DEG,
  UNSET_DATETIME_ISO,
  DEFAULT_BASE_DATE,
  toBigIntStrict,
  fromBigIntToJsonInt,
  assertSignedInt64,
  decodeQ32,
  encodeQ32,
  decodePosition3ToGu,
  encodeGuToPosition3,
  decodeDirection3,
  encodeDirection3,
  decodeRadiansQ32ToDeg,
  encodeDegToRadiansQ32,
  decodeWindDirectionDeg,
  decodeWindSpeedKnots,
  encodeWindSpeedFromKnots,
  parseIsoWallClock,
  formatEditorTimeToIso,
  formatSecondsToIso,
};
