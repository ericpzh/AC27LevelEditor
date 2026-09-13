/**
 * GATCARC4 archive container — the binary .acl format introduced by the 2026-07 game
 * update (game code: ContextCross.Saves.SaveSystem, "append-only GATCARC4 format").
 *
 * Container layout (all integers little-endian):
 *   v1 (storage version 1):
 *     Header segment:
 *       [0..7]   ASCII magic "GATCARC4"
 *       [8..11]  uint32 storage version (1)
 *       [12..15] uint32 payload length N
 *       [16..16+N)          payload: OdinSerializer binary document
 *                           (root: ContextCross.Saves.SaveSystem+ArchiveHeader)
 *       [16+N..16+N+32)     SHA-256 of the payload bytes
 *       [16+N+32..16+N+36)  ASCII commit marker "NODH"
 *     Zero or more appended checkpoint frames, each:
 *       [0..3]   ASCII frame marker "MARF"
 *       [4..7]   uint32 storage version (1)
 *       [8..11]  uint32 payload length M
 *       [12..12+M)          payload: OdinSerializer binary document
 *                           (root: ContextCross.Saves.SaveSystem+CheckpointFrame)
 *       [12+M..12+M+32)     SHA-256 of the payload bytes
 *       [12+M+32..12+M+36)  ASCII commit marker "NODF"
 *
 *   v2 (storage version 2, introduced 2026-09 game update):
 *     Header segment:
 *       [0..7]   ASCII magic "GATCARC4"
 *       [8..11]  uint32 storage version (2)
 *       [12..15] uint32 payload length N
 *       [16..16+N)          payload: UTF-8 JSON {schemaHash, archiveGuid, levelGuid, airportIcao, ...}
 *       [16+N..16+N+32)     SHA-256 of the payload bytes
 *       [16+N+32..16+N+36)  ASCII commit marker "NODS"  (was "NODH" in v1)
 *     Main LevelPayload segment (no magic, length-prefixed):
 *       [0..3]   uint32 payload length P
 *       [4..4+P)            payload: OdinSerializer binary document
 *                           (root: ContextCross.Saves.SaveSystem+LevelPayload, GroundATC.Core)
 *       [4+P..4+P+32)       SHA-256 of the payload bytes
 *       [4+P+32..4+P+36)    ASCII commit marker "NODH"
 *     Zero or more checkpoint frames, each:
 *       [0..3]   ASCII frame marker "MARF"
 *       [4..7]   uint32 storage version (2)
 *       [8..11]  uint32 payload length M
 *       [12..12+M)          payload: checkpoint frame blob
 *                           internal: [4 jsonLen][json][32 jsonHash][4 binLen][binPayload][32 binHash][NODF?]
 *                           (no outer SHA-256 — the two inner hashes cover the content;
 *                            the trailing 4 bytes of the payload are "NODF" itself)
 *       — v1 frames had outer [32 hash][NODF] after the payload; v2 embeds the commit
 *         inside the payload and has no outer hash. The parser handles both.
 *
 * Nested payloads: byte[] fields such as ArchiveHeader.StaticData and
 * RuntimeSnapshot.RuntimeData contain complete nested Odin binary documents.
 * They are decoded inline as "$blobdoc": { ... } entries (and re-serialized from
 * them on encode) so the text form is readable and fully reversible.
 *
 * Decoded text form: each segment becomes one Odin JSON document (the game's
 * legacy text .acl dialect); frame documents follow the header document,
 * separated by a FRAME_SENTINEL line. For v2 the "header document" is the
 * decoded LevelPayload (the only user-editable content); the JSON header
 * (schemaHash etc) is preserved opaquely.
 *
 * This module is the only API the rest of the editor uses:
 *   readAclText(path)  — universal read: binary -> decoded Odin JSON text, text -> as-is
 *   writeAcl(path, text, { format }) — write preserving the on-disk container format
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { readBinary } = require('./odin/binary_reader');
const { OdinJsonWriter } = require('./odin/json_writer');
const { readJson } = require('./odin/json_reader');
const { OdinBinaryWriter } = require('./odin/binary_writer');
const { renumberAclIds, countIdDescents } = require('./id_renumber');

const MAGIC = Buffer.from('GATCARC4', 'ascii');
const FRAME_MARKER = Buffer.from('MARF', 'ascii');
const HEADER_COMMIT = Buffer.from('NODH', 'ascii'); // v1 header commit
const HEADER_COMMIT_V2 = Buffer.from('NODS', 'ascii'); // v2 header commit
const FRAME_COMMIT = Buffer.from('NODF', 'ascii');
const STORAGE_VERSION = 1;
const STORAGE_VERSION_LATEST = 2;
const SUPPORTED_VERSIONS = [1, 2];
const HASH_LENGTH = 32;
const DEFAULT_SCHEMA_HASH = '0a8aa9630c0a3a1a3465c85fab2873e9bd9d3036fa16aff9b72cd62b8b3e9f4e';

const FRAME_SENTINEL = '$$$ GATCARC4 CHECKPOINT FRAME $$$';
// Tolerant of newline flavor: editor tooling may normalize CRLF to LF
const RE_FRAME_SENTINEL = /\r?\n\$\$\$ GATCARC4 CHECKPOINT FRAME \$\$\$\r?\n/;

/** True if the buffer (or the file at the given path) starts with the GATCARC4 magic. */
function isGatcArchive(bufferOrPath) {
  let head;
  if (Buffer.isBuffer(bufferOrPath)) {
    head = bufferOrPath;
  } else {
    const fd = fs.openSync(bufferOrPath, 'r');
    try {
      head = Buffer.alloc(8);
      fs.readSync(fd, head, 0, 8, 0);
    } finally {
      fs.closeSync(fd);
    }
  }
  return head.length >= 8 && head.subarray(0, 8).equals(MAGIC);
}

