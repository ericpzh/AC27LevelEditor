/**
 * Lossless UTF-8 JSON & Base64 codec for GATCARC4 v3 documents.
 *
 * Standard JSON.parse converts all numeric tokens to IEEE-754 float64 before
 * revivers run, losing low bits on 64-bit integers beyond Number.MAX_SAFE_INTEGER
 * (e.g. createdAtUtcTicks = 639247227652411246, Int64.MinValue, UInt64.MaxValue).
 *
 * Representation rules:
 *   - Integer tokens within [-9007199254740991, 9007199254740991] (excluding "-0")
 *     become exact JS `number`s so normal comparisons (`AreaType === 1`) work.
 *   - Integer tokens outside the safe float64 integer range become `BigInt`s,
 *     preserving all 64+ bits exactly and serializing back as unquoted decimals.
 *   - Fractional/exponent tokens (`1.25`, `1e-5`, `-0`) become `RawJsonNumber`
 *     instances that preserve their exact wire token on stringify and coerce via
 *     `valueOf()`.
 */
const { TextDecoder } = require('util');

const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const MAX_SAFE_BI = 9007199254740991n;
const MIN_SAFE_BI = -9007199254740991n;

class RawJsonNumber {
  constructor(raw) {
    this.raw = String(raw);
  }
  valueOf() {
    return Number(this.raw);
  }
  toString() {
    return this.raw;
  }
}

class JsonDecodeError extends Error {
  constructor(message, offset = -1) {
    super(message);
    this.name = 'JsonDecodeError';
    this.offset = offset;
  }
}

/**
 * Strictly decode UTF-8 bytes without replacement characters.
 * @param {Buffer|Uint8Array} bytes
 * @param {string} [label]
 * @returns {string}
 */
function decodeUtf8Strict(bytes, label = 'UTF-8 payload') {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new JsonDecodeError(`${label}: expected Buffer or Uint8Array`);
  }
  try {
    return utf8FatalDecoder.decode(bytes);
  } catch (err) {
    throw new JsonDecodeError(`${label}: invalid UTF-8 byte sequence (${err.message})`);
  }
}

const BASE64_CLEAN_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strictly validate and decode a Base64 string into a Buffer.
 * Node's Buffer.from(..., 'base64') silently ignores invalid characters; this
 * rejects non-Base64 characters, invalid lengths, and non-canonical padding.
 * @param {string} b64
 * @param {string} [label]
 * @returns {Buffer}
 */
function decodeBase64Strict(b64, label = 'Base64 blob') {
  if (typeof b64 !== 'string') {
    throw new JsonDecodeError(`${label}: expected base64 string, got ${typeof b64}`);
  }
  if (b64.length % 4 !== 0 || !BASE64_CLEAN_RE.test(b64)) {
    throw new JsonDecodeError(`${label}: malformed base64 encoding`);
  }
  const buf = Buffer.from(b64, 'base64');
  // Verify canonical round-trip (catches non-zero pad bits or stray '=' in middle)
  if (buf.toString('base64') !== b64) {
    throw new JsonDecodeError(`${label}: non-canonical base64 padding`);
  }
  return buf;
}

/**
 * Parse a JSON string losslessly according to RFC 8259.
 * @param {string} text
 * @param {string} [label]
 * @returns {any}
 */
