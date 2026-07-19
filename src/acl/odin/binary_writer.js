/**
 * OdinSerializer binary format writer sink — consumes the entry-event stream
 * (typically from json_reader) and produces an Odin binary payload, byte-compatible
 * with BinaryDataWriter.cs (TeamSirenix/odin-serializer, Apache-2.0).
 *
 * Note: the game's Odin build writes ALL strings as 16-bit
 * (CompressStringsTo8BitWhenPossible = false), so this writer does too.
 */

const { BinaryEntryType: T } = require('./binary_entry_types');
const { guidStringToBytes, decimalStringToBytes } = require('./dotnet_values');

class GrowBuffer {
  constructor(initial = 1 << 20) {
    this.buf = Buffer.alloc(initial);
    this.len = 0;
  }

  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = Buffer.alloc(cap);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  u8(v) { this.ensure(1); this.buf[this.len++] = v; }
  i8(v) { this.ensure(1); this.buf.writeInt8(v, this.len); this.len += 1; }
  i16(v) { this.ensure(2); this.buf.writeInt16LE(v, this.len); this.len += 2; }
  u16(v) { this.ensure(2); this.buf.writeUInt16LE(v, this.len); this.len += 2; }
  i32(v) { this.ensure(4); this.buf.writeInt32LE(v, this.len); this.len += 4; }
  u32(v) { this.ensure(4); this.buf.writeUInt32LE(v, this.len); this.len += 4; }
  i64(v) { this.ensure(8); this.buf.writeBigInt64LE(BigInt(v), this.len); this.len += 8; }
  u64(v) { this.ensure(8); this.buf.writeBigUInt64LE(BigInt(v), this.len); this.len += 8; }
  f32(v) { this.ensure(4); this.buf.writeFloatLE(v, this.len); this.len += 4; }
  f64(v) { this.ensure(8); this.buf.writeDoubleLE(v, this.len); this.len += 8; }
  bytes(b) { this.ensure(b.length); b.copy(this.buf, this.len); this.len += b.length; }
  result() { return this.buf.subarray(0, this.len); }
}

class OdinBinaryWriter {
  constructor() {
    this.w = new GrowBuffer();
    this.types = new Map(); // type name -> id
    this.usedTypeIds = new Map(); // id -> type name
  }

  getBuffer() { return this.w.result(); }

  // string = [flag 1][int32 charCount][UTF-16LE chars] — game always writes 16-bit
  writeStringValue(str) {
    this.w.u8(1);
    this.w.i32(str.length);
    this.w.bytes(Buffer.from(str, 'utf16le'));
  }

  // entry byte + optional name (Named variant = Unnamed variant - 1 in the enum)
  entryHeader(unnamedType, name) {
    if (name !== null && name !== undefined) {
      this.w.u8(unnamedType - 1);
      this.writeStringValue(name);
    } else {
      this.w.u8(unnamedType);
    }
  }

  // BinaryDataWriter.WriteType — source ids are authoritative (legacy text files
  // can have gaps in the id sequence); auto-assign only when the source has none.
  writeTypeEntry(typeRef) {
    if (!typeRef) { this.w.u8(T.UnnamedNull); return; }
    if (this.types.has(typeRef.name)) {
      const id = this.types.get(typeRef.name);
      if (typeRef.id !== undefined && typeRef.id !== id) {
        throw new Error(`Type id mismatch for "${typeRef.name}": source says ${typeRef.id}, writer has ${id}`);
      }
      this.w.u8(T.TypeID);
      this.w.i32(id);
    } else {
      let id = typeRef.id;
      if (id === undefined) {
        id = this.types.size;
        while (this.usedTypeIds.has(id)) id++;
      } else if (this.usedTypeIds.has(id)) {
        throw new Error(`Type id ${id} claimed by both "${this.usedTypeIds.get(id)}" and "${typeRef.name}"`);
      }
      this.types.set(typeRef.name, id);
      this.usedTypeIds.set(id, typeRef.name);
      this.w.u8(T.TypeName);
      this.w.i32(id);
      this.writeStringValue(typeRef.name);
    }
  }

  // ── sink interface ──────────────────────────────────────────────────────

  beginReferenceNode(name, typeRef, id) {
    this.entryHeader(T.UnnamedStartOfReferenceNode, name);
    this.writeTypeEntry(typeRef);
    this.w.i32(id);
  }

  beginStructNode(name, typeRef) {
    this.entryHeader(T.UnnamedStartOfStructNode, name);
    this.writeTypeEntry(typeRef);
  }

  endNode() { this.w.u8(T.EndOfNode); }

  beginArrayNode(length) {
    this.w.u8(T.StartOfArray);
    this.w.i64(length);
  }

  endArrayNode() { this.w.u8(T.EndOfArray); }

  writePrimitiveArray(count, bytesPerElement, raw) {
    this.w.u8(T.PrimitiveArray);
    this.w.i32(count);
    this.w.i32(bytesPerElement);
    this.w.bytes(raw);
  }

  writeSByte(name, v) { this.entryHeader(T.UnnamedSByte, name); this.w.i8(Number(v)); }
  writeByte(name, v) { this.entryHeader(T.UnnamedByte, name); this.w.u8(Number(v)); }
  writeInt16(name, v) { this.entryHeader(T.UnnamedShort, name); this.w.i16(Number(v)); }
  writeUInt16(name, v) { this.entryHeader(T.UnnamedUShort, name); this.w.u16(Number(v)); }
  writeInt32(name, v) { this.entryHeader(T.UnnamedInt, name); this.w.i32(Number(v)); }
  writeUInt32(name, v) { this.entryHeader(T.UnnamedUInt, name); this.w.u32(Number(v)); }
  writeInt64(name, v) { this.entryHeader(T.UnnamedLong, name); this.w.i64(v); }
  writeUInt64(name, v) { this.entryHeader(T.UnnamedULong, name); this.w.u64(v); }
  writeSingle(name, v) { this.entryHeader(T.UnnamedFloat, name); this.w.f32(v); }
  writeDouble(name, v) { this.entryHeader(T.UnnamedDouble, name); this.w.f64(v); }
  writeDecimal(name, text) { this.entryHeader(T.UnnamedDecimal, name); this.w.bytes(decimalStringToBytes(text)); }
  writeChar(name, code) { this.entryHeader(T.UnnamedChar, name); this.w.u16(code); }
  writeString(name, v) { this.entryHeader(T.UnnamedString, name); this.writeStringValue(v); }
  writeGuid(name, guidStr) { this.entryHeader(T.UnnamedGuid, name); this.w.bytes(guidStringToBytes(guidStr)); }
  writeBoolean(name, v) { this.entryHeader(T.UnnamedBoolean, name); this.w.u8(v ? 1 : 0); }
  writeNull(name) { this.entryHeader(T.UnnamedNull, name); }
  writeInternalReference(name, id) { this.entryHeader(T.UnnamedInternalReference, name); this.w.i32(id); }
  writeExternalIndex(name, index) { this.entryHeader(T.UnnamedExternalReferenceByIndex, name); this.w.i32(index); }
  writeExternalGuid(name, guidStr) { this.entryHeader(T.UnnamedExternalReferenceByGuid, name); this.w.bytes(guidStringToBytes(guidStr)); }
  writeExternalString(name, str) { this.entryHeader(T.UnnamedExternalReferenceByString, name); this.writeStringValue(str); }
}

module.exports = { OdinBinaryWriter };
