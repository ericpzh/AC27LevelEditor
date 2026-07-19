/**
 * Odin JSON reader — parses Odin-flavored JSON text (the game's original text .acl
 * format, as produced by json_writer.js / OdinSerializer's JsonDataWriter) and drives
 * a sink with the same entry-event vocabulary as binary_reader.
 *
 * Handles the format's non-standard constructs: bare $iref/$eref/$guidref/$fstrref
 * values, bare Guid literals, NaN/Infinity, keyless (unnamed) entries inside nodes,
 * \a and \0 string escapes, and "N|Type, Assembly" type registration.
 *
 * Numeric width inference (JSON does not record entry widths — same limitation as
 * OdinSerializer's own JSON format): integers become Int32/Int64/UInt64 by range,
 * anything with a decimal point/exponent becomes Double. Odin's binary reader
 * coerces numeric entry types on load, so this is loss-free for the game.
 */

const { RE_GUID, guidStringToBytes, decimalStringToBytes } = require('./dotnet_values');
const { PRIMITIVE_ELEMENTS } = require('./json_writer');

const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const UINT64_MAX = 18446744073709551615n;

const RE_INTEGER = /^-?\d+$/;
const RE_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

class OdinJsonReader {
  constructor(text) {
    this.text = text;
    this.pos = 0;
    this.types = new Map(); // type id -> name
    this.nodeStack = []; // { typeName: string|null, isArray: bool }
  }

  error(msg) {
    const line = this.text.slice(0, this.pos).split('\n').length;
    return new Error(`Odin JSON parse error at line ${line} (offset ${this.pos}): ${msg}`);
  }

