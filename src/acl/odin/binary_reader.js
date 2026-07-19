/**
 * OdinSerializer binary format reader — walks a payload buffer linearly and drives
 * a sink with the same event vocabulary as Odin's IDataWriter. Faithful port of the
 * byte layout in BinaryDataWriter.cs (TeamSirenix/odin-serializer, Apache-2.0).
 *
 * Layout summary (all integers little-endian):
 *   string        = [flag: 0 = 8-bit, 1 = UTF-16LE][int32 charCount][chars]
 *   type entry    = TypeName(0x2F) + int32 newId + string name   (first occurrence)
 *                 | TypeID(0x30) + int32 id                      (cached)
 *                 | UnnamedNull(0x2E)                            (no type)
 *   ref node      = 0x01/0x02 [+name] + type entry + int32 refId ... EndOfNode(0x05)
 *   struct node   = 0x03/0x04 [+name] + type entry               ... EndOfNode(0x05)
 *   array         = StartOfArray(0x06) + int64 length            ... EndOfArray(0x07)
 *   prim. array   = PrimitiveArray(0x08) + int32 count + int32 bytesPerElement + raw
 *   primitives    = entry byte [+name] + fixed-size LE value
 */

const { BinaryEntryType: T, EntryTypeName } = require('./binary_entry_types');
const { guidBytesToString, decimalBytesToString } = require('./dotnet_values');

