/**
 * .NET value formatting/parsing helpers shared by the Odin binary<->JSON transcoders.
 *
 * The game's Odin JSON writer formats numbers with .NET's round-trip ("R") format and
 * Guids with the "D" format. These helpers reproduce that presentation from JS numbers
 * so decoded text matches the game's original text style, and parse it back losslessly.
 */

// ─── Guid: 16 raw bytes (.NET Guid memory layout) <-> "D" format string ───────
// .NET Guid layout: int32 a (LE), int16 b (LE), int16 c (LE), bytes d..k in order.
// String form: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee (lowercase hex for "D").

function guidBytesToString(buf, offset) {
  const hex = (i) => buf[offset + i].toString(16).padStart(2, '0');
  return (
    hex(3) + hex(2) + hex(1) + hex(0) + '-' +
    hex(5) + hex(4) + '-' +
    hex(7) + hex(6) + '-' +
    hex(8) + hex(9) + '-' +
    hex(10) + hex(11) + hex(12) + hex(13) + hex(14) + hex(15)
  );
}

const RE_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function guidStringToBytes(str) {
  if (!RE_GUID.test(str)) throw new Error(`Invalid Guid literal: "${str}"`);
  const h = str.replace(/-/g, '');
  const b = (i) => parseInt(h.substr(i * 2, 2), 16);
  const out = Buffer.alloc(16);
  // int32 a little-endian
  out[0] = b(3); out[1] = b(2); out[2] = b(1); out[3] = b(0);
  // int16 b, int16 c little-endian
  out[4] = b(5); out[5] = b(4);
  out[6] = b(7); out[7] = b(6);
  // d..k straight
  for (let i = 8; i < 16; i++) out[i] = b(i);
  return out;
}

// ─── .NET decimal: 16 raw bytes <-> "G" string ────────────────────────────────
// .NET decimal struct memory layout (Mono/IL2CPP): int32 flags, int32 hi, int32 lo, int32 mid.
// flags bits 16-23 = scale (0-28), bit 31 = sign. Value = (hi*2^64 + mid*2^32 + lo) / 10^scale.

function decimalBytesToString(buf, offset) {
  const flags = buf.readUInt32LE(offset);
  const hi = buf.readUInt32LE(offset + 4);
  const lo = buf.readUInt32LE(offset + 8);
  const mid = buf.readUInt32LE(offset + 12);
  const scale = (flags >>> 16) & 0xFF;
  const negative = (flags & 0x80000000) !== 0;
  let intVal = (BigInt(hi) << 64n) | (BigInt(mid) << 32n) | BigInt(lo);
  let s = intVal.toString();
  if (scale > 0) {
    if (s.length <= scale) s = s.padStart(scale + 1, '0');
    s = s.slice(0, s.length - scale) + '.' + s.slice(s.length - scale);
  }
  return (negative ? '-' : '') + s;
}

function decimalStringToBytes(str) {
  let s = String(str).trim();
  let negative = false;
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  const dot = s.indexOf('.');
  let scale = 0;
  if (dot >= 0) { scale = s.length - dot - 1; s = s.slice(0, dot) + s.slice(dot + 1); }
  if (scale > 28) throw new Error(`Decimal scale out of range: "${str}"`);
  const intVal = BigInt(s);
  if (intVal >= (1n << 96n)) throw new Error(`Decimal magnitude out of range: "${str}"`);
  const out = Buffer.alloc(16);
  const flags = (scale << 16) | (negative ? 0x80000000 : 0);
  out.writeUInt32LE(flags >>> 0, 0);
  out.writeUInt32LE(Number((intVal >> 64n) & 0xFFFFFFFFn), 4);   // hi
  out.writeUInt32LE(Number(intVal & 0xFFFFFFFFn), 8);            // lo
  out.writeUInt32LE(Number((intVal >> 32n) & 0xFFFFFFFFn), 12);  // mid
  return out;
}

// ─── .NET round-trip ("R") number presentation ────────────────────────────────
// JS toExponential() gives the shortest digits that uniquely identify the double.
// .NET "R" presents those digits in plain decimal within a range, scientific outside:
//   double: scientific when decimal exponent >= 15 or <= -5, e.g. "1E+15", "1E-05"
//   float:  scientific when decimal exponent >=  7 or <= -5
// Exponent is written with sign and at least two digits ("E+07", "E-05").

function presentDotNetR(digits, exp, negative, sciHigh, sciLow) {
  // digits: string of significant digits (no dot), exp: decimal exponent of first digit
  let body;
  if (exp >= sciHigh || exp <= sciLow) {
    body = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
    const absExp = Math.abs(exp);
    body += 'E' + (exp < 0 ? '-' : '+') + String(absExp).padStart(2, '0');
  } else if (exp >= digits.length - 1) {
    body = digits + '0'.repeat(exp - digits.length + 1);
  } else if (exp >= 0) {
    body = digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
  } else {
    body = '0.' + '0'.repeat(-exp - 1) + digits;
  }
  return negative ? '-' + body : body;
}

// Extract significant digits + decimal exponent from a toPrecision() result,
// trimming leading/trailing zeros the way .NET's G-format does.
function splitPrecisionString(s) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(s);
  let digits = m[2] + (m[3] || '');
  let exp = m[4] !== undefined ? parseInt(m[4], 10) + (m[2].length - 1) : m[2].length - 1;
  let lead = 0;
  while (lead < digits.length - 1 && digits[lead] === '0') { lead++; exp--; }
  digits = digits.slice(lead);
  digits = digits.replace(/0+$/, '') || '0';
  return { digits, exp, negative: m[1] === '-' };
}

/**
 * Format a double the way the game's runtime does for double.ToString("R"):
 * legacy .NET Framework/Mono algorithm — try 15 significant digits; if that does
 * not round-trip, use 17 (never 16). Verified against game-written .acl text.
 */
function formatDoubleR(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';

  for (const precision of [15, 17]) {
    const s = value.toPrecision(precision);
    if (precision === 17 || parseFloat(s) === value) {
      const { digits, exp, negative } = splitPrecisionString(s);
      return presentDotNetR(digits, exp, negative, 15, -5);
    }
  }
  /* istanbul ignore next */
  return String(value);
}

/**
 * Format a float32 the way .NET float.ToString("R", InvariantCulture) does:
 * try 7 significant digits; if that doesn't round-trip to the same float, use 9.
 * `value` is the JS number produced by reading the 4-byte float (exact).
 */
function formatSingleR(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';

  for (const precision of [7, 9]) {
    const s = value.toPrecision(precision);
    if (precision === 9 || Math.fround(parseFloat(s)) === value) {
      const { digits, exp, negative } = splitPrecisionString(s);
      return presentDotNetR(digits, exp, negative, 7, -5);
    }
  }
  /* istanbul ignore next */
  return String(value);
}

module.exports = {
  RE_GUID,
  guidBytesToString,
  guidStringToBytes,
  decimalBytesToString,
  decimalStringToBytes,
  formatDoubleR,
  formatSingleR,
};
