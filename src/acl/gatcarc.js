/**
 * GATCARC4 archive container — the binary .acl format introduced by the 2026-07 game
 * update (game code: ContextCross.Saves.SaveSystem, "append-only GATCARC4 format").
 *
 * Container layout (all integers little-endian):
 *   Header segment:
 *     [0..7]   ASCII magic "GATCARC4"
 *     [8..11]  uint32 storage version (currently 1)
 *     [12..15] uint32 payload length N
 *     [16..16+N)          payload: OdinSerializer binary document
 *                         (root: ContextCross.Saves.SaveSystem+ArchiveHeader)
 *     [16+N..16+N+32)     SHA-256 of the payload bytes
 *     [16+N+32..16+N+36)  ASCII commit marker "NODH"
 *   Zero or more appended checkpoint frames, each:
 *     [0..3]   ASCII frame marker "MARF"
 *     [4..7]   uint32 storage version
 *     [8..11]  uint32 payload length M
 *     [12..12+M)          payload: OdinSerializer binary document
 *                         (root: ContextCross.Saves.SaveSystem+CheckpointFrame)
 *     [12+M..12+M+32)     SHA-256 of the payload bytes
 *     [12+M+32..12+M+36)  ASCII commit marker "NODF"
 *
 * Nested payloads: byte[] fields such as ArchiveHeader.StaticData and
 * RuntimeSnapshot.RuntimeData contain complete nested Odin binary documents.
 * They are decoded inline as "$blobdoc": { ... } entries (and re-serialized from
 * them on encode) so the text form is readable and fully reversible.
 *
 * Decoded text form: each segment becomes one Odin JSON document (the game's
 * legacy text .acl dialect); frame documents follow the header document,
 * separated by a FRAME_SENTINEL line.
 *
 * This module is the only API the rest of the editor uses:
 *   readAclText(path)  — universal read: binary -> decoded Odin JSON text, text -> as-is
 *   writeAcl(path, text, { format }) — write preserving the on-disk container format
 */

const fs = require('fs');
const crypto = require('crypto');

const { readBinary } = require('./odin/binary_reader');
const { OdinJsonWriter } = require('./odin/json_writer');
const { readJson } = require('./odin/json_reader');
const { OdinBinaryWriter } = require('./odin/binary_writer');

const MAGIC = Buffer.from('GATCARC4', 'ascii');
const FRAME_MARKER = Buffer.from('MARF', 'ascii');
const HEADER_COMMIT = Buffer.from('NODH', 'ascii');
const FRAME_COMMIT = Buffer.from('NODF', 'ascii');
const STORAGE_VERSION = 1;
const HASH_LENGTH = 32;

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

function parseSegment(buffer, offset, marker, commitMarker, what) {
  if (!buffer.subarray(offset, offset + marker.length).equals(marker)) {
    throw new Error(`GATCARC4: bad ${what} marker at offset ${offset}`);
  }
  let pos = offset + marker.length;
  const version = buffer.readUInt32LE(pos); pos += 4;
  if (version !== STORAGE_VERSION) {
    throw new Error(`GATCARC4: unsupported ${what} storage version ${version} (expected ${STORAGE_VERSION})`);
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
  return { payload, end };
}

/**
 * Parses + validates the whole container.
 * Returns { version, header: Buffer, frames: Buffer[] } (payload subarrays).
 */
function parseArchive(buffer) {
  if (buffer.length < 16 + HASH_LENGTH + HEADER_COMMIT.length) {
    throw new Error(`GATCARC4: file too small (${buffer.length} bytes)`);
  }
  if (!buffer.subarray(0, 8).equals(MAGIC)) {
    throw new Error('GATCARC4: bad magic (not a GATCARC4 archive)');
  }
  const headerSeg = parseSegment(buffer, 0, MAGIC, HEADER_COMMIT, 'header');
  const frames = [];
  let pos = headerSeg.end;
  while (pos < buffer.length) {
    const frameSeg = parseSegment(buffer, pos, FRAME_MARKER, FRAME_COMMIT, `frame ${frames.length + 1}`);
    frames.push(frameSeg.payload);
    pos = frameSeg.end;
  }
  return { version: STORAGE_VERSION, header: headerSeg.payload, frames };
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
  const { header, frames } = parseArchive(buffer);
  const docs = [decodePayloadToText(header)];
  for (const frame of frames) docs.push(decodePayloadToText(frame));
  return docs.join('\r\n' + FRAME_SENTINEL + '\r\n');
}

function buildSegment(marker, commitMarker, payload) {
  const head = Buffer.alloc(marker.length + 8);
  marker.copy(head, 0);
  head.writeUInt32LE(STORAGE_VERSION, marker.length);
  head.writeUInt32LE(payload.length, marker.length + 4);
  const hash = crypto.createHash('sha256').update(payload).digest();
  return Buffer.concat([head, payload, hash, commitMarker]);
}

/** Encode Odin JSON text (with optional FRAME_SENTINEL-separated frame docs) into an archive. */
function encodeArchive(text) {
  const docs = text.split(RE_FRAME_SENTINEL);
  const parts = [buildSegment(MAGIC, HEADER_COMMIT, encodeTextToPayload(docs[0]))];
  for (let i = 1; i < docs.length; i++) {
    parts.push(buildSegment(FRAME_MARKER, FRAME_COMMIT, encodeTextToPayload(docs[i])));
  }
  return Buffer.concat(parts);
}

/**
 * Universal .acl read: returns the file's content as Odin JSON text, decoding
 * GATCARC4 binary transparently. Legacy text files pass through unchanged.
 */
function readAclText(aclPath) {
  const buffer = fs.readFileSync(aclPath);
  if (isGatcArchive(buffer)) {
    try {
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
 *   'binary'         — GATCARC4 archive
 *   'text'           — plain Odin JSON text
 */
function writeAcl(aclPath, text, options = {}) {
  let format = options.format || 'auto';
  if (format === 'auto') {
    format = detectAclFormat(aclPath) || 'binary';
  }
  if (format === 'binary') {
    let buffer;
    try {
      buffer = encodeArchive(text);
    } catch (e) {
      throw new Error(`Failed to encode .acl "${aclPath}" to GATCARC4: ${e.message}`);
    }
    fs.writeFileSync(aclPath, buffer);
  } else if (format === 'text') {
    fs.writeFileSync(aclPath, text, 'utf-8');
  } else {
    throw new Error(`writeAcl: unknown format "${format}"`);
  }
  return format;
}

module.exports = {
  MAGIC,
  FRAME_MARKER,
  HEADER_COMMIT,
  FRAME_COMMIT,
  STORAGE_VERSION,
  FRAME_SENTINEL,
  RE_FRAME_SENTINEL,
  isGatcArchive,
  parseArchive,
  decodeArchive,
  encodeArchive,
  decodePayloadToText,
  encodeTextToPayload,
  readAclText,
  detectAclFormat,
  writeAcl,
};
