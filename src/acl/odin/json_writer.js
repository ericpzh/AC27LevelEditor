/**
 * Odin JSON writer sink — consumes the entry-event stream (from binary_reader or
 * json_reader) and produces Odin-flavored JSON text, replicating the output of
 * OdinSerializer's JsonDataWriter.cs byte for byte:
 *   - CRLF line endings, 4-space-per-node indentation
 *   - "$id" / "$type" ("N|AssemblyQualifiedName" on first use, bare N after)
 *   - "$rlength"/"$rcontent" arrays, "$plength"/"$pcontent" primitive arrays
 *   - bare (unquoted) values for $iref/$eref/$guidref refs, Guids, NaN/Infinity
 *   - \uxxxx escapes for characters outside 0..127, plus \a and \0 escapes
 * This matches the game's original text .acl format, so the editor's existing
 * text pipeline parses decoded output unchanged.
 */

const { formatDoubleR, formatSingleR, guidBytesToString, decimalBytesToString } = require('./dotnet_values');

const CRLF = '\r\n';

// Element parsers/formatters for "$pcontent" primitive arrays, keyed by the
// element type name parsed from the enclosing node's "$type" (before "[]").
const PRIMITIVE_ELEMENTS = {
  'System.SByte': { size: 1, read: (b, o) => String(b.readInt8(o)) },
  'System.Byte': { size: 1, read: (b, o) => String(b.readUInt8(o)) },
  'System.Int16': { size: 2, read: (b, o) => String(b.readInt16LE(o)) },
  'System.UInt16': { size: 2, read: (b, o) => String(b.readUInt16LE(o)) },
  'System.Int32': { size: 4, read: (b, o) => String(b.readInt32LE(o)) },
  'System.UInt32': { size: 4, read: (b, o) => String(b.readUInt32LE(o)) },
  'System.Int64': { size: 8, read: (b, o) => b.readBigInt64LE(o).toString() },
  'System.UInt64': { size: 8, read: (b, o) => b.readBigUInt64LE(o).toString() },
  'System.Single': { size: 4, read: (b, o) => formatSingleR(b.readFloatLE(o)) },
  'System.Double': { size: 8, read: (b, o) => formatDoubleR(b.readDoubleLE(o)) },
  'System.Boolean': { size: 1, read: (b, o) => (b.readUInt8(o) !== 0 ? 'true' : 'false') },
  'System.Char': { size: 2, read: null /* handled as quoted string */ },
  'System.Decimal': { size: 16, read: null /* handled via decimalBytesToString */ },
  'System.Guid': { size: 16, read: null /* handled via guidBytesToString */ },
};

class OdinJsonWriter {
  /**
   * @param {object} [options]
   * @param {(raw: Buffer) => string|null} [options.tryDecodeBlob] — when set, byte[]
   *   primitive arrays whose bytes form a complete nested Odin binary document are
   *   emitted as an inline "$blobdoc": { ... } entry (re-indented) instead of a raw
   *   byte list. Returns null when the bytes are not a decodable document.
   */
  constructor(options = {}) {
    this.out = [];
    this.justStarted = true;
    this.forceNoSeparatorNextLine = false;
    this.seenTypes = new Map(); // type name -> id
    this.usedTypeIds = new Map(); // id -> type name
    this.nodeStack = []; // { typeName: string|null, isArray: bool }
    this.tryDecodeBlob = options.tryDecodeBlob || null;
  }

  getText() { return this.out.join(''); }

  get nodeDepth() { return this.nodeStack.length; }

  // ── JsonDataWriter.StartNewLine ─────────────────────────────────────────
  startNewLine(noSeparator = false) {
    if (this.justStarted) { this.justStarted = false; return; }
    if (!noSeparator && !this.forceNoSeparatorNextLine) this.out.push(',');
    this.forceNoSeparatorNextLine = false;
    this.out.push(CRLF);
    if (this.nodeDepth > 0) this.out.push(' '.repeat(this.nodeDepth * 4));
  }

  // ── JsonDataWriter.WriteEntry ───────────────────────────────────────────
  entry(name, contents) {
    this.startNewLine();
    if (name !== null && name !== undefined) this.out.push('"', name, '": ');
    this.out.push(contents);
  }

