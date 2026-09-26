'use strict';

// ─── Minimal endian/binary reader for Unity serialized files ──────────────
// Deliberately tiny and dependency-free. Unity stores multi-byte ints and
// floats in the file's declared endianness, so every accessor is endian-aware.
// 64-bit integers come back as BigInt (path IDs are 64-bit hashes and must not
// be truncated to a double).

const O = {
  '<': { i16: 'readInt16LE', u16: 'readUInt16LE', i32: 'readInt32LE', u32: 'readUInt32LE', i64: 'readBigInt64LE', u64: 'readBigUInt64LE', f32: 'readFloatLE', f64: 'readDoubleLE' },
  '>': { i16: 'readInt16BE', u16: 'readUInt16BE', i32: 'readInt32BE', u32: 'readUInt32BE', i64: 'readBigInt64BE', u64: 'readBigUInt64BE', f32: 'readFloatBE', f64: 'readDoubleBE' },
};

class BinaryReader {
  /** @param {Buffer|Uint8Array} buf @param {"<"|">"} [endian] */
  constructor(buf, endian) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    this.length = this.buf.length;
    this.pos = 0;
    this._endian = endian === '>' ? '>' : '<';
  }

  get endian() { return this._endian; }
  set endian(v) { this._endian = v === '>' ? '>' : '<'; }

  get position() { return this.pos; }
  set position(v) { this.pos = v; }

  _m() { return O[this._endian]; }
  _need(n) {
    if (this.pos + n > this.length) throw new RangeError(`read past end (need ${n} at ${this.pos}/${this.length})`);
  }

  u8() { this._need(1); const v = this.buf.readUInt8(this.pos); this.pos += 1; return v; }
  i8() { this._need(1); const v = this.buf.readInt8(this.pos); this.pos += 1; return v; }
  bool() { return this.u8() !== 0; }

  i16() { this._need(2); const v = this.buf[this._m().i16](this.pos); this.pos += 2; return v; }
  u16() { this._need(2); const v = this.buf[this._m().u16](this.pos); this.pos += 2; return v; }
  i32() { this._need(4); const v = this.buf[this._m().i32](this.pos); this.pos += 4; return v; }
  u32() { this._need(4); const v = this.buf[this._m().u32](this.pos); this.pos += 4; return v; }
  i64() { this._need(8); const v = this.buf[this._m().i64](this.pos); this.pos += 8; return v; }
  u64() { this._need(8); const v = this.buf[this._m().u64](this.pos); this.pos += 8; return v; }
  f32() { this._need(4); const v = this.buf[this._m().f32](this.pos); this.pos += 4; return v; }
  f64() { this._need(8); const v = this.buf[this._m().f64](this.pos); this.pos += 8; return v; }

  /** A view into the underlying buffer (no copy). */
  bytes(n) { this._need(n); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }

  /** NUL-terminated UTF-8 string. */
  stringToNull() {
    const end = this.buf.indexOf(0, this.pos);
    if (end < 0) { const s = this.buf.toString('utf8', this.pos); this.pos = this.length; return s; }
    const s = this.buf.toString('utf8', this.pos, end);
    this.pos = end + 1;
    return s;
  }

  /** Unity's "aligned string": int32 length, bytes, then pad to 4. */
  alignedString() {
    const len = this.i32();
    if (len > 0 && len <= this.length - this.pos) {
      const s = this.buf.toString('utf8', this.pos, this.pos + len);
      this.pos += len;
      this.align(4);
      return s;
    }
    return '';
  }

  /** int32-length-prefixed byte blob (TypelessData). */
  byteArray() { return this.bytes(this.i32()); }

  align(n = 4) { const a = n || 4; this.pos += (a - (this.pos % a)) % a; }
}

module.exports = { BinaryReader, READ_METHODS: O };