function parseLosslessJson(text, label = 'JSON') {
  if (typeof text !== 'string') {
    throw new JsonDecodeError(`${label}: expected string input`);
  }
  const len = text.length;
  let pos = 0;

  function fail(msg) {
    throw new JsonDecodeError(`${label}: ${msg} at position ${pos}`, pos);
  }

  function skipWs() {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  }

  function parseString() {
    if (text.charCodeAt(pos) !== 0x22) fail('expected string opening quote');
    pos++; // skip '"'
    let chunkStart = pos;
    let out = '';

    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 0x22) { // '"'
        const result = out.length === 0 ? text.slice(chunkStart, pos) : out + text.slice(chunkStart, pos);
        pos++;
        return result;
      }
      if (c < 0x20) {
        fail('unescaped control character in string');
      }
      if (c === 0x5c) { // '\'
        out += text.slice(chunkStart, pos);
        pos++;
        if (pos >= len) fail('unterminated escape sequence');
        const esc = text.charCodeAt(pos++);
        switch (esc) {
          case 0x22: out += '"'; break;
          case 0x5c: out += '\\'; break;
          case 0x2f: out += '/'; break;
          case 0x62: out += '\b'; break;
          case 0x66: out += '\f'; break;
          case 0x6e: out += '\n'; break;
          case 0x72: out += '\r'; break;
          case 0x74: out += '\t'; break;
          case 0x75: {
            if (pos + 4 > len) fail('truncated \\uXXXX escape');
            const hex = text.slice(pos, pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(`invalid unicode escape \\u${hex}`);
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default:
            fail(`invalid escape character "\\${String.fromCharCode(esc)}"`);
        }
        chunkStart = pos;
        continue;
      }
      pos++;
    }
    fail('unterminated string literal');
  }

  function parseNumber() {
    const start = pos;
    let isFloat = false;
    if (text.charCodeAt(pos) === 0x2d) pos++; // '-'
    if (pos >= len) fail('incomplete number');

    const firstDigit = text.charCodeAt(pos);
    if (firstDigit === 0x30) {
      pos++;
      // Leading zero must not be followed immediately by another digit
      if (pos < len) {
        const next = text.charCodeAt(pos);
        if (next >= 0x30 && next <= 0x39) fail('leading zero in number');
      }
    } else if (firstDigit >= 0x31 && firstDigit <= 0x39) {
      pos++;
      while (pos < len) {
        const d = text.charCodeAt(pos);
        if (d >= 0x30 && d <= 0x39) pos++;
        else break;
      }
    } else {
      fail('invalid number');
    }

    if (pos < len && text.charCodeAt(pos) === 0x2e) { // '.'
      isFloat = true;
      pos++;
      if (pos >= len || text.charCodeAt(pos) < 0x30 || text.charCodeAt(pos) > 0x39) {
        fail('expected digit after decimal point');
      }
      while (pos < len && text.charCodeAt(pos) >= 0x30 && text.charCodeAt(pos) <= 0x39) pos++;
    }

    if (pos < len && (text.charCodeAt(pos) === 0x65 || text.charCodeAt(pos) === 0x45)) { // 'e'/'E'
      isFloat = true;
      pos++;
      if (pos < len && (text.charCodeAt(pos) === 0x2b || text.charCodeAt(pos) === 0x2d)) pos++;
      if (pos >= len || text.charCodeAt(pos) < 0x30 || text.charCodeAt(pos) > 0x39) {
        fail('expected digit in exponent');
      }
      while (pos < len && text.charCodeAt(pos) >= 0x30 && text.charCodeAt(pos) <= 0x39) pos++;
    }

    const raw = text.slice(start, pos);
    if (isFloat || raw === '-0') {
      return new RawJsonNumber(raw);
    }
    // Fast path for <= 15 digits (always safe integer)
    const digitLen = raw.charCodeAt(0) === 0x2d ? raw.length - 1 : raw.length;
    if (digitLen <= 15) {
      return Number(raw);
    }
    const bi = BigInt(raw);
    if (bi >= MIN_SAFE_BI && bi <= MAX_SAFE_BI) {
      return Number(raw);
    }
    return bi;
  }

  function parseArray() {
    pos++; // skip '['
    skipWs();
    const arr = [];
    if (pos < len && text.charCodeAt(pos) === 0x5d) {
      pos++;
      return arr;
    }
    while (pos < len) {
      arr.push(parseValue());
      skipWs();
      if (pos >= len) fail('unterminated array');
      const c = text.charCodeAt(pos);
      if (c === 0x2c) { // ','
        pos++;
        skipWs();
        if (pos < len && text.charCodeAt(pos) === 0x5d) fail('trailing comma in array');
        continue;
      }
      if (c === 0x5d) { // ']'
        pos++;
        return arr;
      }
      fail('expected "," or "]" in array');
    }
    fail('unterminated array');
  }

  function parseObject() {
    pos++; // skip '{'
    skipWs();
    const obj = {};
    if (pos < len && text.charCodeAt(pos) === 0x7d) {
      pos++;
      return obj;
    }
    while (pos < len) {
      if (text.charCodeAt(pos) !== 0x22) fail('expected string key in object');
      const key = parseString();
      skipWs();
      if (pos >= len || text.charCodeAt(pos) !== 0x3a) fail('expected ":" after object key');
      pos++;
      skipWs();
      const val = parseValue();
      if (key === '__proto__') {
        Object.defineProperty(obj, key, { value: val, enumerable: true, configurable: true, writable: true });
      } else {
        obj[key] = val;
      }
      skipWs();
      if (pos >= len) fail('unterminated object');
      const c = text.charCodeAt(pos);
      if (c === 0x2c) {
        pos++;
        skipWs();
        if (pos < len && text.charCodeAt(pos) === 0x7d) fail('trailing comma in object');
        continue;
      }
      if (c === 0x7d) {
        pos++;
        return obj;
      }
      fail('expected "," or "}" in object');
    }
    fail('unterminated object');
  }

  function parseValue() {
    skipWs();
    if (pos >= len) fail('unexpected end of JSON input');
    const c = text.charCodeAt(pos);
    if (c === 0x7b) return parseObject(); // '{'
    if (c === 0x5b) return parseArray();  // '['
    if (c === 0x22) return parseString(); // '"'
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return parseNumber();
    if (c === 0x74 && text.startsWith('true', pos)) { pos += 4; return true; }
    if (c === 0x66 && text.startsWith('false', pos)) { pos += 5; return false; }
    if (c === 0x6e && text.startsWith('null', pos)) { pos += 4; return null; }
    fail(`unexpected token "${text[pos]}"`);
  }

  const root = parseValue();
  skipWs();
  if (pos !== len) fail('unexpected trailing characters');
  return root;
}

