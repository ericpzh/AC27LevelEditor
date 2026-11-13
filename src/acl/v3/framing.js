/**
 * Strict binary container parser and encoder for GATCARC4 storage version 3.
 *
 * Container layout (all integers uint32LE):
 *   1. Header segment:
 *      [0..8)          "GATCARC4"
 *      [8..12)         uint32LE(3)
 *      [12..16)        uint32LE(N)
 *      [16..16+N)      UTF-8 JSON {schemaHash, archiveGuid, progressDisplayName, levelGuid, airportIcao}
 *      [16+N..48+N)    SHA-256(headerBytes)
 *      [48+N..52+N)    "NODS"
 *
 *   2. Main LevelPayload segment:
 *      [0..4)          uint32LE(P)
 *      [4..4+P)        UTF-8 JSON {"MetaData": {...}, "StaticData": "<base64 UTF-8 JSON>"}
 *      [4+P..36+P)     SHA-256(mainBytes)
 *      [36+P..40+P)    "NODH"
 *
 *   3. Zero or more appended MARF frames:
 *      [0..4)          "MARF"
 *      [4..8)          uint32LE(3)
 *      [8..12)         uint32LE(M)  where M === 4 + J + 32 + 4 + B + 32 + 4
 *      [12..16)        uint32LE(J)
 *      [16..16+J)      UTF-8 JSON FrameSummaryData
 *      [16+J..48+J)    SHA-256(summaryBytes)
 *      [48+J..52+J)    uint32LE(B)
 *      [52+J..52+J+B)  UTF-8 JSON {"RuntimeData": "<base64 UTF-8 JSON>", "RecentMessages": [...]}
 *      [52+J+B..84+J+B) SHA-256(payloadBytes)
 *      [84+J+B..88+J+B) "NODF"
 */
const {
  MAGIC,
  FRAME_MARKER,
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
} = require('../framing');
const {
  parseUtf8LosslessJson,
  parseBase64LosslessJson,
  stringifyLosslessJson,
  encodeBase64LosslessJson,
  JsonDecodeError,
} = require('./lossless_json');

const V3_VERSION = 3;
const MIN_FRAME_OUTER_LEN = 4 + HASH_LENGTH + 4 + HASH_LENGTH + FRAME_COMMIT.length; // 76 bytes

function _ensurePlainObject(val, label) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new JsonDecodeError(`${label}: expected JSON object`);
  }
}

/**
 * Parse a single MARF v3 checkpoint frame starting at `frameOffset`.
 */
