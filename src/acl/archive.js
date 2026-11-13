'use strict';

/**
 * Editor-facing ACL Archive Facade (`src/acl/archive.js`).
 *
 * Performs strict per-file format detection and dispatches to the owning
 * format handler (`gatcarc4-v3`, `gatcarc4-v2`, `gatcarc4-v1`, `legacy-text`).
 *
 * Retiring v2 removes its dispatch branch, `openV2Acl`, and v2 tests while
 * keeping shared framing primitives and Odin code used by v1 / legacy text.
 */

const fs = require('fs');
const { MAGIC, FramingError, hasGatcMagic, readContainerVersion, sha256 } = require('./framing');
const { openV3Acl, StaleSourceError } = require('./v3/handler');
const { openLegacyAcl, openV2Acl } = require('./legacy_handler');

/**
 * Detect ACL container format from raw file bytes.
 *
 * Validates truncated headers and non-text binary garbage before dispatching,
 * and reports unsupported GATCARC4 storage versions explicitly.
 *
 * @param {Buffer} bytes
 * @returns {'gatcarc4-v1' | 'gatcarc4-v2' | 'gatcarc4-v3' | 'legacy-text'}
 */
function detectAclFormat(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new FramingError('ACL input must be a Buffer', { offset: 0 });
  }
  if (bytes.length === 0) {
    throw new FramingError('ACL file is empty (0 bytes)', { offset: 0 });
  }

  // Full 8-byte GATCARC4 magic
  if (hasGatcMagic(bytes)) {
    if (bytes.length < 12) {
      throw new FramingError(
        `Truncated GATCARC4 header: expected at least 12 bytes, got ${bytes.length}`,
        { offset: bytes.length },
      );
    }
    const version = readContainerVersion(bytes);
    if (version === 1) return 'gatcarc4-v1';
    if (version === 2) return 'gatcarc4-v2';
    if (version === 3) return 'gatcarc4-v3';
    throw new FramingError(
      `GATCARC4: unsupported header storage version ${version} (supported: 1, 2, 3)`,
      { offset: 8, version },
    );
  }

  // Truncated prefix of "GATCARC4" (e.g. 1..7 bytes matching MAGIC)
  if (bytes.length < MAGIC.length && bytes.equals(MAGIC.subarray(0, bytes.length))) {
    throw new FramingError(
      `Truncated GATCARC4 magic header (${bytes.length} bytes)`,
      { offset: 0 },
    );
  }

  // Legacy text check: optional UTF-8 BOM (EF BB BF) + ASCII whitespace + '{'
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    i = 3;
  }
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D) {
      i++;
      continue;
    }
    break;
  }
  if (i < bytes.length && bytes[i] === 0x7B /* '{' */) {
    return 'legacy-text';
  }

  throw new FramingError(
    `Unrecognized ACL file format (neither GATCARC4 binary nor JSON/Odin text)`,
    { offset: 0 },
  );
}

/**
 * Open an ACL archive from in-memory bytes.
 *
 * @param {Buffer} bytes
 * @param {object} [options]
 */
function openAcl(bytes, options = {}) {
  const format = detectAclFormat(bytes);
  if (format === 'gatcarc4-v2') return openV2Acl(bytes, options);
  if (format === 'gatcarc4-v3') return openV3Acl(bytes, options);
  if (format === 'gatcarc4-v1' || format === 'legacy-text') {
    return openLegacyAcl(bytes, options);
  }
  throw new Error(`Unsupported ACL format: ${format}`);
}

/**
 * Open an ACL archive from a file path on disk, recording file metadata
 * (`filePath`, `sourceSize`, `sourceMtimeMs`, `sourceSha256`) on the handle.
 *
 * @param {string} filePath
 * @param {object} [options]
 */
function openAclFile(filePath, options = {}) {
  const stat = fs.statSync(filePath);
  const bytes = fs.readFileSync(filePath);
  return openAcl(bytes, {
    ...options,
    filePath,
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs,
    sourceSha256: sha256(bytes).toString('hex'),
  });
}

module.exports = {
  detectAclFormat,
  openAcl,
  openAclFile,
  StaleSourceError,
};
