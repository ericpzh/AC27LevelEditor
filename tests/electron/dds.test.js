// @vitest-environment node

/**
 * Tests for electron/dds.js — DXT1/DXT5 → RGBA decoding + minimal PNG
 * encoder. Pure CommonJS, no Electron required.
 */

import { describe, it, expect } from 'vitest';
import zlib from 'zlib';

const { decodeDds, encodePng, ddsToPngDataUrl } = require('../../electron/dds');

// Builds a DDS buffer with a single 4×4 block per 4×4 tile.
function makeDds(width, height, fourCC, blocks) {
  const header = Buffer.alloc(128);
  header.write('DDS ', 0, 'ascii');
  header.writeUInt32LE(124, 4);
  header.writeUInt32LE(0x1007, 8);
  header.writeUInt32LE(height, 12);
  header.writeUInt32LE(width, 16);
  header.writeUInt32LE(1, 28);
  header.writeUInt32LE(32, 76);
  header.writeUInt32LE(0x4, 80);
  header.write(fourCC, 84, 'ascii');
  return Buffer.concat([header, ...blocks]);
}

// One 8-byte DXT1 block: c0/c1 + 2-bit indices (all index0 → c0).
function dxt1Block(c0, c1, bits = 0) {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(c0, 0);
  b.writeUInt16LE(c1, 2);
  b.writeUInt32LE(bits, 4);
  return b;
}

// One 16-byte DXT5 block: alpha endpoints + 48-bit alpha indices, then the
// DXT1-style colour endpoints + 32-bit colour indices.
function dxt5Block(c0, c1, colorBits = 0, { a0 = 255, a1 = 0, alphaBits = 0n } = {}) {
  const b = Buffer.alloc(16);
  b[0] = a0;
  b[1] = a1;
  let ab = BigInt(alphaBits);
  for (let i = 0; i < 6; i++) { b[2 + i] = Number(ab & 0xffn); ab >>= 8n; }
  b.writeUInt16LE(c0, 8);
  b.writeUInt16LE(c1, 10);
  b.writeUInt32LE(colorBits, 12);
  return b;
}

// One 16-byte DXT3 block: 8 bytes of 4-bit alpha (nibble * 17), then colour.
function dxt3Block(c0, c1, colorBits = 0, nibble = 0xf) {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) b[i] = ((nibble << 4) | nibble) & 0xff;
  b.writeUInt16LE(c0, 8);
  b.writeUInt16LE(c1, 10);
  b.writeUInt32LE(colorBits, 12);
  return b;
}

function pngInfo(buf) {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(buf.toString('ascii', 12, 16)).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), depth: buf[24], color: buf[25] };
}