function getStorageVersion(buffer) {
  if (buffer.length < 12) return null;
  if (!buffer.subarray(0, 8).equals(MAGIC)) return null;
  return buffer.readUInt32LE(8);
}

function parseSegment(buffer, offset, marker, commitMarker, what) {
  if (!buffer.subarray(offset, offset + marker.length).equals(marker)) {
    throw new Error(`GATCARC4: bad ${what} marker at offset ${offset}`);
  }
  let pos = offset + marker.length;
  const version = buffer.readUInt32LE(pos); pos += 4;
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(`GATCARC4: unsupported ${what} storage version ${version} (expected ${SUPPORTED_VERSIONS.join(' or ')})`);
  }
  const payloadLength = buffer.readUInt32LE(pos); pos += 4;
  const end = pos + payloadLength + HASH_LENGTH + commitMarker.length;
  if (buffer.length < end) {
    throw new Error(`GATCARC4: truncated ${what} (need ${end} bytes, have ${buffer.length})`);
  }
  const payload = buffer.subarray(pos, pos + payloadLength);
  const storedHash = buffer.subarray(pos + payloadLength, pos + payloadLength + HASH_LENGTH);
  const actualHash = crypto.createHash('sha256').update(payload).digest();
  if (!storedHash.equals(actualHash)) {
    throw new Error(`GATCARC4: ${what} payload SHA-256 mismatch (archive is corrupt)`);
  }
  const markerStart = pos + payloadLength + HASH_LENGTH;
  if (!buffer.subarray(markerStart, markerStart + commitMarker.length).equals(commitMarker)) {
    throw new Error(`GATCARC4: missing "${commitMarker.toString('ascii')}" commit marker for ${what}`);
  }
  return { payload, end, version };
}

/**
 * v2 parser — validates the whole container.
 * Returns { version: 2, header: Buffer (JSON), headerJson: string, mainPayload: Buffer, frames: Buffer[], headerEnd, mainEnd, framesRaw }
 */