  escapeString(str) {
    let r = '';
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c > 127) { r += '\\u' + c.toString(16).padStart(4, '0'); continue; }
      switch (c) {
        case 0x22: r += '\\"'; break;
        case 0x5C: r += '\\\\'; break;
        case 0x07: r += '\\a'; break;
        case 0x08: r += '\\b'; break;
        case 0x0C: r += '\\f'; break;
        case 0x0A: r += '\\n'; break;
        case 0x0D: r += '\\r'; break;
        case 0x09: r += '\\t'; break;
        case 0x00: r += '\\0'; break;
        default: r += str[i];
      }
    }
    return r;
  }

  stringEntry(name, value) {
    this.entry(name, '"' + this.escapeString(value) + '"');
  }

  // ── JsonDataWriter.WriteTypeEntry ───────────────────────────────────────
  writeTypeEntry(typeRef) {
    // typeRef from the source reader: { id?, name }. The source id is authoritative
    // (legacy editor-spliced text files can have gaps in the id sequence); ids are
    // only auto-assigned when the source provided none.
    if (typeRef.id === undefined) {
      // Type written without the id optimization — emit the plain form
      this.stringEntry('$type', typeRef.name);
      return;
    }
    if (this.seenTypes.has(typeRef.name)) {
      const id = this.seenTypes.get(typeRef.name);
      if (id !== typeRef.id) {
        throw new Error(`Type id mismatch for "${typeRef.name}": source says ${typeRef.id}, writer has ${id}`);
      }
      this.entry('$type', String(id));
    } else {
      if (this.usedTypeIds.has(typeRef.id)) {
        throw new Error(`Type id ${typeRef.id} claimed by both "${this.usedTypeIds.get(typeRef.id)}" and "${typeRef.name}"`);
      }
      this.seenTypes.set(typeRef.name, typeRef.id);
      this.usedTypeIds.set(typeRef.id, typeRef.name);
      this.stringEntry('$type', typeRef.id + '|' + typeRef.name);
    }
  }

  currentNodeTypeName() {
    for (let i = this.nodeStack.length - 1; i >= 0; i--) {
      if (this.nodeStack[i].typeName) return this.nodeStack[i].typeName;
      if (!this.nodeStack[i].isArray) return null; // non-array node without type ends the search
    }
    return null;
  }

  // ── sink interface ──────────────────────────────────────────────────────

  beginReferenceNode(name, typeRef, id) {
    this.entry(name, '{');
    this.nodeStack.push({ typeName: typeRef ? typeRef.name : null, isArray: false });
    this.forceNoSeparatorNextLine = true;
    this.entry('$id', String(id));
    if (typeRef) this.writeTypeEntry(typeRef);
  }

  beginStructNode(name, typeRef) {
    this.entry(name, '{');
    this.nodeStack.push({ typeName: typeRef ? typeRef.name : null, isArray: false });
    this.forceNoSeparatorNextLine = true;
    if (typeRef) this.writeTypeEntry(typeRef);
  }

  endNode() {
    this.nodeStack.pop();
    this.startNewLine(true);
    this.out.push('}');
  }

  beginArrayNode(length) {
    this.entry('$rlength', String(length));
    this.entry('$rcontent', '[');
    this.forceNoSeparatorNextLine = true;
    this.nodeStack.push({ typeName: null, isArray: true });
  }

  endArrayNode() {
    this.nodeStack.pop();
    this.startNewLine(true);
    this.out.push(']');
  }

  writePrimitiveArray(count, bytesPerElement, raw) {
    const typeName = this.currentNodeTypeName();
    const elemName = typeName ? typeName.split('[')[0].split(',')[0].trim() : null;
    const spec = elemName ? PRIMITIVE_ELEMENTS[elemName] : null;
    if (!spec) {
      throw new Error(
        `Cannot determine primitive array element type (node type: ${typeName || 'none'}, ` +
        `${count} elements x ${bytesPerElement} bytes)`);
    }
    if (spec.size !== bytesPerElement) {
      throw new Error(
        `Primitive array element size mismatch for ${elemName}: expected ${spec.size}, got ${bytesPerElement}`);
    }

    // Nested serialized documents: the game stores sub-payloads (e.g. ArchiveHeader.StaticData,
    // RuntimeSnapshot.RuntimeData) as byte[] whose bytes are a complete Odin binary document.
    // Emit those inline as "$blobdoc" so the text stays readable and reversible.
    if (this.tryDecodeBlob && elemName === 'System.Byte' && count > 0 &&
        raw[0] === 0x02 /* UnnamedStartOfReferenceNode — every document root */) {
      const innerText = this.tryDecodeBlob(raw);
      if (innerText !== null) {
        this.entry('$blobdoc', '');
        const indent = CRLF + ' '.repeat(this.nodeDepth * 4);
        this.out.push(innerText.split(CRLF).join(indent));
        return;
      }
    }

    this.entry('$plength', String(count));
    this.entry('$pcontent', '[');
    this.forceNoSeparatorNextLine = true;
    this.nodeStack.push({ typeName: null, isArray: true });
    for (let i = 0; i < count; i++) {
      const off = i * bytesPerElement;
      if (elemName === 'System.Char') {
        this.stringEntry(null, String.fromCharCode(raw.readUInt16LE(off)));
      } else if (elemName === 'System.Guid') {
        this.entry(null, guidBytesToString(raw, off));
      } else if (elemName === 'System.Decimal') {
        this.entry(null, decimalBytesToString(raw, off));
      } else {
        this.entry(null, spec.read(raw, off));
      }
    }
    this.nodeStack.pop();
    this.startNewLine(true);
    this.out.push(']');
  }

  // Integer family — JsonDataWriter routes all through WriteInt64/WriteUInt64 ("D" digits)
  writeSByte(name, v) { this.entry(name, String(v)); }
  writeByte(name, v) { this.entry(name, String(v)); }
  writeInt16(name, v) { this.entry(name, String(v)); }
  writeUInt16(name, v) { this.entry(name, String(v)); }
  writeInt32(name, v) { this.entry(name, String(v)); }
  writeUInt32(name, v) { this.entry(name, String(v)); }
  writeInt64(name, v) { this.entry(name, String(v)); }
  writeUInt64(name, v) { this.entry(name, String(v)); }

  writeSingle(name, v) { this.entry(name, formatSingleR(v)); }
  writeDouble(name, v) { this.entry(name, formatDoubleR(v)); }
  writeDecimal(name, text) { this.entry(name, text); }

  writeChar(name, code) { this.stringEntry(name, String.fromCharCode(code)); }
  writeString(name, v) { this.stringEntry(name, v); }
  writeGuid(name, guidStr) { this.entry(name, guidStr); }
  writeBoolean(name, v) { this.entry(name, v ? 'true' : 'false'); }
  writeNull(name) { this.entry(name, 'null'); }

  writeInternalReference(name, id) { this.entry(name, '$iref:' + id); }
  writeExternalIndex(name, index) { this.entry(name, '$eref:' + index); }
  writeExternalGuid(name, guidStr) { this.entry(name, '$guidref:' + guidStr); }
  writeExternalString(name, str) { this.entry(name, '$fstrref:"' + this.escapeString(str) + '"'); }
}

module.exports = { OdinJsonWriter, PRIMITIVE_ELEMENTS };
