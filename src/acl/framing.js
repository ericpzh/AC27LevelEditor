/**
 * Shared narrow binary framing primitives for GATCARC4 containers (v1, v2, v3).
 *
 * Pure Node Buffer + crypto helpers with explicit byte-offset diagnostics and
 * zero Odin or schema dependencies.
 */
const crypto = require('crypto');

const MAGIC = Buffer.from('GATCARC4', 'ascii');
const FRAME_MARKER = Buffer.from('MARF', 'ascii');
const HEADER_COMMIT_V1 = Buffer.from('NODH', 'ascii');
const HEADER_COMMIT_V2 = Buffer.from('NODS', 'ascii');
const MAIN_COMMIT = Buffer.from('NODH', 'ascii');
const FRAME_COMMIT = Buffer.from('NODF', 'ascii');
const HASH_LENGTH = 32;

class FramingError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FramingError';
    Object.assign(this, details);
  }
}

function hasGatcMagic(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(MAGIC);
}

function readContainerVersion(buffer) {
  if (!hasGatcMagic(buffer)) return null;
  if (buffer.length < 12) {
    throw new FramingError(
      `GATCARC4: truncated header version at offset 8 (need 12 bytes, have ${buffer.length})`,
      { offset: 8 }
    );
  }
  return buffer.readUInt32LE(8);
}

function readUInt32LEChecked(buffer, offset, what) {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw new FramingError(
      `GATCARC4: truncated ${what} length at offset ${offset} (need ${offset + 4} bytes, have ${buffer.length})`,
      { offset, what }
    );
  }
  return buffer.readUInt32LE(offset);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest();
}

function verifySha256(payload, storedHash, what, offset) {
  const actual = sha256(payload);
  if (!storedHash.equals(actual)) {
    throw new FramingError(
      `GATCARC4: ${what} SHA-256 mismatch at offset ${offset} (archive is corrupt)`,
      { offset, what }
    );
  }
}

function verifyMarker(buffer, offset, expectedMarker, what) {
  if (offset < 0 || offset + expectedMarker.length > buffer.length) {
    throw new FramingError(
      `GATCARC4: truncated ${what} commit marker at offset ${offset} (need ${offset + expectedMarker.length} bytes, have ${buffer.length})`,
      { offset, what }
    );
  }
  const actual = buffer.subarray(offset, offset + expectedMarker.length);
  if (!actual.equals(expectedMarker)) {
    throw new FramingError(
      `GATCARC4: invalid commit marker for ${what} at offset ${offset} (expected "${expectedMarker.toString('ascii')}", got "${actual.toString('latin1')}")`,
      { offset, what }
    );
  }
}

function buildHashedBlock(payloadBytes, commitMarker, prefixMarker = null, version = null) {
  const hash = sha256(payloadBytes);
  if (prefixMarker !== null) {
    const head = Buffer.alloc(prefixMarker.length + 8);
    prefixMarker.copy(head, 0);
    head.writeUInt32LE(version >>> 0, prefixMarker.length);
    head.writeUInt32LE(payloadBytes.length >>> 0, prefixMarker.length + 4);
    return Buffer.concat([head, payloadBytes, hash, commitMarker]);
  }
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(payloadBytes.length >>> 0, 0);
  return Buffer.concat([lenBuf, payloadBytes, hash, commitMarker]);
}

module.exports = {
  MAGIC,
  FRAME_MARKER,
  HEADER_COMMIT_V1,
  HEADER_COMMIT_V2,
  MAIN_COMMIT,
  FRAME_COMMIT,
  HASH_LENGTH,
  FramingError,
  hasGatcMagic,
  readContainerVersion,
  readUInt32LEChecked,
  sha256,
  verifySha256,
  verifyMarker,
  buildHashedBlock,
};
