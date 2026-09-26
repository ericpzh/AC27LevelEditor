// @vitest-environment node

/**
 * Unit tests for the pure-JS serialized-file reader (electron/unity/
 * serializedFile.js): the generic type-tree value reader and the shipped
 * fallback schema. No game install required.
 */

import { describe, it, expect } from 'vitest';

const { readValue } = require('../../electron/unity/serializedFile');
const { BinaryReader } = require('../../electron/unity/binaryReader');
const typtrees = require('../../electron/unity/typetrees.json');

function node(type, name, extra = {}) {
  return { type, name, metaFlag: 0, byteSize: 0, version: 0, level: 0, children: [], ...extra };
}

function read(nodes, bytes) {
  const r = new BinaryReader(Buffer.from(bytes), '<');
  return readValue(nodes, r);
}

describe('readValue', () => {
  it('reads primitives', () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(42, 0);
    const root = node('Test', 'root', { children: [node('int', 'value')] });
    expect(read(root, buf)).toEqual({ value: 42 });
  });

  it('reads an aligned string', () => {
    const buf = Buffer.alloc(12);
    buf.writeInt32LE(3, 0);
    buf.write('abc', 4);
    const root = node('Test', 'root', { children: [node('string', 'name')] });
    expect(read(root, buf)).toEqual({ name: 'abc' });
  });

  it('reads TypelessData (length-prefixed bytes)', () => {
    const buf = Buffer.alloc(8);
    buf.writeInt32LE(4, 0);
    buf[4] = 9; buf[5] = 8;
    const root = node('Test', 'root', { children: [node('TypelessData', 'data')] });
    const out = read(root, buf);
    expect(Array.from(out.data)).toEqual([9, 8, 0, 0]);
  });

  it('reads vectors with a size prefix', () => {
    const buf = Buffer.alloc(12);
    buf.writeInt32LE(2, 0);
    buf.writeInt32LE(7, 4);
    buf.writeInt32LE(8, 8);
    const arrayNode = node('Array', 'Array', { children: [node('int', 'size'), node('int', 'data')] });
    const root = node('Test', 'root', { children: [node('vector', 'items', { children: [arrayNode] })] });
    expect(read(root, buf)).toEqual({ items: [7, 8] });
  });

  it('realigns to 4 bytes after an aligned field', () => {
    // byte, bool(aligned), int -> 1 + 1 + 2 pad + 4
    const buf = Buffer.alloc(8);
    buf[0] = 1;
    buf[1] = 1;
    buf.writeInt32LE(7, 4);
    const root = node('Test', 'root', {
      children: [
        node('UInt8', 'a'),
        node('bool', 'b', { metaFlag: 0x4000 }),
        node('int', 'c'),
      ],
    });
    expect(read(root, buf)).toEqual({ a: 1, b: true, c: 7 });
  });

  it('reads a PPtr-shaped class (m_FileID, m_PathID)', () => {
    const buf = Buffer.alloc(12);
    buf.writeInt32LE(0, 0);
    buf.writeBigInt64LE(1234n, 4);
    const root = node('Test', 'root', {
      children: [node('PPtr<Object>', 'm_Mesh', { children: [node('int', 'm_FileID'), node('SInt64', 'm_PathID')] })],
    });
    const out = read(root, buf);
    expect(out.m_Mesh.m_FileID).toBe(0);
    expect(out.m_Mesh.m_PathID).toBe(1234n);
  });
});

describe('fallback type-tree schema', () => {
  it('ships the classes the extractor needs', () => {
    for (const id of ['1', '4', '43', '137']) {
      expect(typtrees.classes[id], `class ${id}`).toBeTruthy();
      expect(typtrees.classes[id].nodes.length).toBeGreaterThan(0);
    }
  });

  it('exposes the Mesh fields the reader walks', () => {
    const names = new Set(typtrees.classes['43'].nodes.map((n) => n.name));
    for (const f of ['m_Name', 'm_VertexData', 'm_SubMeshes', 'm_IndexBuffer', 'm_CompressedMesh', 'm_IndexFormat']) {
      expect(names.has(f), f).toBe(true);
    }
  });
});