function parseV2Archive(buffer) {
  if (buffer.length < 16 + HASH_LENGTH + HEADER_COMMIT_V2.length) {
    throw new Error(`GATCARC4: file too small (${buffer.length} bytes)`);
  }
  if (!buffer.subarray(0, 8).equals(MAGIC)) {
    throw new Error('GATCARC4: bad magic (not a GATCARC4 archive)');
  }
  const headerVersion = buffer.readUInt32LE(8);
  if (headerVersion !== 2) {
    throw new Error(`GATCARC4: unsupported header storage version ${headerVersion} (expected 2 for v2 parse)`);
  }
  const headerLen = buffer.readUInt32LE(12);
  const headerPayloadStart = 16;
  const headerPayloadEnd = headerPayloadStart + headerLen;
  if (buffer.length < headerPayloadEnd + HASH_LENGTH + 4) {
    throw new Error(`GATCARC4: truncated v2 header (need ${headerPayloadEnd + HASH_LENGTH + 4} bytes, have ${buffer.length})`);
  }
  const headerPayload = buffer.subarray(headerPayloadStart, headerPayloadEnd);
  const storedHeaderHash = buffer.subarray(headerPayloadEnd, headerPayloadEnd + HASH_LENGTH);
  const actualHeaderHash = crypto.createHash('sha256').update(headerPayload).digest();
  if (!storedHeaderHash.equals(actualHeaderHash)) {
    throw new Error('GATCARC4: v2 header payload SHA-256 mismatch (archive is corrupt)');
  }
  const headerCommit = buffer.subarray(headerPayloadEnd + HASH_LENGTH, headerPayloadEnd + HASH_LENGTH + 4);
  if (!headerCommit.equals(HEADER_COMMIT_V2)) {
    // tolerate NODH for downgraded v2 files, but normally expect NODS
    if (!headerCommit.equals(HEADER_COMMIT)) {
      throw new Error(`GATCARC4: missing "${HEADER_COMMIT_V2.toString('ascii')}" commit marker for v2 header (got "${headerCommit.toString('ascii')}")`);
    }
  }
  const headerEnd = headerPayloadEnd + HASH_LENGTH + 4;

  // Main LevelPayload segment
  let pos = headerEnd;
  if (pos + 4 > buffer.length) {
    throw new Error(`GATCARC4: truncated v2 main length at offset ${pos}`);
  }
  const mainLen = buffer.readUInt32LE(pos); pos += 4;
  if (pos + mainLen + HASH_LENGTH + 4 > buffer.length) {
    // Might be truncated if frames exist? Check precisely
    throw new Error(`GATCARC4: truncated v2 main payload (need ${pos + mainLen + HASH_LENGTH + 4} bytes, have ${buffer.length})`);
  }
  const mainPayload = buffer.subarray(pos, pos + mainLen); pos += mainLen;
  const storedMainHash = buffer.subarray(pos, pos + HASH_LENGTH); pos += HASH_LENGTH;
  const actualMainHash = crypto.createHash('sha256').update(mainPayload).digest();
  if (!storedMainHash.equals(actualMainHash)) {
    throw new Error('GATCARC4: v2 main payload SHA-256 mismatch (archive is corrupt)');
  }
  const mainCommit = buffer.subarray(pos, pos + 4); pos += 4;
  if (!mainCommit.equals(HEADER_COMMIT)) {
    throw new Error(`GATCARC4: missing "NODH" commit marker for v2 main payload (got "${mainCommit.toString('ascii')}")`);
  }
  const mainEnd = pos;

  // Checkpoint frames
  const frames = [];
  let framesRawStart = pos;
  while (pos < buffer.length) {
    if (pos + 12 > buffer.length) {
      throw new Error(`GATCARC4: truncated v2 frame header at offset ${pos}`);
    }
    if (!buffer.subarray(pos, pos + 4).equals(FRAME_MARKER)) {
      throw new Error(`GATCARC4: bad frame marker at offset ${pos} (expected MARF, got "${buffer.subarray(pos, pos + 4).toString('ascii')}")`);
    }
    const frameVersion = buffer.readUInt32LE(pos + 4);
    if (!SUPPORTED_VERSIONS.includes(frameVersion)) {
      throw new Error(`GATCARC4: unsupported frame storage version ${frameVersion} (expected ${SUPPORTED_VERSIONS.join(' or ')})`);
    }
    const frameLen = buffer.readUInt32LE(pos + 8);
    if (pos + 12 + frameLen > buffer.length) {
      throw new Error(`GATCARC4: truncated frame ${frames.length + 1} payload (need ${pos + 12 + frameLen} bytes, have ${buffer.length})`);
    }
    const framePayload = buffer.subarray(pos + 12, pos + 12 + frameLen);
    const endsWithNODF = framePayload.length >= 4 && framePayload.subarray(framePayload.length - 4).equals(FRAME_COMMIT);
    if (endsWithNODF) {
      // v2 style: commit embedded in payload, no outer hash
      frames.push(framePayload);
      pos += 12 + frameLen;
    } else {
      // v1 style with outer hash+commit after payload
      if (pos + 12 + frameLen + HASH_LENGTH + 4 > buffer.length) {
        throw new Error(`GATCARC4: truncated frame ${frames.length + 1} outer hash/commit`);
      }
      const outerHash = buffer.subarray(pos + 12 + frameLen, pos + 12 + frameLen + HASH_LENGTH);
      const outerCommit = buffer.subarray(pos + 12 + frameLen + HASH_LENGTH, pos + 12 + frameLen + HASH_LENGTH + 4);
      if (!outerCommit.equals(FRAME_COMMIT)) {
        throw new Error(`GATCARC4: missing "NODF" commit marker for frame ${frames.length + 1}`);
      }
      const actualOuterHash = crypto.createHash('sha256').update(framePayload).digest();
      if (!outerHash.equals(actualOuterHash)) {
        throw new Error(`GATCARC4: frame ${frames.length + 1} payload SHA-256 mismatch`);
      }
      frames.push(framePayload);
      pos += 12 + frameLen + HASH_LENGTH + 4;
    }
  }

  let headerJson = null;
  try { headerJson = headerPayload.toString('utf-8'); JSON.parse(headerJson); } catch (_) { headerJson = headerPayload.toString('utf-8'); }

  return {
    version: 2,
    header: headerPayload,
    headerJson,
    headerEnd,
    mainPayload,
    mainEnd,
    frames,
    framesRawStart,
    framesRaw: buffer.subarray(mainEnd),
    rawHeaderSegment: buffer.subarray(0, headerEnd),
  };
}