function _parseFrameAt(buffer, frameOffset, frameIndex) {
  const whatPrefix = `v3 frame[${frameIndex}]`;
  verifyMarker(buffer, frameOffset, FRAME_MARKER, `${whatPrefix} start`);

  const frameVerOffset = frameOffset + 4;
  const frameVersion = readUInt32LEChecked(buffer, frameVerOffset, `${whatPrefix} version`);
  if (frameVersion !== V3_VERSION) {
    throw new FramingError(
      `GATCARC4: unsupported ${whatPrefix} storage version ${frameVersion} at offset ${frameVerOffset} (expected ${V3_VERSION})`,
      { offset: frameVerOffset, frameIndex, version: frameVersion }
    );
  }

  const outerLenOffset = frameOffset + 8;
  const outerLen = readUInt32LEChecked(buffer, outerLenOffset, `${whatPrefix} wrapper`);
  if (outerLen < MIN_FRAME_OUTER_LEN) {
    throw new FramingError(
      `GATCARC4: invalid ${whatPrefix} wrapper length ${outerLen} at offset ${outerLenOffset} (minimum ${MIN_FRAME_OUTER_LEN})`,
      { offset: outerLenOffset, frameIndex }
    );
  }

  const frameEnd = frameOffset + 12 + outerLen;
  if (frameEnd > buffer.length) {
    throw new FramingError(
      `GATCARC4: truncated ${whatPrefix} at offset ${frameOffset} (need ${frameEnd} bytes, have ${buffer.length})`,
      { offset: frameOffset, frameIndex }
    );
  }

  const summaryLenOffset = frameOffset + 12;
  const summaryLen = readUInt32LEChecked(buffer, summaryLenOffset, `${whatPrefix} summary`);
  const summaryStart = summaryLenOffset + 4;
  const summaryEnd = summaryStart + summaryLen;
  const summaryHashEnd = summaryEnd + HASH_LENGTH;

  if (summaryHashEnd + 4 + HASH_LENGTH + FRAME_COMMIT.length > frameEnd) {
    throw new FramingError(
      `GATCARC4: ${whatPrefix} summary length ${summaryLen} at offset ${summaryLenOffset} overflows frame boundary ${frameEnd}`,
      { offset: summaryLenOffset, frameIndex }
    );
  }

  const summaryBytes = buffer.subarray(summaryStart, summaryEnd);
  const summaryHash = buffer.subarray(summaryEnd, summaryHashEnd);
  try {
    verifySha256(summaryBytes, summaryHash, `${whatPrefix} summary`, summaryEnd);
  } catch (err) {
    err.frameIndex = frameIndex;
    throw err;
  }

  const payloadLenOffset = summaryHashEnd;
  const payloadLen = readUInt32LEChecked(buffer, payloadLenOffset, `${whatPrefix} payload`);
  const payloadStart = payloadLenOffset + 4;
  const payloadEnd = payloadStart + payloadLen;
  const payloadHashEnd = payloadEnd + HASH_LENGTH;
  const commitOffset = payloadHashEnd;
  const expectedFrameEnd = commitOffset + FRAME_COMMIT.length;

  if (expectedFrameEnd !== frameEnd) {
    throw new FramingError(
      `GATCARC4: inconsistent ${whatPrefix} wrapper length at offset ${outerLenOffset} (outer ends at ${frameEnd}, inner blocks + NODF end at ${expectedFrameEnd})`,
      { offset: outerLenOffset, frameIndex }
    );
  }

  try {
    verifyMarker(buffer, commitOffset, FRAME_COMMIT, `${whatPrefix}`);
  } catch (err) {
    err.frameIndex = frameIndex;
    throw err;
  }

  const payloadBytes = buffer.subarray(payloadStart, payloadEnd);
  const payloadHash = buffer.subarray(payloadEnd, payloadHashEnd);
  try {
    verifySha256(payloadBytes, payloadHash, `${whatPrefix} payload`, payloadEnd);
  } catch (err) {
    err.frameIndex = frameIndex;
    throw err;
  }

  const { value: summary } = parseUtf8LosslessJson(summaryBytes, `${whatPrefix} summary`);
  _ensurePlainObject(summary, `${whatPrefix} summary`);

  const { value: payloadEnvelope } = parseUtf8LosslessJson(payloadBytes, `${whatPrefix} payload`);
  _ensurePlainObject(payloadEnvelope, `${whatPrefix} payload`);
  if (typeof payloadEnvelope.RuntimeData !== 'string') {
    throw new JsonDecodeError(`${whatPrefix} payload: expected string RuntimeData`);
  }
  if (!Array.isArray(payloadEnvelope.RecentMessages)) {
    throw new JsonDecodeError(`${whatPrefix} payload: expected array RecentMessages`);
  }

  const { value: runtimeData } = parseBase64LosslessJson(
    payloadEnvelope.RuntimeData,
    `${whatPrefix}.RuntimeData`
  );
  _ensurePlainObject(runtimeData, `${whatPrefix}.RuntimeData`);

  return {
    frameIndex,
    version: V3_VERSION,
    startOffset: frameOffset,
    endOffset: frameEnd,
    summary,
    runtimeData,
    recentMessages: payloadEnvelope.RecentMessages,
    rawFrameBytes: Buffer.from(buffer.subarray(frameOffset, frameEnd)),
    rawSummaryBlock: Buffer.from(buffer.subarray(summaryLenOffset, summaryHashEnd)),
    rawSummaryBytes: Buffer.from(summaryBytes),
    rawPayloadBytes: Buffer.from(payloadBytes),
    rawRuntimeBase64: payloadEnvelope.RuntimeData,
    dirtySummary: false,
    dirtyRuntime: false,
    dirtyRuntimeData: false,
    dirtyMessages: false,
  };
}

/**
 * Strictly parse and decode a GATCARC4 v3 container into header, main payload,
 * and checkpoint frames while retaining original byte slices for untouched reuse.
 *
 * @param {Buffer} buffer
 * @param {{ allowInterruptedTail?: boolean }} [options]
 */
