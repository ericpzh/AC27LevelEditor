'use strict';

// ─── Unity Mesh → indexed triangle geometry (pure JS) ────────────────────
// Mirrors UnityPy's MeshHandler/OBJ exporter closely enough that the resulting
// pack matches the Python extractor:
//   • X is negated (the OBJ exporter's `-pos[0]`);
//   • face winding is reversed (the exporter emits c,b,a);
//   • vertices are de-duplicated by vertex index;
//   • positions are then transformed by the renderer's world matrix.
//
// The importer only needs positions + UV0 + indices, but the channel reader is
// generic so a future part can pull normals/colors/UV1 too.

const { CLASS_ID } = require('./serializedFile');

function parseUnityVersion(str) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(str || ''));
  if (!m) return { major: 2019, minor: 0, patch: 0 };
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// Vertex format enum → component code, per Unity era.
const FORMAT_DTYPE_OLD = { 0: 'f', 1: 'e', 2: 'B', 3: 'B', 4: 'I' };
const FORMAT_DTYPE_2017 = { 0: 'f', 1: 'e', 2: 'B', 3: 'B', 4: 'b', 5: 'H', 6: 'h', 7: 'B', 8: 'b', 9: 'H', 10: 'h', 11: 'I', 12: 'i' };
const FORMAT_DTYPE = { 0: 'f', 1: 'e', 2: 'B', 3: 'b', 4: 'H', 5: 'h', 6: 'B', 7: 'b', 8: 'H', 9: 'h', 10: 'I', 11: 'i' };

const DTYPE_SIZE = { f: 4, e: 2, B: 1, b: 1, H: 2, h: 2, I: 4, i: 4 };

function formatMap(major) {
  if (major < 2017) return FORMAT_DTYPE_OLD;
  if (major < 2019) return FORMAT_DTYPE_2017;
  return FORMAT_DTYPE;
}

