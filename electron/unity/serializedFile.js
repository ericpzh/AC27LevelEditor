'use strict';

// ─── Unity SerializedFile reader (pure JS) ───────────────────────────────
// Parses a `.assets`/serialized file's metadata (header, type definitions and
// object table) and reads individual objects through their embedded type
// trees — the same data UnityPy walks, without a Python install.
//
// Layout notes (matching Unity's format, verified against Unity 6 / format v22):
//   • the first four u32 of the header are ALWAYS big-endian;
//   • the endianness byte then selects little/big endian for everything else;
//   • format >= 22 adds a 28-byte extended header whose fields are still
//     big-endian (the reader's endian switches only after them);
//   • each object is a (absolute byte offset, byte size, type index) triple.

const fs = require('fs');
const { BinaryReader } = require('./binaryReader');
const TYPETREES = require('./typetrees.json');

const META_FLAG_ALIGN = 0x4000;

// ── Fallback schema ───────────────────────────────────────────────────────
// AC27 (Unity 6) ships serialized files with the type trees stripped, so for
// the handful of classes the extractor touches we read the field layout from
// `typetrees.json` — the release type trees UnityPy/AssetRipper publish, dumped
// by scripts/export-unity-typetrees.py. Objects whose class has no schema are
// simply skipped.