/**
 * Parses + validates the whole container.
 * Returns { version, header: Buffer, frames: Buffer[] } (payload subarrays).
 * Supports both v1 and v2 transparently.
 */
function parseArchive(buffer) {
  const ver = getStorageVersion(buffer);
  if (ver === 2) {
    const v2 = parseV2Archive(buffer);
    // For backward compat with callers expecting v1 shape, map v2's main payload to header
    return { version: 2, header: v2.mainPayload, frames: v2.frames, _v2: v2 };
  }
  if (buffer.length < 16 + HASH_LENGTH + HEADER_COMMIT.length) {
    throw new Error(`GATCARC4: file too small (${buffer.length} bytes)`);
  }
  if (!buffer.subarray(0, 8).equals(MAGIC)) {
    throw new Error('GATCARC4: bad magic (not a GATCARC4 archive)');
  }
  const headerSeg = parseSegment(buffer, 0, MAGIC, HEADER_COMMIT, 'header');
  // For v1 the parseSegment already validated version; ensure it's 1
  // For version 2 routed above, we already returned
  const frames = [];
  let pos = headerSeg.end;
  while (pos < buffer.length) {
    const frameSeg = parseSegment(buffer, pos, FRAME_MARKER, FRAME_COMMIT, `frame ${frames.length + 1}`);
    frames.push(frameSeg.payload);
    pos = frameSeg.end;
  }
  return { version: headerSeg.version || STORAGE_VERSION, header: headerSeg.payload, frames };
}