/** IEEE-754 half precision. */
function readHalf(buf, pos, le) {
  const bits = le ? buf.readUInt16LE(pos) : buf.readUInt16BE(pos);
  const sign = (bits & 0x8000) ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

function readComponent(buf, pos, code, le) {
  switch (code) {
    case 'f': return le ? buf.readFloatLE(pos) : buf.readFloatBE(pos);
    case 'e': return readHalf(buf, pos, le);
    case 'B': return buf.readUInt8(pos);
    case 'b': return buf.readInt8(pos);
    case 'H': return le ? buf.readUInt16LE(pos) : buf.readUInt16BE(pos);
    case 'h': return le ? buf.readInt16LE(pos) : buf.readInt16BE(pos);
    case 'I': return le ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
    case 'i': return le ? buf.readInt32LE(pos) : buf.readInt32BE(pos);
    default: return 0;
  }
}

/** Recompute the vertex streams from the channel descriptors (UnityPy does). */
function getStreams(channels, vertexCount, major) {
  const fm = formatMap(major);
  let streamCount = 1;
  for (const ch of channels) if (ch.stream >= streamCount) streamCount = ch.stream + 1;
  const streams = [];
  let offset = 0;
  for (let s = 0; s < streamCount; s++) {
    let channelMask = 0;
    let stride = 0;
    channels.forEach((ch, chn) => {
      if (ch.stream === s && ch.dimension > 0) {
        channelMask |= 1 << chn;
        const code = fm[ch.format] || 'f';
        stride += (ch.dimension & 0xf) * (DTYPE_SIZE[code] || 4);
      }
    });
    streams.push({ channelMask, offset, stride });
    offset += vertexCount * stride;
    offset = (offset + 15) & ~15;
  }
  return streams;
}

/**
 * Read one channel's per-vertex components.
 * @returns {Float64Array|Array<number[]>} flat array for dim 1, else array of arrays
 */
function readChannel(data, ch, stream, vertexCount, major, le) {
  const fm = formatMap(major);
  const code = fm[ch.format] || 'f';
  const componentSize = DTYPE_SIZE[code] || 4;
  const dimension = ch.dimension & 0xf;
  if (dimension <= 0 || stream.stride === 0) return null;
  const out = new Array(vertexCount);
  const base = stream.offset + ch.offset;
  for (let i = 0; i < vertexCount; i++) {
    const vOff = base + i * stream.stride;
    const v = new Array(dimension);
    for (let c = 0; c < dimension; c++) v[c] = readComponent(data, vOff + c * componentSize, code, le);
    out[i] = v;
  }
  return out;
}

/** Positions + UV0 (+ per-submesh triangles) for a parsed Mesh object. */
function readMeshData(mesh, opts) {
  const major = (opts && opts.major) || 2019;
  const le = !opts || opts.endian !== '>';
  const vd = mesh.m_VertexData || {};
  const channels = vd.m_Channels || [];
  const vertexCount = vd.m_VertexCount || 0;
  const cm = mesh.m_CompressedMesh;
  const compressed = cm && cm.m_Vertices && cm.m_Vertices.m_NumItems > 0;

  let positions = null;
  let uv0 = null;
  let index = null;
  let use16 = mesh.m_Use16BitIndices != null
    ? Boolean(mesh.m_Use16BitIndices)
    : mesh.m_IndexFormat !== 1; // 0 = UInt16, 1 = UInt32

  if (compressed) {
    const dec = decompressCompressedMesh(mesh);
    if (!dec) return { positions: null, uv0: null, triangles: [] };
    positions = dec.positions;
    uv0 = dec.uv0;
    index = dec.index;
    use16 = true;
  } else {
    const data = (opts && opts.vertexData) || vd.m_DataSize;
    if (!vertexCount || !data || !data.length) return { positions: null, uv0: null, triangles: [] };
    const streams = getStreams(channels, vertexCount, major);
    const uvChannel = major >= 2018 ? 4 : 3;
    for (let chn = 0; chn < channels.length; chn++) {
      const ch = channels[chn];
      if (!ch || ch.dimension <= 0) continue;
      if (chn === 0) positions = readChannel(data, ch, streams[ch.stream], vertexCount, major, le);
      else if (chn === uvChannel) uv0 = readChannel(data, ch, streams[ch.stream], vertexCount, major, le);
    }
    const idxBytes = toIndexBytes(mesh.m_IndexBuffer);
    index = idxBytes
      ? (use16
        ? new Uint16Array(idxBytes.buffer, idxBytes.byteOffset, Math.floor(idxBytes.byteLength / 2))
        : new Uint32Array(idxBytes.buffer, idxBytes.byteOffset, Math.floor(idxBytes.byteLength / 4)))
      : null;
  }

  return { positions, uv0, triangles: buildTriangles(mesh.m_SubMeshes, index, use16) };
}

/** Index buffer + submeshes → a per-submesh triangle list. */
function buildTriangles(submeshes, index, use16) {
  const triangles = [];
  if (!index || !submeshes) return triangles;
  for (const sm of submeshes) {
    let firstIndex = (sm.firstByte || 0) >> 1;
    if (!use16) firstIndex >>= 1;
    const indexCount = sm.indexCount || 0;
    const topology = sm.topology == null ? 0 : sm.topology;
    const tris = [];
    if (topology === 0) {
      for (let i = firstIndex; i + 2 < firstIndex + indexCount; i += 3) tris.push([index[i], index[i + 1], index[i + 2]]);
    } else if (topology === 1) {
      for (let i = firstIndex; i + 2 < firstIndex + indexCount; i++) {
        const a = index[i], b = index[i + 1], c = index[i + 2];
        if (a === b || a === c || b === c) continue;
        tris.push(((i - firstIndex) & 1) ? [b, a, c] : [a, b, c]);
      }
    } else if (topology === 2) {
      for (let i = firstIndex; i + 3 < firstIndex + indexCount; i += 4) {
        const a = index[i], b = index[i + 1], c = index[i + 2], d = index[i + 3];
        tris.push([a, b, c], [a, c, d]);
      }
    }
    triangles.push(tris);
  }
  return triangles;
}

// ── Compressed meshes (PackedBitVector) ───────────────────────────────────

function bitMask(bits) { return bits >= 32 ? 0xffffffff : (1 << bits) - 1; }

/** Unpack `count` unsigned ints from a PackedBitVector. */
function unpackInts(pb, start, count) {
  const bitSize = pb.m_BitSize || 0;
  const data = pb.m_Data || Buffer.alloc(0);
  if (count == null) count = pb.m_NumItems || 0;
  const out = new Uint32Array(count);
  if (bitSize === 0) return out;
  let bitPos = bitSize * (start || 0);
  let indexPos = Math.floor(bitPos / 8);
  bitPos %= 8;
  const mask = bitMask(bitSize);
  for (let i = 0; i < count; i++) {
    let bits = 0;
    let value = 0;
    while (bits < bitSize) {
      value |= ((data[indexPos] >> bitPos) << bits);
      const num = Math.min(bitSize - bits, 8 - bitPos);
      bitPos += num;
      bits += num;
      if (bitPos === 8) { indexPos += 1; bitPos = 0; }
    }
    out[i] = (value & mask) >>> 0;
  }
  return out;
}

/** Unpack `count` floats (dequantized) from a PackedBitVector. */
function unpackFloats(pb, start, count) {
  if (count == null) count = pb.m_NumItems || 0;
  if (!pb.m_BitSize) return new Float64Array(count).fill(pb.m_Start || 0);
  const q = unpackInts(pb, start, count);
  const scale = (pb.m_Range || 0) / bitMask(pb.m_BitSize);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = q[i] * scale + (pb.m_Start || 0);
  return out;
}

function toVec2(flat, count) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = [flat[i * 2], flat[i * 2 + 1]];
  return out;
}