function parseV3Container(buffer, options = {}) {
  const allowInterruptedTail = Boolean(options.allowInterruptedTail);

  if (!Buffer.isBuffer(buffer)) {
    throw new FramingError('GATCARC4: expected Buffer input', { offset: 0 });
  }
  if (!hasGatcMagic(buffer)) {
    throw new FramingError('GATCARC4: bad magic at offset 0 (not a GATCARC4 archive)', { offset: 0 });
  }

  const version = readContainerVersion(buffer);
  if (version !== V3_VERSION) {
    throw new FramingError(
      `GATCARC4: unsupported header storage version ${version} at offset 8 (expected ${V3_VERSION})`,
      { offset: 8, version }
    );
  }

  const headerLen = readUInt32LEChecked(buffer, 12, 'v3 header');
  const headerStart = 16;
  const headerPayloadEnd = headerStart + headerLen;
  const headerHashEnd = headerPayloadEnd + HASH_LENGTH;
  const headerEnd = headerHashEnd + HEADER_COMMIT_V2.length;

  if (headerEnd > buffer.length) {
    throw new FramingError(
      `GATCARC4: truncated v3 header at offset ${headerStart} (need ${headerEnd} bytes, have ${buffer.length})`,
      { offset: headerStart }
    );
  }

  const headerBytes = buffer.subarray(headerStart, headerPayloadEnd);
  const headerHash = buffer.subarray(headerPayloadEnd, headerHashEnd);
  verifySha256(headerBytes, headerHash, 'v3 header', headerPayloadEnd);
  verifyMarker(buffer, headerHashEnd, HEADER_COMMIT_V2, 'v3 header');

  const { value: header } = parseUtf8LosslessJson(headerBytes, 'v3 header');
  _ensurePlainObject(header, 'v3 header');

  // Main LevelPayload segment
  const mainStart = headerEnd;
  const mainLen = readUInt32LEChecked(buffer, mainStart, 'v3 LevelPayload');
  const mainPayloadStart = mainStart + 4;
  const mainPayloadEnd = mainPayloadStart + mainLen;
  const mainHashEnd = mainPayloadEnd + HASH_LENGTH;
  const mainEnd = mainHashEnd + MAIN_COMMIT.length;

  if (mainEnd > buffer.length) {
    throw new FramingError(
      `GATCARC4: truncated v3 LevelPayload at offset ${mainStart} (need ${mainEnd} bytes, have ${buffer.length})`,
      { offset: mainStart }
    );
  }

  const mainPayloadBytes = buffer.subarray(mainPayloadStart, mainPayloadEnd);
  const mainHash = buffer.subarray(mainPayloadEnd, mainHashEnd);
  verifySha256(mainPayloadBytes, mainHash, 'v3 LevelPayload', mainPayloadEnd);
  verifyMarker(buffer, mainHashEnd, MAIN_COMMIT, 'v3 LevelPayload');

  const { value: mainEnvelope } = parseUtf8LosslessJson(mainPayloadBytes, 'v3 LevelPayload');
  _ensurePlainObject(mainEnvelope, 'v3 LevelPayload');
  _ensurePlainObject(mainEnvelope.MetaData, 'v3 LevelPayload.MetaData');
  if (typeof mainEnvelope.StaticData !== 'string') {
    throw new JsonDecodeError('v3 LevelPayload: expected string StaticData');
  }

  const { value: staticData } = parseBase64LosslessJson(
    mainEnvelope.StaticData,
    'v3 LevelPayload.StaticData'
  );
  _ensurePlainObject(staticData, 'v3 LevelPayload.StaticData');

  // Appended MARF checkpoint frames
  const frames = [];
  let pos = mainEnd;
  let interruptedTailOffset = null;

  while (pos < buffer.length) {
    const frameIndex = frames.length;
    try {
      const frame = _parseFrameAt(buffer, pos, frameIndex);
      frames.push(frame);
      pos = frame.endOffset;
    } catch (err) {
      if (allowInterruptedTail && err instanceof FramingError) {
        interruptedTailOffset = pos;
        break;
      }
      throw err;
    }
  }

  return {
    version: V3_VERSION,
    header,
    metaData: mainEnvelope.MetaData,
    staticData,
    frames,
    interruptedTailOffset,
    rawHeaderSegment: Buffer.from(buffer.subarray(0, headerEnd)),
    rawMainSegment: Buffer.from(buffer.subarray(mainStart, mainEnd)),
    rawMainPayloadBytes: Buffer.from(mainPayloadBytes),
    rawStaticBase64: mainEnvelope.StaticData,
    dirtyHeader: false,
    dirtyMetaData: false,
    dirtyStaticData: false,
  };
}