class OdinBinaryReader {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
    this.types = new Map(); // typeId -> assembly-qualified name
  }

  error(msg) {
    return new Error(`Odin binary parse error at offset 0x${this.pos.toString(16)}: ${msg}`);
  }

  need(n) {
    if (this.pos + n > this.buf.length) {
      throw this.error(`unexpected end of data (need ${n} bytes, have ${this.buf.length - this.pos})`);
    }
  }

  u8() { this.need(1); return this.buf[this.pos++]; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i64() { this.need(8); const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return v; }
  u64() { this.need(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }
  f32() { this.need(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  i16() { this.need(2); const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v; }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  i8() { this.need(1); const v = this.buf.readInt8(this.pos); return (this.pos++, v); }

  readString() {
    const flag = this.u8();
    if (flag !== 0 && flag !== 1) {
      throw this.error(`invalid string encoding flag 0x${flag.toString(16)}`);
    }
    const charCount = this.i32();
    if (charCount < 0) throw this.error(`negative string length ${charCount}`);
    const byteCount = flag === 1 ? charCount * 2 : charCount;
    this.need(byteCount);
    const str = flag === 1
      ? this.buf.toString('utf16le', this.pos, this.pos + byteCount)
      : this.buf.toString('latin1', this.pos, this.pos + byteCount);
    this.pos += byteCount;
    return str;
  }

  readGuid() { this.need(16); const s = guidBytesToString(this.buf, this.pos); this.pos += 16; return s; }

  /** Reads a type entry (TypeName / TypeID / UnnamedNull). Returns {id, name, isNew} or null. */
  readTypeEntry() {
    const b = this.u8();
    if (b === T.UnnamedNull) return null;
    if (b === T.TypeName) {
      const id = this.i32();
      const name = this.readString();
      this.types.set(id, name);
      return { id, name, isNew: true };
    }
    if (b === T.TypeID) {
      const id = this.i32();
      if (!this.types.has(id)) throw this.error(`TypeID references unknown type id ${id}`);
      return { id, name: this.types.get(id), isNew: false };
    }
    throw this.error(`expected type entry, got 0x${b.toString(16)} (${EntryTypeName[b] || 'unknown'})`);
  }

  /**
   * Parse one full document (a single root entry and everything nested in it),
   * driving `sink`. Throws if data remains afterwards (other than EndOfStream).
   */
  readDocument(sink) {
    this.readEntry(sink, 0);
    if (this.pos < this.buf.length && this.buf[this.pos] === T.EndOfStream) this.pos++;
    if (this.pos !== this.buf.length) {
      throw this.error(`trailing data after root entry (${this.buf.length - this.pos} bytes)`);
    }
  }

  /** Reads one entry. `depth` guards runaway recursion. Returns false on end-of-scope markers. */
  readEntry(sink, depth) {
    if (depth > 512) throw this.error('node nesting exceeds 512 levels');
    const entryOffset = this.pos;
    const b = this.u8();

    switch (b) {
      case T.NamedStartOfReferenceNode:
      case T.UnnamedStartOfReferenceNode: {
        const name = b === T.NamedStartOfReferenceNode ? this.readString() : null;
        const typeRef = this.readTypeEntry();
        const id = this.i32();
        sink.beginReferenceNode(name, typeRef, id);
        this.readNodeBody(sink, depth);
        sink.endNode();
        return true;
      }
      case T.NamedStartOfStructNode:
      case T.UnnamedStartOfStructNode: {
        const name = b === T.NamedStartOfStructNode ? this.readString() : null;
        const typeRef = this.readTypeEntry();
        sink.beginStructNode(name, typeRef);
        this.readNodeBody(sink, depth);
        sink.endNode();
        return true;
      }
      case T.StartOfArray: {
        const length = this.i64();
        sink.beginArrayNode(length);
        // Array elements are entries until EndOfArray
        for (;;) {
          this.need(1);
          if (this.buf[this.pos] === T.EndOfArray) { this.pos++; break; }
          this.readEntry(sink, depth + 1);
        }
        sink.endArrayNode();
        return true;
      }
      case T.PrimitiveArray: {
        const count = this.i32();
        const bytesPerElement = this.i32();
        if (count < 0 || bytesPerElement <= 0) {
          throw this.error(`invalid primitive array header (count=${count}, bpe=${bytesPerElement})`);
        }
        const byteCount = count * bytesPerElement;
        this.need(byteCount);
        const raw = this.buf.subarray(this.pos, this.pos + byteCount);
        this.pos += byteCount;
        sink.writePrimitiveArray(count, bytesPerElement, raw);
        return true;
      }

      case T.NamedSByte: case T.UnnamedSByte: {
        const name = b === T.NamedSByte ? this.readString() : null;
        sink.writeSByte(name, this.i8()); return true;
      }
      case T.NamedByte: case T.UnnamedByte: {
        const name = b === T.NamedByte ? this.readString() : null;
        sink.writeByte(name, this.u8()); return true;
      }
      case T.NamedShort: case T.UnnamedShort: {
        const name = b === T.NamedShort ? this.readString() : null;
        sink.writeInt16(name, this.i16()); return true;
      }
      case T.NamedUShort: case T.UnnamedUShort: {
        const name = b === T.NamedUShort ? this.readString() : null;
        sink.writeUInt16(name, this.u16()); return true;
      }
      case T.NamedInt: case T.UnnamedInt: {
        const name = b === T.NamedInt ? this.readString() : null;
        sink.writeInt32(name, this.i32()); return true;
      }
      case T.NamedUInt: case T.UnnamedUInt: {
        const name = b === T.NamedUInt ? this.readString() : null;
        sink.writeUInt32(name, this.u32()); return true;
      }
      case T.NamedLong: case T.UnnamedLong: {
        const name = b === T.NamedLong ? this.readString() : null;
        sink.writeInt64(name, this.i64()); return true;
      }
      case T.NamedULong: case T.UnnamedULong: {
        const name = b === T.NamedULong ? this.readString() : null;
        sink.writeUInt64(name, this.u64()); return true;
      }
      case T.NamedFloat: case T.UnnamedFloat: {
        const name = b === T.NamedFloat ? this.readString() : null;
        sink.writeSingle(name, this.f32()); return true;
      }
      case T.NamedDouble: case T.UnnamedDouble: {
        const name = b === T.NamedDouble ? this.readString() : null;
        sink.writeDouble(name, this.f64()); return true;
      }
      case T.NamedDecimal: case T.UnnamedDecimal: {
        const name = b === T.NamedDecimal ? this.readString() : null;
        this.need(16);
        const text = decimalBytesToString(this.buf, this.pos);
        this.pos += 16;
        sink.writeDecimal(name, text); return true;
      }
      case T.NamedChar: case T.UnnamedChar: {
        const name = b === T.NamedChar ? this.readString() : null;
        sink.writeChar(name, this.u16()); return true;
      }
      case T.NamedString: case T.UnnamedString: {
        const name = b === T.NamedString ? this.readString() : null;
        sink.writeString(name, this.readString()); return true;
      }
      case T.NamedGuid: case T.UnnamedGuid: {
        const name = b === T.NamedGuid ? this.readString() : null;
        sink.writeGuid(name, this.readGuid()); return true;
      }
      case T.NamedBoolean: case T.UnnamedBoolean: {
        const name = b === T.NamedBoolean ? this.readString() : null;
        sink.writeBoolean(name, this.u8() !== 0); return true;
      }
      case T.NamedNull: case T.UnnamedNull: {
        const name = b === T.NamedNull ? this.readString() : null;
        sink.writeNull(name); return true;
      }
      case T.NamedInternalReference: case T.UnnamedInternalReference: {
        const name = b === T.NamedInternalReference ? this.readString() : null;
        sink.writeInternalReference(name, this.i32()); return true;
      }
      case T.NamedExternalReferenceByIndex: case T.UnnamedExternalReferenceByIndex: {
        const name = b === T.NamedExternalReferenceByIndex ? this.readString() : null;
        sink.writeExternalIndex(name, this.i32()); return true;
      }
      case T.NamedExternalReferenceByGuid: case T.UnnamedExternalReferenceByGuid: {
        const name = b === T.NamedExternalReferenceByGuid ? this.readString() : null;
        sink.writeExternalGuid(name, this.readGuid()); return true;
      }
      case T.NamedExternalReferenceByString: case T.UnnamedExternalReferenceByString: {
        const name = b === T.NamedExternalReferenceByString ? this.readString() : null;
        sink.writeExternalString(name, this.readString()); return true;
      }

      default:
        this.pos = entryOffset;
        throw this.error(`unexpected entry byte 0x${b.toString(16)} (${EntryTypeName[b] || 'unknown'})`);
    }
  }

  /** Reads node children until EndOfNode. */
  readNodeBody(sink, depth) {
    for (;;) {
      this.need(1);
      if (this.buf[this.pos] === T.EndOfNode) { this.pos++; return; }
      this.readEntry(sink, depth + 1);
    }
  }
}

/** Convenience: parse `buffer` (an Odin binary payload) into `sink`. */
function readBinary(buffer, sink) {
  new OdinBinaryReader(buffer).readDocument(sink);
}

module.exports = { OdinBinaryReader, readBinary };