/** Decode one Odin binary payload to text, with nested byte[] documents inlined as $blobdoc. */
function decodePayloadToText(payload, depth = 0) {
  const sink = new OdinJsonWriter({
    tryDecodeBlob: depth >= 8 ? null : (raw) => {
      try {
        return decodePayloadToText(raw, depth + 1);
      } catch (_) {
        return null; // not a nested document — fall back to a raw byte list
      }
    },
  });
  readBinary(payload, sink);
  return sink.getText();
}

/** Encode one Odin JSON document to a binary payload ($blobdoc handled by the reader). */
function encodeTextToPayload(text) {
  const sink = new OdinBinaryWriter();
  readJson(text, sink);
  return sink.getBuffer();
}

/**
 * Decode a GATCARC4 archive buffer into Odin JSON text (the legacy .acl text dialect).
 * Multi-segment archives produce one document per segment, separated by FRAME_SENTINEL lines.
 */
function decodeArchive(buffer) {
  const ver = getStorageVersion(buffer);
  if (ver === 2) {
    return decodeV2Archive(buffer);
  }
  const { header, frames } = parseArchive(buffer);
  const docs = [decodePayloadToText(header)];
  for (const frame of frames) docs.push(decodePayloadToText(frame));
  return docs.join('\r\n' + FRAME_SENTINEL + '\r\n');
}

/**
 * Decode a v2 GATCARC4 archive buffer into Odin JSON text.
 * The text is the decoded LevelPayload (main segment). Checkpoint frames are
 * decoded if their inner binary payload is decodable and appended with sentinel
 * for round-trip preservation; otherwise they are skipped (preserved verbatim on write).
 */
function decodeV2Archive(buffer) {
  const v2 = parseV2Archive(buffer);
  const docs = [decodePayloadToText(v2.mainPayload)];
  // Attempt to decode checkpoint frame inner binary payloads for completeness.
  // Each v2 frame payload is: [4 jsonLen][json][32 jsonHash][4 binLen][binPayload][32 binHash][NODF?]
  // We extract binPayload and try to decode it; if it looks like Odin binary, add as extra doc.
  for (const fp of v2.frames) {
    try {
      if (fp.length < 4) continue;
      const jsonLen = fp.readUInt32LE(0);
      if (jsonLen + 4 + 32 > fp.length) continue;
      const afterJson = fp.subarray(4 + jsonLen + 32);
      if (afterJson.length < 4) continue;
      const binLen = afterJson.readUInt32LE(0);
      if (binLen + 4 + 32 > afterJson.length) continue;
      const binPayload = afterJson.subarray(4, 4 + binLen);
      // Verify bin hash before decoding
      const storedBinHash = afterJson.subarray(4 + binLen, 4 + binLen + 32);
      const calcBinHash = crypto.createHash('sha256').update(binPayload).digest();
      if (!storedBinHash.equals(calcBinHash)) continue;
      // Try decode
      const innerText = decodePayloadToText(binPayload);
      // Heuristic: only add if it looks like a checkpoint (contains Checkpoint or LevelPayload)
      if (innerText.includes('Checkpoint') || innerText.includes('LevelPayload') || innerText.includes('SaveSystem')) {
        docs.push(innerText);
      }
    } catch (_) {
      // ignore frame decode errors — frames are preserved verbatim on write
    }
  }
  return docs.join('\r\n' + FRAME_SENTINEL + '\r\n');
}

function buildSegment(marker, commitMarker, payload, version = STORAGE_VERSION) {
  const head = Buffer.alloc(marker.length + 8);
  marker.copy(head, 0);
  head.writeUInt32LE(version, marker.length);
  head.writeUInt32LE(payload.length, marker.length + 4);
  const hash = crypto.createHash('sha256').update(payload).digest();
  return Buffer.concat([head, payload, hash, commitMarker]);
}

function buildV2HeaderSegment(archiveGuid, airportIcao, schemaHash = DEFAULT_SCHEMA_HASH) {
  const headerJson = JSON.stringify({
    schemaHash,
    archiveGuid,
    progressDisplayName: '',
    levelGuid: archiveGuid,
    airportIcao,
  });
  const headerBytes = Buffer.from(headerJson, 'utf-8');
  const head = Buffer.alloc(MAGIC.length + 8);
  MAGIC.copy(head, 0);
  head.writeUInt32LE(STORAGE_VERSION_LATEST, MAGIC.length);
  head.writeUInt32LE(headerBytes.length, MAGIC.length + 4);
  const hash = crypto.createHash('sha256').update(headerBytes).digest();
  return Buffer.concat([head, headerBytes, hash, HEADER_COMMIT_V2]);
}