/** Rebuild a tree from a flat, pre-order DFS node list (see the exporter). */
function buildTreeFromFlat(nodes) {
  const root = { ...nodes[0], children: [] };
  const stack = [root];
  for (let i = 1; i < nodes.length; i++) {
    const node = { ...nodes[i], children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

const FALLBACK_NODES = new Map();
for (const [classId, info] of Object.entries(TYPETREES.classes)) {
  FALLBACK_NODES.set(Number(classId), buildTreeFromFlat(info.nodes));
}
function fallbackNode(classId) { return FALLBACK_NODES.get(classId) || null; }

// Unity ClassIDType values we care about.
const CLASS_ID = {
  GameObject: 1,
  Transform: 4,
  MeshFilter: 33,
  MeshRenderer: 23,
  Mesh: 43,
  SkinnedMeshRenderer: 137,
};

// Primitive type name → BinaryReader accessor.
const PRIMITIVE = {
  SInt8: 'i8', UInt8: 'u8', char: 'u8',
  short: 'i16', SInt16: 'i16', 'unsigned short': 'u16', UInt16: 'u16',
  int: 'i32', SInt32: 'i32', 'unsigned int': 'u32', UInt32: 'u32', 'Type*': 'u32',
  'long long': 'i64', SInt64: 'i64', 'unsigned long long': 'u64', UInt64: 'u64', FileSize: 'u64',
  float: 'f32', double: 'f64', bool: 'bool',
};

// ── Type tree ─────────────────────────────────────────────────────────────

/**
 * Parse a type tree blob (format >= 12). Returns the root node.
 * String offsets with the high bit set index the "common strings" table
 * (types like `int`/`string`); otherwise the offset is into the node blob's
 * own string buffer.
 */
function parseTypeTreeBlob(reader, version, commonStrings) {
  const nodeCount = reader.i32();
  const stringBufferSize = reader.i32();
  const structSize = version >= 19 ? 32 : 24;
  const nodeData = reader.bytes(nodeCount * structSize);
  const stringBuffer = reader.bytes(stringBufferSize);
  const nr = new BinaryReader(nodeData, reader.endian);
  const sb = new BinaryReader(stringBuffer, reader.endian);

  const readNodeString = (offset) => {
    if ((offset & 0x80000000) === 0) {
      sb.position = offset;
      return sb.stringToNull();
    }
    const key = offset & 0x7fffffff;
    if (commonStrings && commonStrings[key] != null) return commonStrings[key];
    return String(key);
  };

  const raw = [];
  for (let i = 0; i < nodeCount; i++) {
    const n = {
      version: nr.i16(),
      level: nr.u8(),
      typeFlags: nr.u8(),
      typeStrOffset: nr.u32(),
      nameStrOffset: nr.u32(),
      byteSize: nr.i32(),
      index: nr.i32(),
      metaFlag: nr.i32(),
      refTypeHash: null,
      type: '',
      name: '',
      children: [],
    };
    if (version >= 19) n.refTypeHash = nr.u64();
    raw.push(n);
  }
  for (const n of raw) {
    n.type = readNodeString(n.typeStrOffset);
    n.name = readNodeString(n.nameStrOffset);
  }

  // Rebuild the tree from flat (level-ordered) nodes, exactly like Unity does.
  const fakeRoot = { level: -1, children: [] };
  const stack = [fakeRoot];
  let parent = fakeRoot;
  let prev = fakeRoot;
  for (const node of raw) {
    if (node.level > prev.level) { stack.push(parent); parent = prev; }
    else if (node.level < prev.level) { while (node.level <= parent.level) parent = stack.pop(); }
    parent.children.push(node);
    prev = node;
  }
  return fakeRoot.children[0];
}

// ── Generic type-tree reader ──────────────────────────────────────────────

function isAligned(node) { return ((node.metaFlag || 0) & META_FLAG_ALIGN) !== 0; }

function readValue(node, reader, ctx) {
  let align = isAligned(node);
  const prim = PRIMITIVE[node.type];
  let value;
  if (prim) {
    value = reader[prim]();
  } else if (node.type === 'string') {
    value = reader.alignedString();
  } else if (node.type === 'TypelessData') {
    value = reader.byteArray();
  } else if (node.type === 'pair') {
    value = [readValue(node.children[0], reader, ctx), readValue(node.children[1], reader, ctx)];
  } else if (node.children.length && node.children[0].type === 'Array') {
    if (isAligned(node.children[0])) align = true;
    const size = reader.i32();
    if (size < 0) throw new Error('negative array length');
    const subtype = node.children[0].children[1];
    value = isAligned(subtype)
      ? readValueArray(subtype, reader, ctx, size)
      : Array.from({ length: size }, () => readValue(subtype, reader, ctx));
  } else {
    value = {};
    for (const child of node.children) value[child.name] = readValue(child, reader, ctx);
  }
  if (align) reader.align(4);
  return value;
}

function readValueArray(node, reader, ctx, size) {
  let align = isAligned(node);
  if (node.type === 'UInt8' || node.type === 'SInt8' || node.type === 'char') {
    const out = reader.bytes(size);
    if (align) reader.align(4);
    return out;
  }
  const prim = PRIMITIVE[node.type];
  let value;
  if (prim) {
    value = new Array(size);
    for (let i = 0; i < size; i++) value[i] = reader[prim]();
  } else if (node.type === 'string') {
    value = Array.from({ length: size }, () => reader.alignedString());
  } else if (node.type === 'TypelessData') {
    value = Array.from({ length: size }, () => reader.byteArray());
  } else if (node.type === 'pair') {
    value = Array.from({ length: size }, () => [readValue(node.children[0], reader, ctx), readValue(node.children[1], reader, ctx)]);
  } else if (node.children.length && node.children[0].type === 'Array') {
    if (isAligned(node.children[0])) align = true;
    const subtype = node.children[0].children[1];
    if (isAligned(subtype)) {
      value = Array.from({ length: size }, () => readValueArray(subtype, reader, ctx, reader.i32()));
    } else {
      value = Array.from({ length: size }, () => {
        const n = reader.i32();
        return Array.from({ length: n }, () => readValue(subtype, reader, ctx));
      });
    }
  } else {
    value = Array.from({ length: size }, () => {
      const o = {};
      for (const child of node.children) o[child.name] = readValue(child, reader, ctx);
      return o;
    });
  }
  if (align) reader.align(4);
  return value;
}

function readIntArray(reader) {
  const n = reader.i32();
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = reader.i32();
  return out;
}

function parseSerializedType(reader, version, enableTypeTree, isRefType, commonStrings) {
  const classId = reader.i32();
  let isStripped = false;
  if (version >= 16) isStripped = reader.bool();
  let scriptTypeIndex = -1;
  if (version >= 17) scriptTypeIndex = reader.i16();
  if (version >= 13) {
    if ((isRefType && scriptTypeIndex >= 0) || (version < 16 && classId < 0) || (version >= 16 && classId === 114)) {
      reader.bytes(16); // script id
    }
    reader.bytes(16); // old type hash
  }
  let node = null;
  let m_ClassName = null;
  let m_NameSpace = null;
  let m_AssemblyName = null;
  let typeDependencies = null;
  if (enableTypeTree) {
    node = parseTypeTreeBlob(reader, version, commonStrings);
    if (version >= 21) {
      if (isRefType) {
        m_ClassName = reader.stringToNull();
        m_NameSpace = reader.stringToNull();
        m_AssemblyName = reader.stringToNull();
      } else {
        typeDependencies = readIntArray(reader);
      }
    }
  }
  return { classId, isStripped, scriptTypeIndex, node, m_ClassName, m_NameSpace, m_AssemblyName, typeDependencies };
}

// ── SerializedFile ────────────────────────────────────────────────────────

class SerializedFile {
  constructor(fd, stat, opts) {
    this.fd = fd;
    this._size = stat.size;
    this.opts = opts || {};
    this._parseHeaderAndMetadata();
  }

  static open(filePath, opts) {
    const fd = fs.openSync(filePath, 'r');
    let stat;
    try { stat = fs.fstatSync(fd); } catch (err) { fs.closeSync(fd); throw err; }
    try {
      return new SerializedFile(fd, stat, opts || {});
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
  }

  close() { if (this.fd != null) { try { fs.closeSync(this.fd); } catch (_) {} this.fd = null; } }

  _parseHeaderAndMetadata() {
    const headLen = Math.min(this._size, 1024);
    const head = Buffer.alloc(headLen);
    fs.readSync(this.fd, head, 0, headLen, 0);
    // The initial header is big-endian regardless of the file's endianness.
    const r = new BinaryReader(head, '>');
    r.u32(); // metadata_size (ignored; v22 overrides)
    r.u32(); // file_size
    const version = r.u32();
    let dataOffset = r.u32();
    this.version = version;
    this.endian = '<';
    if (version >= 9) {
      this.endian = r.u8() ? '>' : '<';
      r.bytes(3);
    }
    if (version >= 9 && version >= 22) {
      const metadataSize = r.u32();
      r.i64(); // file_size
      dataOffset = Number(r.i64());
      r.i64(); // unknown
      this.metadataSize = metadataSize;
    } else {
      this.metadataSize = 0;
    }
    this.dataOffset = dataOffset;
    const headerEnd = r.position;

    const readEnd = Math.max(headerEnd, Math.min(this._size, Math.max(dataOffset, headerEnd + (this.metadataSize || 0))));
    const metaBuf = Buffer.alloc(readEnd);
    fs.readSync(this.fd, metaBuf, 0, readEnd, 0);
    const mr = new BinaryReader(metaBuf, this.endian);
    mr.position = headerEnd;

    this.unityVersion = version >= 7 ? mr.stringToNull() : '5.0.0';
    this.targetPlatform = version >= 8 ? mr.i32() : 0;
    this.enableTypeTree = version >= 13 ? mr.bool() : true;

    const commonStrings = this.opts.commonStrings || null;
    this.commonStringMisses = new Set();
    const typeCount = mr.i32();
    this.types = new Array(typeCount);
    for (let i = 0; i < typeCount; i++) {
      this.types[i] = parseSerializedType(mr, version, this.enableTypeTree, false, commonStrings);
    }

    let bigIdEnabled = 0;
    if (version >= 7 && version < 14) bigIdEnabled = mr.i32();

    const objectCount = mr.i32();
    this.objects = new Map(); // pathId (BigInt) -> entry
    for (let i = 0; i < objectCount; i++) {
      let pathId;
      if (bigIdEnabled) pathId = mr.i64();
      else if (version < 14) pathId = BigInt(mr.i32());
      else { mr.align(4); pathId = mr.i64(); }

      let byteStart;
      if (version >= 22) byteStart = Number(mr.i64());
      else byteStart = mr.u32();
      byteStart += dataOffset;
      const byteSize = mr.u32();
      const typeId = mr.i32();

      let classId;
      let type;
      if (version < 16) {
        classId = mr.u16();
        type = this.types.find((t) => t.classId === typeId) || null;
      } else {
        type = this.types[typeId] || null;
        classId = type ? type.classId : -1;
      }
      if (version < 11) mr.u16();
      if (version >= 11 && version < 17) mr.i16();
      if (version === 15 || version === 16) mr.u8();

      this.objects.set(pathId, { pathId, byteStart, byteSize, typeId, classId, type });
    }
  }

  /** All object entries of a given ClassIDType. */
  objectsOfClass(classId) {
    const out = [];
    for (const entry of this.objects.values()) if (entry.classId === classId) out.push(entry);
    return out;
  }

  readObjectBytes(entry) {
    const buf = Buffer.allocUnsafe(entry.byteSize);
    const read = fs.readSync(this.fd, buf, 0, entry.byteSize, entry.byteStart);
    if (read !== entry.byteSize) throw new Error(`short read (${read}/${entry.byteSize})`);
    return buf;
  }

  /** Parse an object entry through its type tree. */
  parseObject(entry, strict) {
    const node = (entry.type && entry.type.node) || fallbackNode(entry.classId);
    if (!node) throw new Error(`no type tree for class ${entry.classId}`);
    const buf = this.readObjectBytes(entry);
    const r = new BinaryReader(buf, this.endian);
    const value = readValue(node, r, this);
    if (strict && r.position !== entry.byteSize) {
      throw new Error(`type tree read ${r.position}/${entry.byteSize} for class ${entry.classId}`);
    }
    return { value, bytesRead: r.position };
  }

  /** Read just enough of an object to get its `m_Name`. */
  peekName(entry) {
    const node = (entry.type && entry.type.node) || fallbackNode(entry.classId);
    if (!node) return null;
    let idx = -1;
    for (let i = 0; i < node.children.length; i++) {
      const n = node.children[i].name;
      if (n === 'm_Name' || n === 'name') { idx = i; break; }
    }
    if (idx < 0) return null;
    const truncated = { ...node, children: node.children.slice(0, idx + 1) };
    const buf = this.readObjectBytes(entry);
    const r = new BinaryReader(buf, this.endian);
    const value = readValue(truncated, r, this);
    const key = node.children[idx].name;
    return value[key] == null ? null : String(value[key]);
  }

  /** Resolve an intra-file PPtr ({m_FileID, m_PathID}), or null. */
  resolvePPtr(pptr) {
    if (!pptr || pptr.m_PathID == null) return null;
    if (pptr.m_FileID) return null; // external — not handled
    return this.objects.get(pptr.m_PathID) || null;
  }
}

module.exports = {
  SerializedFile,
  CLASS_ID,
  parseTypeTreeBlob,
  readValue,
  readValueArray,
  META_FLAG_ALIGN,
};