  // Whitespace and (leniently) comma separators
  skipWs() {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ',') this.pos++;
      else break;
    }
  }

  peek() { return this.text[this.pos]; }

  expect(ch) {
    if (this.text[this.pos] !== ch) {
      throw this.error(`expected '${ch}', got '${this.text[this.pos] || 'EOF'}'`);
    }
    this.pos++;
  }

  parseQuotedString() {
    this.expect('"');
    const t = this.text;
    let r = '';
    for (;;) {
      if (this.pos >= t.length) throw this.error('unterminated string');
      const c = t[this.pos++];
      if (c === '"') return r;
      if (c !== '\\') { r += c; continue; }
      const e = t[this.pos++];
      switch (e) {
        case '"': r += '"'; break;
        case '\\': r += '\\'; break;
        case '/': r += '/'; break;
        case 'a': r += '\x07'; break;
        case 'b': r += '\b'; break;
        case 'f': r += '\f'; break;
        case 'n': r += '\n'; break;
        case 'r': r += '\r'; break;
        case 't': r += '\t'; break;
        case '0': r += '\0'; break;
        case 'u': {
          const hex = t.slice(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.error(`invalid \\u escape "\\u${hex}"`);
          r += String.fromCharCode(parseInt(hex, 16));
          this.pos += 4;
          break;
        }
        default: throw this.error(`unknown escape "\\${e}"`);
      }
    }
  }

  // Bare (unquoted) token: read until a structural/whitespace boundary
  parseBareToken() {
    this.skipWsNoComma();
    const t = this.text;
    const start = this.pos;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === ',' || c === '}' || c === ']' || c === '\r' || c === '\n' || c === ' ' || c === '\t') break;
      this.pos++;
    }
    if (this.pos === start) throw this.error('expected a value');
    return t.slice(start, this.pos);
  }

  currentNodeTypeName() {
    for (let i = this.nodeStack.length - 1; i >= 0; i--) {
      if (this.nodeStack[i].typeName) return this.nodeStack[i].typeName;
      if (!this.nodeStack[i].isArray) return null;
    }
    return null;
  }

  /** Parse the single root value and verify nothing follows. */
  parseDocument(sink) {
    this.skipWs();
    this.parseValue(null, sink);
    this.skipWs();
    if (this.pos !== this.text.length) throw this.error('trailing content after root value');
  }

  parseValue(name, sink) {
    this.skipWs();
    const c = this.peek();
    if (c === '{') { this.parseNode(name, sink); return; }
    if (c === '"') { sink.writeString(name, this.parseQuotedString()); return; }
    if (c === '$') { this.parseSigValue(name, sink); return; }
    this.classifyBare(name, this.parseBareToken(), sink);
  }

  // $iref:N, $eref:N, $guidref:G, $fstrref:"s", $strref:"s"
  parseSigValue(name, sink) {
    const t = this.text;
    const colon = t.indexOf(':', this.pos);
    if (colon < 0) throw this.error('malformed $-value');
    const sig = t.slice(this.pos, colon);
    if (sig === '$fstrref' || sig === '$strref') {
      this.pos = colon + 1;
      sink.writeExternalString(name, this.parseQuotedString());
      return;
    }
    const token = this.parseBareToken(); // includes "sig:payload"
    const payload = token.slice(sig.length + 1);
    if (sig === '$iref') {
      if (!RE_INTEGER.test(payload)) throw this.error(`invalid $iref payload "${payload}"`);
      sink.writeInternalReference(name, parseInt(payload, 10));
    } else if (sig === '$eref') {
      if (!RE_INTEGER.test(payload)) throw this.error(`invalid $eref payload "${payload}"`);
      sink.writeExternalIndex(name, parseInt(payload, 10));
    } else if (sig === '$guidref') {
      if (!RE_GUID.test(payload)) throw this.error(`invalid $guidref payload "${payload}"`);
      sink.writeExternalGuid(name, payload);
    } else {
      throw this.error(`unknown $-signature "${sig}"`);
    }
  }

  classifyBare(name, token, sink) {
    if (token === 'null') { sink.writeNull(name); return; }
    if (token === 'true') { sink.writeBoolean(name, true); return; }
    if (token === 'false') { sink.writeBoolean(name, false); return; }
    if (token === 'NaN') { sink.writeDouble(name, NaN); return; }
    if (token === 'Infinity') { sink.writeDouble(name, Infinity); return; }
    if (token === '-Infinity') { sink.writeDouble(name, -Infinity); return; }
    if (token === '-0') { sink.writeDouble(name, -0); return; }
    if (RE_GUID.test(token)) { sink.writeGuid(name, token); return; }
    if (RE_INTEGER.test(token)) {
      const v = BigInt(token);
      if (v >= INT32_MIN && v <= INT32_MAX) sink.writeInt32(name, Number(v));
      else if (v >= INT64_MIN && v <= INT64_MAX) sink.writeInt64(name, v);
      else if (v > INT64_MAX && v <= UINT64_MAX) sink.writeUInt64(name, v);
      else throw this.error(`integer out of range: ${token}`);
      return;
    }
    if (RE_NUMBER.test(token)) { sink.writeDouble(name, parseFloat(token)); return; }
    throw this.error(`unrecognized value token "${token}"`);
  }

  parseTypeRefFromValue() {
    this.skipWs();
    if (this.peek() === '"') {
      const s = this.parseQuotedString();
      const pipe = s.indexOf('|');
      if (pipe < 0) {
        // Type written without id optimization — no registry involvement
        return { name: s };
      }
      const id = parseInt(s.slice(0, pipe), 10);
      const typeName = s.slice(pipe + 1);
      this.types.set(id, typeName);
      return { id, name: typeName, isNew: true };
    }
    const token = this.parseBareToken();
    if (!RE_INTEGER.test(token)) throw this.error(`invalid $type value "${token}"`);
    const id = parseInt(token, 10);
    if (!this.types.has(id)) throw this.error(`$type references unknown type id ${id}`);
    return { id, name: this.types.get(id), isNew: false };
  }

  /** Peek: if a quoted key followed by ':' is next, consume and return it; else null. */
  tryParseEntryName() {
    this.skipWs();
    if (this.peek() !== '"') return null;
    const save = this.pos;
    const key = this.parseQuotedString();
    this.skipWsNoComma();
    if (this.peek() === ':') {
      this.pos++;
      return key;
    }
    // Not a key — it was an unnamed string value; rewind so the caller re-parses it
    this.pos = save;
    return null;
  }

  skipWsNoComma() {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') this.pos++;
      else break;
    }
  }

  parseNode(name, sink) {
    this.expect('{');

    // Leading special entries determine the node kind:
    //   "$id" first  -> reference node (then optional "$type")
    //   "$type" first -> typed struct node
    //   otherwise     -> untyped struct node
    let refId = null;
    let typeRef = null;

    let pendingKey = this.tryParseEntryName();
    if (pendingKey === '$id') {
      const idToken = this.parseBareToken();
      if (!RE_INTEGER.test(idToken)) throw this.error(`invalid $id "${idToken}"`);
      refId = parseInt(idToken, 10);
      pendingKey = this.tryParseEntryName();
    }
    if (pendingKey === '$type') {
      typeRef = this.parseTypeRefFromValue();
      pendingKey = this.tryParseEntryName();
    }

    if (refId !== null) sink.beginReferenceNode(name, typeRef, refId);
    else sink.beginStructNode(name, typeRef);
    this.nodeStack.push({ typeName: typeRef ? typeRef.name : null, isArray: false });

    // Remaining entries
    for (;;) {
      if (pendingKey === null) {
        this.skipWs();
        const c = this.peek();
        if (c === '}') { this.pos++; break; }
        if (c === undefined) throw this.error('unterminated node');
        if (c === '"') {
          // tryParseEntryName rewound: this is an unnamed string value
          sink.writeString(null, this.parseQuotedString());
        } else {
          this.parseValue(null, sink);
        }
        pendingKey = this.tryParseEntryName();
        continue;
      }

      if (pendingKey === '$rlength') {
        const lenToken = this.parseBareToken();
        if (!RE_INTEGER.test(lenToken)) throw this.error(`invalid $rlength "${lenToken}"`);
        const next = this.tryParseEntryName();
        if (next !== '$rcontent') throw this.error(`expected "$rcontent" after "$rlength", got "${next}"`);
        this.parseRegularArray(parseInt(lenToken, 10), sink);
      } else if (pendingKey === '$plength') {
        const lenToken = this.parseBareToken();
        if (!RE_INTEGER.test(lenToken)) throw this.error(`invalid $plength "${lenToken}"`);
        const next = this.tryParseEntryName();
        if (next !== '$pcontent') throw this.error(`expected "$pcontent" after "$plength", got "${next}"`);
        this.parsePrimitiveArray(parseInt(lenToken, 10), sink);
      } else if (pendingKey === '$blobdoc') {
        this.parseBlobdoc(sink);
      } else if (pendingKey === '$id' || pendingKey === '$type') {
        throw this.error(`unexpected "${pendingKey}" mid-node`);
      } else {
        this.parseValue(pendingKey, sink);
      }
      pendingKey = this.tryParseEntryName();
    }

    this.nodeStack.pop();
    sink.endNode();
  }

  /**
   * "$blobdoc": { ... } — an inline nested Odin document standing in for a byte[]
   * primitive array (see json_writer). Serialized with a fresh type registry/node
   * stack (nested documents are independent), then emitted to the outer sink as
   * the byte[] primitive array it replaces.
   */
  parseBlobdoc(sink) {
    const { OdinBinaryWriter } = require('./binary_writer');
    const nested = new OdinBinaryWriter();
    const savedTypes = this.types;
    const savedStack = this.nodeStack;
    this.types = new Map();
    this.nodeStack = [];
    try {
      this.skipWs();
      if (this.peek() !== '{') throw this.error('$blobdoc value must be a node');
      this.parseValue(null, nested);
    } finally {
      this.types = savedTypes;
      this.nodeStack = savedStack;
    }
    const raw = nested.getBuffer();
    sink.writePrimitiveArray(raw.length, 1, raw);
  }

  parseRegularArray(length, sink) {
    this.skipWs();
    this.expect('[');
    sink.beginArrayNode(length);
    this.nodeStack.push({ typeName: null, isArray: true });
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === ']') { this.pos++; break; }
      if (c === undefined) throw this.error('unterminated $rcontent array');
      this.parseValue(null, sink);
    }
    this.nodeStack.pop();
    sink.endArrayNode();
  }

  parsePrimitiveArray(length, sink) {
    const typeName = this.currentNodeTypeName();
    const elemName = typeName ? typeName.split('[')[0].split(',')[0].trim() : null;
    const spec = elemName ? PRIMITIVE_ELEMENTS[elemName] : null;
    if (!spec) {
      throw this.error(`cannot determine primitive array element type (node type: ${typeName || 'none'})`);
    }
    this.skipWs();
    this.expect('[');
    const raw = Buffer.alloc(length * spec.size);
    let i = 0;
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === ']') { this.pos++; break; }
      if (c === undefined) throw this.error('unterminated $pcontent array');
      if (i >= length) throw this.error(`more than ${length} elements in $pcontent`);
      const off = i * spec.size;
      if (elemName === 'System.Char') {
        const s = this.parseQuotedString();
        if (s.length !== 1) throw this.error(`invalid char element "${s}"`);
        raw.writeUInt16LE(s.charCodeAt(0), off);
      } else {
        const token = this.parseBareToken();
        this.encodePrimitiveElement(elemName, token, raw, off);
      }
      i++;
    }
    if (i !== length) throw this.error(`$pcontent has ${i} elements, $plength says ${length}`);
    sink.writePrimitiveArray(length, spec.size, raw);
  }

  encodePrimitiveElement(elemName, token, raw, off) {
    switch (elemName) {
      case 'System.SByte': raw.writeInt8(parseInt(token, 10), off); break;
      case 'System.Byte': raw.writeUInt8(parseInt(token, 10), off); break;
      case 'System.Int16': raw.writeInt16LE(parseInt(token, 10), off); break;
      case 'System.UInt16': raw.writeUInt16LE(parseInt(token, 10), off); break;
      case 'System.Int32': raw.writeInt32LE(parseInt(token, 10), off); break;
      case 'System.UInt32': raw.writeUInt32LE(parseInt(token, 10) >>> 0, off); break;
      case 'System.Int64': raw.writeBigInt64LE(BigInt(token), off); break;
      case 'System.UInt64': raw.writeBigUInt64LE(BigInt(token), off); break;
      case 'System.Single': raw.writeFloatLE(Math.fround(parseFloat(token)), off); break;
      case 'System.Double': raw.writeDoubleLE(parseFloat(token), off); break;
      case 'System.Boolean': raw.writeUInt8(token === 'true' ? 1 : 0, off); break;
      case 'System.Decimal': decimalStringToBytes(token).copy(raw, off); break;
      case 'System.Guid': guidStringToBytes(token).copy(raw, off); break;
      default: throw this.error(`unsupported primitive array element type ${elemName}`);
    }
  }
}

/** Convenience: parse Odin JSON `text` into `sink`. */
function readJson(text, sink) {
  new OdinJsonReader(text).parseDocument(sink);
}

module.exports = { OdinJsonReader, readJson };
