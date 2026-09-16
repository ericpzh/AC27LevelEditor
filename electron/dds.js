// ─── DDS (DXT1/DXT5) → RGBA + minimal PNG encoder ───────────
// Pure CommonJS, no native deps. The game ships its built-in aircraft
// default liveries as .dds textures (BaseMap = DXT1/BC1); the livery painter
// uses them as the per-aircraft UV template background, so main decodes them
// to a PNG data-URL the renderer can draw like any other image.
//
// Orientation: the game stores those DDS BaseMaps bottom-up, i.e. vertically
// mirrored from the PNG orientation the engine (and the community livery packs)
// actually use as a BaseMap. A default decoded as-is paints the UV atlas upside
// down, so `ddsToPngDataUrl` flips Y; `decodeDds` itself stays a raw decoder.

const zlib = require('zlib');

const DDS_MAGIC = 0x20534444; // "DDS "

// ── DXT1 / DXT5 palette helpers ─────────────────────────────
function rgb565(c) {
  const r = (c >> 11) & 0x1f;
  const g = (c >> 5) & 0x3f;
  const b = c & 0x1f;
  return [
    (r << 3) | (r >> 2),
    (g << 2) | (g >> 4),
    (b << 3) | (b >> 2),
  ];
}

// Builds the 4-entry RGBA palette for a colour block. DXT1 uses the
// 3-colour + transparent-black mode when color0 <= color1; DXT5 (forceFour)
// always uses the 4-colour mode.
function buildPalette(c0, c1, forceFour) {
  const a = rgb565(c0);
  const b = rgb565(c1);
  const pal = [
    [a[0], a[1], a[2], 255],
    [b[0], b[1], b[2], 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ];
  if (forceFour || c0 > c1) {
    pal[2] = [
      Math.round((2 * a[0] + b[0]) / 3),
      Math.round((2 * a[1] + b[1]) / 3),
      Math.round((2 * a[2] + b[2]) / 3),
      255,
    ];
    pal[3] = [
      Math.round((a[0] + 2 * b[0]) / 3),
      Math.round((a[1] + 2 * b[1]) / 3),
      Math.round((a[2] + 2 * b[2]) / 3),
      255,
    ];
  } else {
    pal[2] = [
      Math.round((a[0] + b[0]) / 2),
      Math.round((a[1] + b[1]) / 2),
      Math.round((a[2] + b[2]) / 2),
      255,
    ];
    pal[3] = [0, 0, 0, 0]; // transparent black
  }
  return pal;
}

function writeBlock(rgba, width, height, bx, by, pal, colorBits, alphaBits) {
  for (let py = 0; py < 4; py++) {
    const y = by * 4 + py;
    if (y >= height) break;
    for (let px = 0; px < 4; px++) {
      const x = bx * 4 + px;
      if (x >= width) continue;
      const bit = py * 4 + px;
      const ci = (colorBits >>> (2 * bit)) & 0x3;
      const o = (y * width + x) * 4;
      const c = pal[ci];
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = alphaBits == null ? c[3] : alphaBits[bit];
    }
  }
}

function decodeDxt5Alpha(block, ai) {
  const a0 = block[ai];
  const a1 = block[ai + 1];
  const alpha = new Uint8Array(16);
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits |= BigInt(block[ai + 2 + i]) << BigInt(8 * i);
  const pal = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) {
    for (let i = 1; i <= 6; i++) pal[1 + i] = Math.round(((7 - i) * a0 + i * a1) / 7);
  } else {
    for (let i = 1; i <= 4; i++) pal[1 + i] = Math.round(((5 - i) * a0 + i * a1) / 5);
    pal[6] = 0;
    pal[7] = 255;
  }
  for (let i = 0; i < 16; i++) {
    const idx = Number((bits >> BigInt(3 * i)) & 7n);
    alpha[i] = pal[idx];
  }
  return alpha;
}

// Decodes a DDS buffer to { width, height, rgba }. Only the top mip level is
// read (the painter never needs mips). Supports DXT1/BC1 and DXT5/BC3.
function decodeDds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 128) return null;
  if (buf.readUInt32LE(0) !== DDS_MAGIC) return null;
  const height = buf.readUInt32LE(12);
  const width = buf.readUInt32LE(16);
  if (!width || !height || width > 8192 || height > 8192) return null;
  const fourCC = buf.toString('ascii', 84, 88);
  let dataOff = 128;
  if (fourCC === 'DX10') dataOff = 148;
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));

  const rgba = Buffer.alloc(width * height * 4);
  const isDxt1 = fourCC === 'DXT1';
  const isDxt5 = fourCC === 'DXT5';
  const isDxt3 = fourCC === 'DXT3';
  if (!isDxt1 && !isDxt5 && !isDxt3) return null;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = dataOff + (by * blocksX + bx) * (isDxt1 ? 8 : 16);
      if (off + (isDxt1 ? 8 : 16) > buf.length) return null;
      if (isDxt1) {
        const c0 = buf.readUInt16LE(off);
        const c1 = buf.readUInt16LE(off + 2);
        const bits = buf.readUInt32LE(off + 4);
        writeBlock(rgba, width, height, bx, by, buildPalette(c0, c1, false), bits, null);
      } else if (isDxt3) {
        const c0 = buf.readUInt16LE(off + 8);
        const c1 = buf.readUInt16LE(off + 10);
        const bits = buf.readUInt32LE(off + 12);
        const alpha = new Uint8Array(16);
        for (let i = 0; i < 8; i++) {
          const byte = buf[off + i];
          alpha[i * 2] = (byte & 0x0f) * 17;
          alpha[i * 2 + 1] = (byte >> 4) * 17;
        }
        writeBlock(rgba, width, height, bx, by, buildPalette(c0, c1, true), bits, alpha);
      } else {
        const alpha = decodeDxt5Alpha(buf, off);
        const c0 = buf.readUInt16LE(off + 8);
        const c1 = buf.readUInt16LE(off + 10);
        const bits = buf.readUInt32LE(off + 12);
        writeBlock(rgba, width, height, bx, by, buildPalette(c0, c1, true), bits, alpha);
      }
    }
  }
  return { width, height, rgba };
}

// ── Minimal PNG encoder (RGBA8, filter 0) ───────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // colour type RGBA
  ihdr.writeUInt8(0, 10);  // compression
  ihdr.writeUInt8(0, 11);  // filter
  ihdr.writeUInt8(0, 12);  // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Returns the RGBA buffer flipped vertically (top row <-> bottom row).
function flipY(width, height, rgba) {
  const stride = width * 4;
  const out = Buffer.alloc(rgba.length);
  for (let y = 0; y < height; y++) {
    rgba.copy(out, y * stride, (height - 1 - y) * stride, (height - y) * stride);
  }
  return out;
}

// Decodes a DDS buffer and returns a PNG data-URL, or null when unsupported.
// Y-flipped: the shipped DDS BaseMaps are bottom-up relative to the PNG
// orientation the engine uses for a painted BaseMap (see the file header).
function ddsToPngDataUrl(buf) {
  const decoded = decodeDds(buf);
  if (!decoded) return null;
  const rgba = flipY(decoded.width, decoded.height, decoded.rgba);
  const png = encodePng(decoded.width, decoded.height, rgba);
  return 'data:image/png;base64,' + png.toString('base64');
}

module.exports = { decodeDds, encodePng, ddsToPngDataUrl };
