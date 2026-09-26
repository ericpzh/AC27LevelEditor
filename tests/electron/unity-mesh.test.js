// @vitest-environment node

/**
 * Unit tests for the pure-JS Unity mesh reader (electron/unity/mesh.js) and the
 * aircraftPack transform helpers. No game install required — synthetic buffers.
 */

import { describe, it, expect } from 'vitest';

const mesh = require('../../electron/unity/mesh');
const pack = require('../../electron/unity/aircraftPack');

describe('parseUnityVersion', () => {
  it('parses modern and legacy version strings', () => {
    expect(mesh.parseUnityVersion('6000.3.12f1').major).toBe(6000);
    expect(mesh.parseUnityVersion('2021.3.16f1').major).toBe(2021);
    expect(mesh.parseUnityVersion('').major).toBe(2019);
  });
});

describe('getStreams', () => {
  it('computes stride and 16-byte-aligned stream offsets', () => {
    // 3 floats vertex + 4 floats tangent in stream 0, 2 half floats UV in stream 1.
    const channels = [
      { stream: 0, offset: 0, format: 0, dimension: 3 },
      { stream: 0, offset: 12, format: 0, dimension: 4 },
      { stream: 1, offset: 0, format: 1, dimension: 2 },
    ];
    const streams = mesh.getStreams(channels, 10, 6000);
    expect(streams[0]).toEqual({ channelMask: 0b0011, offset: 0, stride: 28 });
    // 10 * 28 = 280, padded up to the next 16-byte boundary (288).
    expect(streams[1]).toEqual({ channelMask: 0b0100, offset: 288, stride: 4 });
  });
});

describe('readChannel', () => {
  it('reads float32 components', () => {
    const buf = Buffer.alloc(4 * 3);
    [1, 2, 3].forEach((v, i) => buf.writeFloatLE(v, i * 4));
    const out = mesh.readChannel(buf, { format: 0, dimension: 3, offset: 0 }, { offset: 0, stride: 12 }, 1, 6000, true);
    expect(out[0]).toEqual([1, 2, 3]);
  });

  it('reads float16 (half) components', () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt16LE(0x3c00, 0); // 1.0
    buf.writeUInt16LE(0x4000, 2); // 2.0
    const out = mesh.readChannel(buf, { format: 1, dimension: 2, offset: 0 }, { offset: 0, stride: 4 }, 1, 6000, true);
    expect(out[0][0]).toBeCloseTo(1);
    expect(out[0][1]).toBeCloseTo(2);
  });
});

