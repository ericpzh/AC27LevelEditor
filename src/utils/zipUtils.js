// ─── Minimal ZIP create / extract using Node.js built-ins only ───
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC-32 lookup table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime() {
  const d = new Date();
  return ((d.getFullYear() - 1980) << 25) | ((d.getMonth() + 1) << 21) | (d.getDate() << 16)
       | (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
}

function writeU32(buf, off, v) { buf.writeUInt32LE(v, off); }
function writeU16(buf, off, v) { buf.writeUInt16LE(v, off); }

/**
 * Create a ZIP file from a list of { name, data } entries.
 * Uses DEFLATE (method 8).
 */
function createZip(entries, outputPath) {
  const centralDir = [];
  let offset = 0;
  const parts = [];

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(raw);
    const compressed = zlib.deflateRawSync(raw);
    const method = compressed.length < raw.length ? 8 : 0;
    const store = method === 0 ? raw : compressed;
    const dosTime = dosDateTime();

    // Local file header
    const lh = Buffer.alloc(30 + nameBuf.length);
    writeU32(lh, 0, 0x04034b50);
    writeU16(lh, 4, 20);            // version needed
    writeU16(lh, 6, 0x0800);        // bit 11 = UTF-8
    writeU16(lh, 8, method);
    writeU32(lh, 10, dosTime);
    writeU32(lh, 14, crc);
    writeU32(lh, 18, store.length);
    writeU32(lh, 22, raw.length);
    writeU16(lh, 26, nameBuf.length);
    writeU16(lh, 28, 0);            // extra field length
    nameBuf.copy(lh, 30);

    parts.push(lh, store);
    centralDir.push({ nameBuf, crc, method, dosTime, rawLen: raw.length, compLen: store.length, offset });
    offset += lh.length + store.length;
  }

  // Central directory
  const cdParts = [];
  let cdOffset = offset;
  for (const e of centralDir) {
    const cd = Buffer.alloc(46 + e.nameBuf.length);
    writeU32(cd, 0, 0x02014b50);
    writeU16(cd, 4, 20);            // version made by
    writeU16(cd, 6, 20);            // version needed
    writeU16(cd, 8, 0x0800);        // UTF-8
    writeU16(cd, 10, e.method);
    writeU32(cd, 12, e.dosTime);
    writeU32(cd, 16, e.crc);
    writeU32(cd, 20, e.compLen);
    writeU32(cd, 24, e.rawLen);
    writeU16(cd, 28, e.nameBuf.length);
    writeU16(cd, 30, 0);
    writeU16(cd, 32, 0);
    writeU32(cd, 34, 0);
    writeU32(cd, 38, 0);
    writeU32(cd, 42, e.offset);
    e.nameBuf.copy(cd, 46);
    cdParts.push(cd);
  }
  const cdSize = cdParts.reduce((s, b) => s + b.length, 0);

  // End of central directory
  const eocd = Buffer.alloc(22);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 4, 0);
  writeU16(eocd, 6, 0);
  writeU16(eocd, 8, centralDir.length);
  writeU16(eocd, 10, centralDir.length);
  writeU32(eocd, 12, cdSize);
  writeU32(eocd, 16, cdOffset);
  writeU16(eocd, 20, 0);

  const all = Buffer.concat([...parts, ...cdParts, eocd]);
  fs.writeFileSync(outputPath, all);
}

/**
 * Read a ZIP's file listing (names only) for validation.
 */
function listZipFiles(zipPath) {
  const buf = fs.readFileSync(zipPath);
  // Find EOCD signature
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new Error('Invalid ZIP: EOCD not found');

  const cdOffset = buf.readUInt32LE(eocdOff + 16);
  const cdCount = buf.readUInt16LE(eocdOff + 8);

  const names = [];
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid central directory entry');
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    names.push(buf.toString('utf-8', pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * Extract a ZIP to a target directory (overwrites existing).
 */
function extractZip(zipPath, targetDir) {
  const buf = fs.readFileSync(zipPath);

  // Find EOCD
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new Error('Invalid ZIP: EOCD not found');

  const cdOffset = buf.readUInt32LE(eocdOff + 16);
  const cdCount = buf.readUInt16LE(eocdOff + 8);

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid central directory entry');
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf-8', pos + 46, pos + 46 + nameLen);

    // Read local header
    let lp = localOff;
    const lhSig = buf.readUInt32LE(lp);
    if (lhSig !== 0x04034b50) throw new Error(`Invalid local header for ${name}`);
    const lnameLen = buf.readUInt16LE(lp + 26);
    const lextraLen = buf.readUInt16LE(lp + 28);
    const dataOff = lp + 30 + lnameLen + lextraLen;
    const compressed = buf.subarray(dataOff, dataOff + compSize);

    let data;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported compression method ${method} for ${name}`);
    }

    // Verify CRC
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);

    // Normalize separators to platform separator (ZIPs may use / on Windows)
    const normalizedName = name.replace(/[/\\]/g, path.sep);
    const outPath = path.join(targetDir, normalizedName);

    // Skip directory entries (trailing separator or zero-size entries that represent dirs)
    const isDir = normalizedName.endsWith(path.sep) || (uncompSize === 0 && compSize === 0);
    if (isDir) {
      if (!fs.existsSync(outPath)) fs.mkdirSync(outPath, { recursive: true });
    } else {
      // Always ensure parent directory exists — unconditional mkdirSync avoids
      // edge cases where existsSync returns a false negative on Windows.
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, data);
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }
}

module.exports = { createZip, listZipFiles, extractZip };