function buildV2MainSegment(payload) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(payload.length, 0);
  const hash = crypto.createHash('sha256').update(payload).digest();
  return Buffer.concat([lenBuf, payload, hash, HEADER_COMMIT]);
}

/** Encode Odin JSON text (with optional FRAME_SENTINEL-separated frame docs) into a v1 archive. */
function encodeArchive(text) {
  const docs = text.split(RE_FRAME_SENTINEL);
  const parts = [buildSegment(MAGIC, HEADER_COMMIT, encodeTextToPayload(docs[0]), STORAGE_VERSION)];
  for (let i = 1; i < docs.length; i++) {
    parts.push(buildSegment(FRAME_MARKER, FRAME_COMMIT, encodeTextToPayload(docs[i]), STORAGE_VERSION));
  }
  return Buffer.concat(parts);
}

/** Encode Odin JSON text into a v2 archive, preserving header/frames from originalBuffer if provided. */
function encodeV2Archive(text, originalBuffer) {
  const docs = text.split(RE_FRAME_SENTINEL);
  const mainText = docs[0];
  const mainPayload = encodeTextToPayload(mainText);

  let headerSegment;
  let framesRaw;
  if (originalBuffer && isGatcArchive(originalBuffer) && getStorageVersion(originalBuffer) === 2) {
    const v2 = parseV2Archive(originalBuffer);
    headerSegment = v2.rawHeaderSegment;
    framesRaw = v2.framesRaw; // includes all MARF frames verbatim
    // If the edited text contained extra frame docs beyond the main, append them as new frames
    // (preserving the v2 frame internal format is non-trivial; for now we preserve original frames only
    // and ignore extra docs — the editor's flight-save path regenerates the LevelPayload and
    // leaves checkpoints stale, which the game handles)
  } else {
    // No original v2 to preserve — synthesize a minimal header
    // Derive archiveGuid / airportIcao from the text if possible, otherwise use placeholders
    let archiveGuid = 'UNKNOWN';
    let airportIcao = 'XXXX';
    try {
      const m = mainText.match(/"Guid":\s*"([^"]+)"/);
      if (m) archiveGuid = m[1];
      const m2 = mainText.match(/"airportIcao":\s*"([A-Z0-9]{3,4})"/);
      if (m2) airportIcao = m2[1];
    } catch (_) {}
    // Try to infer from LevelPayload MetaData Guid
    try {
      const gm = mainText.match(/"Guid":\s*"([^"]+_leisure[^"]*)"/);
      if (gm) archiveGuid = gm[1];
    } catch (_) {}
    headerSegment = buildV2HeaderSegment(archiveGuid, airportIcao);
    framesRaw = Buffer.alloc(0);
    // New files start with 0 frames; checkpoint frames are append-only runtime saves
    // and are not synthesized from text docs (the v2 checkpoint internal format is not
    // round-trippable via the text sentinel). Extra docs beyond the main are dropped.
  }

  const mainSegment = buildV2MainSegment(mainPayload);
  return Buffer.concat([headerSegment, mainSegment, framesRaw]);
}

/**
 * Universal .acl read: returns the file's content as Odin JSON text, decoding
 * GATCARC4 binary transparently. Legacy text files pass through unchanged.
 */
function readAclText(aclPath) {
  const buffer = fs.readFileSync(aclPath);
  if (isGatcArchive(buffer)) {
    try {
      const ver = getStorageVersion(buffer);
      if (ver === 2) {
        return decodeV2Archive(buffer);
      }
      return decodeArchive(buffer);
    } catch (e) {
      throw new Error(`Failed to decode binary .acl "${aclPath}": ${e.message}`);
    }
  }
  return buffer.toString('utf-8');
}