// Walks the PNG chunks and returns the concatenated IDAT payload.
function pngIdat(buf) {
  const parts = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') parts.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

describe('decodeDds', () => {
  it('decodes a solid DXT1 4×4 block to the endpoint colour', () => {
    const buf = makeDds(4, 4, 'DXT1', [dxt1Block(0xffff, 0x0000)]);
    const out = decodeDds(buf);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    expect(Array.from(out.rgba.subarray(0, 4))).toEqual([255, 255, 255, 255]);
  });

  it('rejects a non-DDS buffer', () => {
    expect(decodeDds(Buffer.from('not a dds'))).toBeNull();
  });

  it('rejects an unsupported fourCC', () => {
    const buf = makeDds(4, 4, 'BC5U', [Buffer.alloc(16)]);
    expect(decodeDds(buf)).toBeNull();
  });

  it('rejects a truncated block payload', () => {
    const buf = makeDds(4, 4, 'DXT1', []);
    expect(decodeDds(buf)).toBeNull();
  });

  it('rejects out-of-range dimensions and a too-short buffer', () => {
    expect(decodeDds(makeDds(8193, 4, 'DXT1', [dxt1Block(0xffff, 0x0000)]))).toBeNull();
    expect(decodeDds(makeDds(0, 4, 'DXT1', []))).toBeNull();
    expect(decodeDds(Buffer.alloc(64))).toBeNull();
  });

  it('blends the 1/3 + 2/3 colours when c0 > c1', () => {
    // index 2 = round((2*c0 + c1)/3) = round((2*255 + 0)/3) = 170 (white/black).
    const buf = makeDds(4, 4, 'DXT1', [dxt1Block(0xffff, 0x0000, 2)]);
    const out = decodeDds(buf);
    expect(Array.from(out.rgba.subarray(0, 4))).toEqual([170, 170, 170, 255]);
  });

  it('uses the transparent-black mode when c0 <= c1', () => {
    // index 3 is transparent black; index 2 is the 50% average.
    const transparent = decodeDds(makeDds(4, 4, 'DXT1', [dxt1Block(0x0000, 0xffff, 3)]));
    expect(Array.from(transparent.rgba.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    const half = decodeDds(makeDds(4, 4, 'DXT1', [dxt1Block(0x0000, 0xffff, 2)]));
    expect(Array.from(half.rgba.subarray(0, 4))).toEqual([128, 128, 128, 255]);
  });

  it('decodes a DXT5 block (alpha + colour)', () => {
    const buf = makeDds(4, 4, 'DXT5', [dxt5Block(0xffff, 0x0000)]);
    const out = decodeDds(buf);
    expect(out.width).toBe(4);
    expect(Array.from(out.rgba.subarray(0, 4))).toEqual([255, 255, 255, 255]);
  });

  it('applies DXT5 interpolated alpha indices', () => {
    // pixel0 alpha index 1 → a1 (0); every other pixel stays on a0 (255).
    const buf = makeDds(4, 4, 'DXT5', [dxt5Block(0xffff, 0x0000, 0, { a0: 255, a1: 0, alphaBits: 1n })]);
    const out = decodeDds(buf);
    expect(out.rgba[3]).toBe(0);
    expect(out.rgba[7]).toBe(255);
  });

  it('decodes a DXT3 block (explicit 4-bit alpha)', () => {
    const opaque = decodeDds(makeDds(4, 4, 'DXT3', [dxt3Block(0xffff, 0x0000, 0, 0xf)]));
    expect(Array.from(opaque.rgba.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    const clear = decodeDds(makeDds(4, 4, 'DXT3', [dxt3Block(0xffff, 0x0000, 0, 0x0)]));
    expect(clear.rgba[3]).toBe(0);
  });
});

describe('encodePng', () => {
  it('emits a valid RGBA PNG whose IHDR matches the source size', () => {
    const rgba = Buffer.alloc(4);
    rgba[0] = 10; rgba[1] = 20; rgba[2] = 30; rgba[3] = 255;
    const png = encodePng(1, 1, rgba);
    const info = pngInfo(png);
    expect(info.width).toBe(1);
    expect(info.height).toBe(1);
    expect(info.depth).toBe(8);
    expect(info.color).toBe(6);
    expect(png.toString('ascii', png.length - 8, png.length - 4)).toBe('IEND');
  });
});

describe('ddsToPngDataUrl', () => {
  it('round-trips a DXT1 texture into a PNG data-URL', () => {
    const buf = makeDds(4, 4, 'DXT1', [dxt1Block(0xf800, 0x001f)]); // red > blue
    const url = ddsToPngDataUrl(buf);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    const png = Buffer.from(url.split(',')[1], 'base64');
    const info = pngInfo(png);
    expect(info.width).toBe(4);
    expect(info.height).toBe(4);
    const raw = zlib.inflateSync(pngIdat(png));
    // First scanline: filter byte 0 then the colour0 endpoint (pure red).
    expect(raw[0]).toBe(0);
    expect(Array.from(raw.subarray(1, 5))).toEqual([255, 0, 0, 255]);
  });

  it('encodes a DXT5 texture into a PNG data-URL', () => {
    const url = ddsToPngDataUrl(makeDds(4, 4, 'DXT5', [dxt5Block(0xffff, 0x0000)]));
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    const png = Buffer.from(url.split(',')[1], 'base64');
    const info = pngInfo(png);
    expect(info.width).toBe(4);
    expect(info.height).toBe(4);
  });

  it('flips Y so the PNG matches the in-game BaseMap orientation', () => {
    // Top block red, bottom block blue — a non-uniform texture, so the flip is
    // observable. The game ships its DDS BaseMaps bottom-up; the PNG must come
    // out top-down (the community livery packs are a clean vertical flip of the
    // shipped defaults).
    const buf = makeDds(4, 8, 'DXT1', [dxt1Block(0xf800, 0x0000), dxt1Block(0x001f, 0x0000)]);
    const png = Buffer.from(ddsToPngDataUrl(buf).split(',')[1], 'base64');
    const raw = zlib.inflateSync(pngIdat(png));
    const stride = 4 * 4;
    // First scanline is the DDS's bottom row (blue)…
    expect(raw[0]).toBe(0);
    expect(Array.from(raw.subarray(1, 5))).toEqual([0, 0, 255, 255]);
    // …and the last scanline is its top row (red).
    const last = (8 - 1) * (stride + 1) + 1;
    expect(Array.from(raw.subarray(last, last + 4))).toEqual([255, 0, 0, 255]);
  });

  it('returns null for an unsupported texture', () => {
    expect(ddsToPngDataUrl(Buffer.from('nope'))).toBeNull();
  });
});

// Guard against a bad zlib stream: inflate what we wrote and check the filter
// byte + first pixel survive the round-trip.
describe('encodePng round-trip', () => {
  it('inflates back to a filter-0 raw stream', () => {
    const rgba = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const png = encodePng(2, 1, rgba);
    const raw = zlib.inflateSync(pngIdat(png));
    expect(raw.length).toBe(2 * 4 + 1);
    expect(raw[0]).toBe(0);
    expect(Array.from(raw.subarray(1))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