function _buildFrameSegment(frame, forceReencode = false) {
  const runtimeDirty = Boolean(frame.dirtyRuntime || frame.dirtyRuntimeData);
  if (!forceReencode && !frame.dirtySummary && !runtimeDirty && !frame.dirtyMessages && frame.rawFrameBytes) {
    return frame.rawFrameBytes;
  }

  let summaryBlock;
  if (!forceReencode && !frame.dirtySummary && frame.rawSummaryBlock) {
    summaryBlock = frame.rawSummaryBlock;
  } else {
    const summaryBytes = Buffer.from(stringifyLosslessJson(frame.summary), 'utf8');
    const sLen = Buffer.alloc(4);
    sLen.writeUInt32LE(summaryBytes.length >>> 0, 0);
    summaryBlock = Buffer.concat([sLen, summaryBytes, sha256(summaryBytes)]);
  }

  let payloadBytes;
  if (!forceReencode && !runtimeDirty && !frame.dirtyMessages && frame.rawPayloadBytes) {
    payloadBytes = frame.rawPayloadBytes;
  } else {
    const runtimeB64 = (!forceReencode && !runtimeDirty && typeof frame.rawRuntimeBase64 === 'string')
      ? frame.rawRuntimeBase64
      : encodeBase64LosslessJson(frame.runtimeData);
    const envelopeObj = {
      RuntimeData: runtimeB64,
      RecentMessages: frame.recentMessages,
    };
    payloadBytes = Buffer.from(stringifyLosslessJson(envelopeObj), 'utf8');
  }

  const pLen = Buffer.alloc(4);
  pLen.writeUInt32LE(payloadBytes.length >>> 0, 0);
  const payloadBlock = Buffer.concat([pLen, payloadBytes, sha256(payloadBytes)]);

  const inner = Buffer.concat([summaryBlock, payloadBlock, FRAME_COMMIT]);
  const head = Buffer.alloc(12);
  FRAME_MARKER.copy(head, 0);
  head.writeUInt32LE(V3_VERSION, 4);
  head.writeUInt32LE(inner.length >>> 0, 8);
  return Buffer.concat([head, inner]);
}

/**
 * Encode a parsed/modified v3 container back into a GATCARC4 v3 Buffer.
 * Reuses untouched segments and nested Base64 blobs byte-for-byte unless
 * `options.forceReencode === true`.
 */
function encodeV3Container(container, options = {}) {
  const forceReencode = Boolean(options.forceReencode);

  let headerSeg;
  if (!forceReencode && !container.dirtyHeader && container.rawHeaderSegment) {
    headerSeg = container.rawHeaderSegment;
  } else {
    const headerBytes = Buffer.from(stringifyLosslessJson(container.header), 'utf8');
    headerSeg = buildHashedBlock(headerBytes, HEADER_COMMIT_V2, MAGIC, V3_VERSION);
  }

  let mainSeg;
  if (!forceReencode && !container.dirtyMetaData && !container.dirtyStaticData && container.rawMainSegment) {
    mainSeg = container.rawMainSegment;
  } else {
    const staticB64 = (!forceReencode && !container.dirtyStaticData && typeof container.rawStaticBase64 === 'string')
      ? container.rawStaticBase64
      : encodeBase64LosslessJson(container.staticData);
    const mainObj = {
      MetaData: container.metaData,
      StaticData: staticB64,
    };
    const mainBytes = Buffer.from(stringifyLosslessJson(mainObj), 'utf8');
    mainSeg = buildHashedBlock(mainBytes, MAIN_COMMIT);
  }

  const parts = [headerSeg, mainSeg];
  for (const frame of container.frames || []) {
    parts.push(_buildFrameSegment(frame, forceReencode));
  }
  return Buffer.concat(parts);
}

module.exports = {
  V3_VERSION,
  MIN_FRAME_OUTER_LEN,
  parseV3Container,
  encodeV3Container,
};