/** Detect the on-disk container format of an existing .acl file ('binary' | 'text' | null). */
function detectAclFormat(aclPath) {
  try {
    return isGatcArchive(aclPath) ? 'binary' : 'text';
  } catch (_) {
    return null; // file missing/unreadable
  }
}

/**
 * Universal .acl write. `format`:
 *   'auto' (default) — preserve the existing file's container format; new files
 *                      are written binary (the current game format)
 *   'binary'         — GATCARC4 archive (v2 if original was v2, else v1)
 *   'text'           — plain Odin JSON text
 *
 * Every document ($id/$iref) is renumbered to a strictly ascending sequence
 * in text order before encoding — see id_renumber.js (the game's checkpoint
 * reader requires it; the editor's rebuild can emit ids out of text order,
 * which makes the game null-bind inline values and crash with a
 * NullReferenceException during level init).
 */
function writeAcl(aclPath, text, options = {}) {
  let format = options.format || 'auto';
  if (format === 'auto') {
    format = detectAclFormat(aclPath) || 'binary';
  }
  const normalized = renumberAclIds(text, options.originalText);
  if (format === 'binary') {
    let buffer;
    try {
      // Preserve on-disk storage version: v2 files stay v2, v1 files stay v1
      let isV2 = false;
      if (fs.existsSync(aclPath)) {
        try {
          const orig = fs.readFileSync(aclPath);
          if (isGatcArchive(orig) && getStorageVersion(orig) === 2) isV2 = true;
        } catch (_) { isV2 = false; }
      } else {
        // New file with no original — default to latest (v2)
        isV2 = true;
      }
      if (isV2) {
        let origBuf = null;
        if (fs.existsSync(aclPath)) {
          try { origBuf = fs.readFileSync(aclPath); } catch (_) { origBuf = null; }
          // If original exists but is not v2 (e.g. v1), treat as no original for v2 encode
          if (origBuf && getStorageVersion(origBuf) !== 2) origBuf = null;
        }
        // For new v2 files with no original, derive header from aclPath
        if (!origBuf) {
          const base = path.basename(aclPath, '.acl');
          const dirIcao = path.basename(path.dirname(path.dirname(aclPath)));
          const airportIcao = /^[A-Z0-9]{3,4}$/.test(dirIcao) ? dirIcao : 'XXXX';
          const headerSeg = buildV2HeaderSegment(base, airportIcao);
          const mainPayload = encodeTextToPayload(normalized.split(RE_FRAME_SENTINEL)[0]);
          const mainSeg = buildV2MainSegment(mainPayload);
          buffer = Buffer.concat([headerSeg, mainSeg]);
        } else {
          buffer = encodeV2Archive(normalized, origBuf);
        }
      } else {
        buffer = encodeArchive(normalized);
      }
    } catch (e) {
      throw new Error(`Failed to encode .acl "${aclPath}" to GATCARC4: ${e.message}`);
    }
    fs.writeFileSync(aclPath, buffer);
  } else if (format === 'text') {
    fs.writeFileSync(aclPath, normalized, 'utf-8');
  } else {
    throw new Error(`writeAcl: unknown format "${format}"`);
  }
  return format;
}

module.exports = {
  MAGIC,
  FRAME_MARKER,
  HEADER_COMMIT,
  HEADER_COMMIT_V2,
  FRAME_COMMIT,
  STORAGE_VERSION,
  STORAGE_VERSION_LATEST,
  SUPPORTED_VERSIONS,
  HASH_LENGTH,
  DEFAULT_SCHEMA_HASH,
  FRAME_SENTINEL,
  RE_FRAME_SENTINEL,
  isGatcArchive,
  getStorageVersion,
  parseSegment,
  parseArchive,
  parseV2Archive,
  decodeArchive,
  decodeV2Archive,
  encodeArchive,
  encodeV2Archive,
  buildV2HeaderSegment,
  buildV2MainSegment,
  decodePayloadToText,
  encodeTextToPayload,
  readAclText,
  detectAclFormat,
  writeAcl,
};