describe('PackedBitVector unpacking', () => {
  it('unpacks ints across byte boundaries', () => {
    const pb = { m_NumItems: 4, m_BitSize: 4, m_Data: Buffer.from([0x21, 0x43]) };
    expect(Array.from(mesh.unpackInts(pb))).toEqual([1, 2, 3, 4]);
  });

  it('dequantizes floats with start/range', () => {
    const pb = { m_NumItems: 2, m_BitSize: 8, m_Start: 0, m_Range: 1, m_Data: Buffer.from([0, 255]) };
    const out = mesh.unpackFloats(pb);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
  });

  it('returns the constant start when bitSize is 0', () => {
    const pb = { m_NumItems: 3, m_BitSize: 0, m_Start: 0.5, m_Range: 0, m_Data: Buffer.alloc(0) };
    expect(Array.from(mesh.unpackFloats(pb))).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('readMeshData (compressed mesh)', () => {
  it('decompresses vertices/UV and builds submesh triangles', () => {
    const verts = { m_NumItems: 6, m_BitSize: 8, m_Start: 0, m_Range: 1, m_Data: Buffer.from([0, 0, 255, 255, 0, 128]) };
    const uv = { m_NumItems: 4, m_BitSize: 8, m_Start: 0, m_Range: 1, m_Data: Buffer.from([0, 255, 0, 255]) };
    const tris = { m_NumItems: 3, m_BitSize: 8, m_Data: Buffer.from([0, 1, 0]) };
    const meshObj = {
      m_VertexData: {},
      m_IndexFormat: 0,
      m_CompressedMesh: { m_Vertices: verts, m_UV: uv, m_Triangles: tris },
      m_SubMeshes: [{ firstByte: 0, indexCount: 3, topology: 0, firstVertex: 0, vertexCount: 2 }],
    };
    const data = mesh.readMeshData(meshObj, { major: 6000 });
    expect(data.positions).toHaveLength(2);
    expect(data.positions[0][2]).toBeCloseTo(1);
    expect(data.positions[1][0]).toBeCloseTo(1);
    expect(data.triangles[0]).toEqual([[0, 1, 0]]);
  });
});

describe('buildPart', () => {
  const meshData = {
    positions: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
    uv0: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]],
    triangles: [[[0, 1, 2]]],
  };

  it('negates X, reverses winding and dedups vertices', () => {
    const part = mesh.buildPart(meshData, 'all', null);
    // Exporter emits (c,b,a): vertex 2 first, then 1, then 0.
    expect(Array.from(part.positions.slice(0, 3))).toEqual([-7, 8, 9]);
    expect(part.uvs[0]).toBeCloseTo(0.5);
    expect(part.uvs[1]).toBeCloseTo(0.6);
    expect(Array.from(part.indices)).toEqual([0, 1, 2]);
    expect(part.bbox).toEqual([-7, 2, 3, -1, 8, 9]);
  });

  it('applies the world matrix and selects only wanted submeshes', () => {
    const data = {
      positions: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      uv0: [[0, 0], [0, 0], [0, 0]],
      triangles: [
        [[0, 1, 2]],
        [[0, 1, 2]],
      ],
    };
    const scale = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    const only0 = mesh.buildPart(data, [0], scale);
    const both = mesh.buildPart(data, 'all', scale);
    // Both submeshes reference the same 3 vertices, so dedup keeps 3 verts but
    // emits two triangles' worth of indices.
    expect(both.positions.length).toBe(only0.positions.length);
    expect(both.indices.length).toBe(6);
    expect(only0.indices.length).toBe(3);
    // Scale doubles the (X-negated) component: the original +X vertex → -2.
    expect(only0.bbox[0]).toBeCloseTo(-2);
  });

  it('returns null for empty geometry', () => {
    expect(mesh.buildPart({ positions: [], uv0: [], triangles: [] }, 'all', null)).toBeNull();
  });
});

describe('toIndexBytes', () => {
  it('accepts buffers and byte arrays', () => {
    expect(mesh.toIndexBytes(Buffer.from([1, 2])).length).toBe(2);
    expect(mesh.toIndexBytes([1, 2, 3]).length).toBe(3);
    expect(mesh.toIndexBytes(null)).toBeNull();
  });
});

describe('aircraftPack transform math', () => {
  it('builds a TRS matrix from local components', () => {
    const m = pack.localMatrix({
      m_LocalPosition: { x: 1, y: 2, z: 3 },
      m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
      m_LocalScale: { x: 2, y: 2, z: 2 },
    });
    expect(m.slice(0, 3)).toEqual([2, 0, 0]);
    expect([m[3], m[7], m[11]]).toEqual([1, 2, 3]);
  });

  it('multiplies matrices (parent * child)', () => {
    const t = [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const s = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(pack.mulMat(t, s).slice(3, 4)[0]).toBe(5);
  });

  it('safeName strips characters illegal in file names', () => {
    expect(pack.safeName('AIRBUS A-350-900')).toBe('AIRBUS_A-350-900');
  });

  it('covers every aircraft the painter offers a 3D model for', () => {
    expect(Object.keys(pack.PLANES).length).toBe(19);
    for (const [id, cfg] of Object.entries(pack.PLANES)) {
      expect(cfg.parts.length, id).toBeGreaterThan(0);
      for (const p of cfg.parts) expect(typeof p.name).toBe('string');
    }
  });
});