/**
 * Serialize a JS value (with BigInt / RawJsonNumber support) to compact UTF-8 JSON.
 * Throws on non-finite numbers (`NaN`, `Infinity`) or `undefined` root values.
 * @param {any} value
 * @returns {string}
 */
function stringifyLosslessJson(value) {
  const chunks = [];

  function write(val) {
    if (val === null) {
      chunks.push('null');
      return;
    }
    const t = typeof val;
    if (t === 'string') {
      chunks.push(JSON.stringify(val));
      return;
    }
    if (t === 'boolean') {
      chunks.push(val ? 'true' : 'false');
      return;
    }
    if (t === 'number') {
      if (!Number.isFinite(val)) {
        throw new TypeError(`Cannot serialize non-finite number to v3 JSON: ${val}`);
      }
      chunks.push(Object.is(val, -0) ? '0' : String(val));
      return;
    }
    if (t === 'bigint') {
      chunks.push(val.toString());
      return;
    }
    if (val instanceof RawJsonNumber) {
      chunks.push(val.raw);
      return;
    }
    if (Array.isArray(val)) {
      chunks.push('[');
      for (let i = 0; i < val.length; i++) {
        if (i > 0) chunks.push(',');
        if (val[i] === undefined) chunks.push('null');
        else write(val[i]);
      }
      chunks.push(']');
      return;
    }
    if (t === 'object') {
      chunks.push('{');
      const keys = Object.keys(val);
      // Ensure $id / $type / $ref metadata precede any numeric-index keys if present
      if (keys.length > 1 && (Object.prototype.hasOwnProperty.call(val, '$id') || Object.prototype.hasOwnProperty.call(val, '$type'))) {
        const first = keys[0];
        if (first !== '$id' && first !== '$type' && first !== 'id') {
          keys.sort((a, b) => {
            const rank = (k) => (k === '$id' ? 0 : k === '$type' ? 1 : 2);
            return rank(a) - rank(b);
          });
        }
      }
      let emitted = false;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const kv = val[k];
        if (kv === undefined) continue;
        if (emitted) chunks.push(',');
        emitted = true;
        chunks.push(JSON.stringify(k), ':');
        write(kv);
      }
      chunks.push('}');
      return;
    }
    throw new TypeError(`Unsupported value type in v3 JSON: ${t}`);
  }

  write(value);
  return chunks.join('');
}

function parseUtf8LosslessJson(bytes, label = 'JSON payload') {
  const text = decodeUtf8Strict(bytes, label);
  return { text, value: parseLosslessJson(text, label) };
}

function parseBase64LosslessJson(b64, label = 'Base64 JSON blob') {
  const bytes = decodeBase64Strict(b64, label);
  const text = decodeUtf8Strict(bytes, label);
  return { bytes, text, value: parseLosslessJson(text, label) };
}

function encodeBase64LosslessJson(value) {
  const text = stringifyLosslessJson(value);
  return Buffer.from(text, 'utf8').toString('base64');
}

module.exports = {
  RawJsonNumber,
  JsonDecodeError,
  MAX_SAFE_BI,
  MIN_SAFE_BI,
  decodeUtf8Strict,
  decodeBase64Strict,
  parseLosslessJson,
  stringifyLosslessJson,
  parseUtf8LosslessJson,
  parseBase64LosslessJson,
  encodeBase64LosslessJson,
};