/** Decompress m_CompressedMesh into positions/UV0/index (UnityPy MeshHandler). */
function decompressCompressedMesh(mesh) {
  const cm = mesh.m_CompressedMesh;
  if (!cm || !cm.m_Vertices) return null;
  const vcount = Math.floor((cm.m_Vertices.m_NumItems || 0) / 3);
  if (!vcount) return null;

  const flatPos = unpackFloats(cm.m_Vertices, 0, vcount * 3);
  const positions = new Array(vcount);
  for (let i = 0; i < vcount; i++) positions[i] = [flatPos[i * 3], flatPos[i * 3 + 1], flatPos[i * 3 + 2]];

  let uv0 = null;
  let uv1 = null;
  if (cm.m_UV && cm.m_UV.m_NumItems > 0) {
    const uvInfo = cm.m_UVInfo;
    if (uvInfo) {
      let uvSrcOffset = 0;
      for (let ch = 0; ch < 8; ch++) {
        const bits = (uvInfo >> (ch * 4)) & 0xf;
        if (bits & 4) {
          const dim = 1 + (bits & 3);
          const flat = unpackFloats(cm.m_UV, uvSrcOffset, vcount * dim);
          if (ch === 0) uv0 = toVec2(flat, vcount);
          else if (ch === 1) uv1 = toVec2(flat, vcount);
          uvSrcOffset = dim * vcount;
        }
      }
    } else {
      uv0 = toVec2(unpackFloats(cm.m_UV, 0, vcount * 2), vcount);
      if (cm.m_UV.m_NumItems >= vcount * 4) uv1 = toVec2(unpackFloats(cm.m_UV, vcount * 2, vcount * 2), vcount);
    }
  }

  let index = null;
  if (cm.m_Triangles && cm.m_Triangles.m_NumItems > 0) index = unpackInts(cm.m_Triangles);
  return { positions, uv0, uv1, index, vertexCount: vcount };
}

function toIndexBytes(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Buffer.from(v);
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

function identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }

/** Apply a row-major 4×4 to a 3-vector, returning [x,y,z]. */
function applyMatrix(m, x, y, z) {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

/**
 * Build one pack part: dedup vertices by index across the wanted submeshes,
 * negate X, reverse winding, transform by `matrix`.
 * @returns {{positions:Float32Array, uvs:Float32Array, indices:Uint32Array, bbox:number[]}|null}
 */
function buildPart(meshData, wanted, matrix) {
  const pos = meshData.positions;
  if (!pos || !meshData.triangles || !meshData.triangles.length) return null;
  const uv = meshData.uv0;
  const groups = meshData.triangles;
  const all = wanted === 'all' || wanted == null ? groups.map((_, i) => i) : wanted;
  const M = matrix || identity();

  const positions = [];
  const uvs = [];
  const indices = [];
  const remap = new Map();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const gi of all) {
    const tris = groups[gi];
    if (!tris) continue;
    for (const tri of tris) {
      // Exporter emits (c,b,a) — reversed winding.
      for (let k = tri.length - 1; k >= 0; k--) {
        const vi = tri[k];
        let ni = remap.get(vi);
        if (ni === undefined) {
          const p = pos[vi] || [0, 0, 0];
          const tp = applyMatrix(M, -p[0], p[1], p[2]);
          ni = positions.length / 3;
          remap.set(vi, ni);
          positions.push(tp[0], tp[1], tp[2]);
          const t = (uv && uv[vi]) || [0, 0];
          uvs.push(t[0] || 0, t[1] || 0);
          for (let a = 0; a < 3; a++) { if (tp[a] < min[a]) min[a] = tp[a]; if (tp[a] > max[a]) max[a] = tp[a]; }
        }
        indices.push(ni);
      }
    }
  }
  if (!positions.length) return null;
  return {
    positions: Float32Array.from(positions),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    bbox: [min[0], min[1], min[2], max[0], max[1], max[2]],
  };
}

module.exports = {
  parseUnityVersion,
  formatMap,
  getStreams,
  readChannel,
  readMeshData,
  buildTriangles,
  unpackInts,
  unpackFloats,
  decompressCompressedMesh,
  toIndexBytes,
  buildPart,
  applyMatrix,
  identity,
  CLASS_ID,
};