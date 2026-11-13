/**
 * @vitest-environment node
 *
 * Focused unit tests for GATCARC4 v3 framing, lossless JSON/Base64/UTF-8,
 * Q32.32 signed boundaries, ISO-8601 local wall-clock timestamps, reference graph
 * indexing/normalization, and schema validation.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { FramingError, sha256 } = require('../../src/acl/framing');
const {
  RawJsonNumber,
  JsonDecodeError,
  decodeUtf8Strict,
  decodeBase64Strict,
  parseLosslessJson,
  stringifyLosslessJson,
} = require('../../src/acl/v3/lossless_json');
const {
  INT64_MIN,
  INT64_MAX,
  decodeQ32,
  encodeQ32,
  decodePosition3ToGu,
  encodeGuToPosition3,
  encodeDirection3,
  decodeWindDirectionDeg,
  decodeWindSpeedKnots,
  encodeWindSpeedFromKnots,
  parseIsoWallClock,
  formatEditorTimeToIso,
  formatSecondsToIso,
} = require('../../src/acl/v3/q32');
const {
  TARGET_SCHEMA_HASH,
  SchemaError,
  SchemaValidationError,
  computeSchemaHash,
  getSchemaForHash,
} = require('../../src/acl/v3/schema_registry');
const { parseV3Container, encodeV3Container } = require('../../src/acl/v3/framing');
const {
  parsePkRef,
  indexDocumentGraph,
  indexStaticAuthorities,
  resolveGraphNode,
  normalizeDocumentGraph,
} = require('../../src/acl/v3/graph');
const { validateDocument, validateV3Container } = require('../../src/acl/v3/validator');
const { openAcl, detectAclFormat } = require('../../src/acl/archive');
const {
  SYNTH_FIXTURE_PATH,
  buildSyntheticV3Container,
  buildSyntheticV3Buffer,
} = require('../fixtures/v3/synthetic_v3');

describe('GATCARC4 v3 — Schema Registry & Hash Canonicalization', () => {
  it('computes the exact target SHA-256 for the bundled wire schema', () => {
    const schema = getSchemaForHash(TARGET_SCHEMA_HASH);
    expect(computeSchemaHash(schema.raw)).toBe(TARGET_SCHEMA_HASH);
    expect(schema.isPolymorphicSlot('ContextCross.Saves.Serialization.IPkStaticEntity')).toBe(true);
    expect(schema.isPolymorphicSlot('ContextCross.Events.AircraftEvent')).toBe(true);
    expect(schema.isPolymorphicSlot('ContextCross.Models.Runway+Entry')).toBe(false);
    expect(schema.isPolymorphicSlot('ContextCross.Saves.LevelMetaData')).toBe(false);
  });

  it('rejects missing or unsupported schema hashes with SchemaError', () => {
    expect(() => getSchemaForHash('')).toThrow(SchemaError);
    expect(() => getSchemaForHash('0000000000000000000000000000000000000000000000000000000000000000')).toThrow(
      SchemaError
    );
  });
});

describe('GATCARC4 v3 — Lossless UTF-8, Base64, and 64-bit JSON', () => {
  it('preserves signed/unsigned 64-bit integers beyond Number.MAX_SAFE_INTEGER and emits unquoted numbers', () => {
    const src =
      '{"ticks":639247227652411246,"minI64":-9223372036854775808,"maxI64":9223372036854775807,"maxU64":18446744073709551615,"safe":42,"frac":1.2500}';
    const parsed = parseLosslessJson(src);
    expect(parsed.ticks).toBe(639247227652411246n);
    expect(parsed.minI64).toBe(INT64_MIN);
    expect(parsed.maxI64).toBe(INT64_MAX);
    expect(parsed.maxU64).toBe(18446744073709551615n);
    expect(parsed.safe).toBe(42);
    expect(parsed.frac).toBeInstanceOf(RawJsonNumber);
    expect(stringifyLosslessJson(parsed)).toBe(src);
  });

  it('rejects invalid UTF-8 byte sequences fatally', () => {
    const invalidUtf8 = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]);
    expect(() => decodeUtf8Strict(invalidUtf8)).toThrow(JsonDecodeError);
  });

  it('rejects malformed or non-canonical Base64 strings', () => {
    expect(() => decodeBase64Strict('not-valid-base64!!!')).toThrow(JsonDecodeError);
    expect(() => decodeBase64Strict('abc')).toThrow(JsonDecodeError); // bad length
    // Non-zero pad bits ("YQ==" is canonical "a", "YR==" has non-zero pad bit)
    expect(() => decodeBase64Strict('YR==')).toThrow(JsonDecodeError);
  });
});

describe('GATCARC4 v3 — Q32.32 Fixed-Point & ISO-8601 Conversions', () => {
  it('handles signed Int64 boundaries and rejects out-of-range values', () => {
    expect(decodeQ32(INT64_MIN)).toBe(-2147483648);
    expect(encodeQ32(-2147483648)).toBe(INT64_MIN);
    expect(decodeQ32(INT64_MAX)).toBeCloseTo(2147483647.9999999998, 6);
    expect(() => decodeQ32(INT64_MAX + 1n)).toThrow(RangeError);
    expect(() => decodeQ32(INT64_MIN - 1n)).toThrow(RangeError);
    expect(() => encodeQ32(2147483648)).toThrow(RangeError);
    expect(() => encodeQ32(-2147483649)).toThrow(RangeError);
  });

  it('converts GU <-> SI metres Position3 and wind units accurately and rejects positional numeric args', () => {
    const posWire = encodeGuToPosition3({ x: -2.5, y: 0, z: 12.75 });
    const posGu = decodePosition3ToGu(posWire);
    expect(posGu.x).toBeCloseTo(-2.5, 9);
    expect(posGu.y).toBe(0);
    expect(posGu.z).toBeCloseTo(12.75, 9);

    // Must throw TypeError on positional numeric args, arrays, or null instead of silently encoding [0, 0, 0]
    expect(() => encodeGuToPosition3(-2.5, 12.75, 0)).toThrow(TypeError);
    expect(() => encodeGuToPosition3(null)).toThrow(TypeError);
    expect(() => encodeGuToPosition3([-2.5, 0, 12.75])).toThrow(TypeError);
    expect(() => encodeGuToPosition3(42)).toThrow(TypeError);
    expect(() => encodeDirection3(1, 0, 0)).toThrow(TypeError);
    expect(() => encodeDirection3([1, 0, 0])).toThrow(TypeError);
    expect(encodeDirection3(null)).toBeNull();

    const windWire = encodeWindSpeedFromKnots(15);
    expect(decodeWindSpeedKnots(windWire)).toBe(15);
    expect(decodeWindDirectionDeg(encodeQ32(Math.PI))).toBe(180);
  });

  it('preserves ISO-8601 local wall-clock times and 0001-01-01T00:00:00 without timezone shift', () => {
    expect(parseIsoWallClock('0001-01-01T00:00:00')).toBeNull();
    expect(formatEditorTimeToIso('')).toBe('0001-01-01T00:00:00');
    const parsed = parseIsoWallClock('2000-01-01T21:15:03.42');
    expect(parsed.timeString).toBe('21:15:03');
    expect(parsed.secSinceMidnight).toBe(21 * 3600 + 15 * 60 + 3);
    expect(parsed.exactSecSinceMidnight).toBeCloseTo(76503.42, 5);
    expect(formatEditorTimeToIso('08:05')).toBe('2000-01-01T08:05:00');
    expect(formatSecondsToIso(8 * 3600 + 15 * 60 + 30.26)).toBe('2000-01-01T08:15:30.26');
  });
});

describe('GATCARC4 v3 — Container Framing & Failure Diagnostics', () => {
  it('parses, validates, and byte-exactly round-trips the checked-in synthetic v3 fixture', () => {
    const raw = fs.readFileSync(SYNTH_FIXTURE_PATH);
    const parsed = parseV3Container(raw);
    expect(parsed.version).toBe(3);
    expect(parsed.frames.length).toBe(1);
    expect(parsed.frames[0].summary.createdAtUtcTicks).toBe(639247227652411246n);
    expect(parsed.staticData.PKStaticEntities['taxiway-node:-1099'].ReactivePosition.value[0]).toBe(
      9007199254740995n
    );

    validateV3Container(parsed);
    expect(encodeV3Container(parsed, { forceReencode: false }).equals(raw)).toBe(true);
    expect(encodeV3Container(parsed, { forceReencode: true }).equals(raw)).toBe(true);
  });

  it('reports exact byte offsets and frame indices on header, payload, and frame framing errors', () => {
    const valid = buildSyntheticV3Buffer();

    // 1. Bad magic
    const badMagic = Buffer.from(valid);
    badMagic[0] = 0x58;
    expect(() => parseV3Container(badMagic)).toThrowError(FramingError);

    // 2. Header version mismatch at offset 8
    const badHeaderVer = Buffer.from(valid);
    badHeaderVer.writeUInt32LE(2, 8);
    try {
      parseV3Container(badHeaderVer);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FramingError);
      expect(err.offset).toBe(8);
    }

    // 3. Header SHA-256 mismatch
    const headerLen = valid.readUInt32LE(12);
    const badHeaderHash = Buffer.from(valid);
    badHeaderHash[16 + headerLen] ^= 0xff;
    try {
      parseV3Container(badHeaderHash);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FramingError);
      expect(err.offset).toBe(16 + headerLen);
    }

    // 4. Header NODS commit marker mismatch
    const badHeaderMarker = Buffer.from(valid);
    badHeaderMarker[16 + headerLen + 32] = 0x58;
    expect(() => parseV3Container(badHeaderMarker)).toThrowError(FramingError);

    // 5. Main LevelPayload NODH marker mismatch
    const mainStart = 16 + headerLen + 36;
    const mainLen = valid.readUInt32LE(mainStart);
    const frameStart = mainStart + 4 + mainLen + 36;
    const badMainMarker = Buffer.from(valid);
    badMainMarker[frameStart - 1] = 0x58;
    expect(() => parseV3Container(badMainMarker)).toThrowError(FramingError);

    // 6. Frame version mismatch (frameIndex = 0)
    const badFrameVer = Buffer.from(valid);
    badFrameVer.writeUInt32LE(2, frameStart + 4);
    try {
      parseV3Container(badFrameVer);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FramingError);
      expect(err.frameIndex).toBe(0);
      expect(err.offset).toBe(frameStart + 4);
    }

    // 7. Inconsistent frame outer wrapper length vs inner blocks + NODF
    const badFrameWrapper = Buffer.concat([valid, Buffer.from('ABCD')]);
    badFrameWrapper.writeUInt32LE(valid.readUInt32LE(frameStart + 8) + 4, frameStart + 8);
    try {
      parseV3Container(badFrameWrapper);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FramingError);
      expect(err.frameIndex).toBe(0);
    }

    // 8. Frame NODF commit marker mismatch (keeping payload hash intact, mutating trailing NODF)
    const badNodf = Buffer.from(valid);
    badNodf[badNodf.length - 1] = 0x58;
    try {
      parseV3Container(badNodf);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FramingError);
      expect(err.frameIndex).toBe(0);
    }

    // 9. Truncated append tail: strict rejection by default, optional recovery when requested
    const truncatedTail = valid.subarray(0, valid.length - 10);
    expect(() => parseV3Container(truncatedTail)).toThrowError(FramingError);
    const recovered = parseV3Container(truncatedTail, { allowInterruptedTail: true });
    expect(recovered.frames.length).toBe(0);
    expect(recovered.interruptedTailOffset).toBe(frameStart);
  });

  it('rejects corrupted StaticData Base64 inside a validly hashed LevelPayload', () => {
    const parsed = parseV3Container(buildSyntheticV3Buffer());
    const badMainBytes = Buffer.from(JSON.stringify({ MetaData: parsed.metaData, StaticData: '%%%bad%%%' }), 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(badMainBytes.length, 0);
    const crafted = Buffer.concat([
      parsed.rawHeaderSegment,
      lenBuf,
      badMainBytes,
      sha256(badMainBytes),
      Buffer.from('NODH', 'ascii'),
    ]);
    expect(() => parseV3Container(crafted)).toThrow(JsonDecodeError);
  });
});

describe('GATCARC4 v3 — Graph Resolution & Schema Validation Errors', () => {
  it('resolves colon-bearing pk: references across RuntimeData -> StaticData authorities', () => {
    const parsed = parsePkRef(
      'pk:ContextCross.Models.FixedTaxiNavigationPoint:taxi-navigation:pushback:101:0'
    );
    expect(parsed).toEqual({
      concreteType: 'ContextCross.Models.FixedTaxiNavigationPoint',
      pk: 'taxi-navigation:pushback:101:0',
    });

    const container = buildSyntheticV3Container();
    const schema = getSchemaForHash(container.header.schemaHash);
    const staticAuth = indexStaticAuthorities(container.staticData, schema);
    const rtGraph = indexDocumentGraph(container.frames[0].runtimeData, schema.roots.runtime, schema);

    const acDep = resolveGraphNode(container.frames[0].runtimeData.RuntimeEntities['aircraft:B-1001'], rtGraph);
    const pushNav = resolveGraphNode(acDep.SelectedPushbackLimitPosition, rtGraph, staticAuth);
    expect(pushNav.PK).toBe('taxi-navigation:pushback:101:0');
  });

  it('distinguishes SchemaValidationError (with document & path) from FramingError', () => {
    const schema = getSchemaForHash(TARGET_SCHEMA_HASH);

    // 1. Missing required member
    const c1 = buildSyntheticV3Container();
    delete c1.metaData.Config.geoDataFile;
    try {
      validateV3Container(c1);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect(err).not.toBeInstanceOf(FramingError);
      expect(err.document).toBe('MetaData');
      expect(err.path).toBe('$.Config.geoDataFile');
    }

    // 2. Unknown member rejected
    const c2 = buildSyntheticV3Container();
    c2.metaData.Config.unknownExtraField = 123;
    expect(() => validateV3Container(c2)).toThrowError(SchemaValidationError);

    // 3. Disallowed null on non-nullable field
    const c3 = buildSyntheticV3Container();
    c3.staticData.PKStaticEntities['stand:101'].ParkingType = null;
    expect(() => validateV3Container(c3)).toThrowError(SchemaValidationError);

    // 4. Concrete slot carrying unexpected $type rejected
    const c4 = buildSyntheticV3Container();
    c4.staticData.StaticItems['flight-plan:B-1001'].InitialDeparture.$type =
      'ContextCross.Models.FlightPlanDepartureLeg';
    expect(() => validateV3Container(c4)).toThrowError(SchemaValidationError);

    // 5. Polymorphic slot missing $type rejected
    const c5 = buildSyntheticV3Container();
    delete c5.staticData.PKStaticEntities['stand:101'].$type;
    expect(() => validateV3Container(c5)).toThrowError(SchemaValidationError);

    // 6. Broken cross-document pk: reference rejected with exact RuntimeData path
    const c6 = buildSyntheticV3Container();
    const rtFp = c6.frames[0].runtimeData.RuntimeEntities['flight-plan:B-2002'];
    rtFp.StaticItem = { $ref: 'pk:ContextCross.Models.FlightPlanStaticItem:flight-plan:NON_EXISTENT' };
    try {
      validateV3Container(c6);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect(err.document).toBe('Frame[0].RuntimeData');
      expect(err.path).toContain('StaticItem');
    }

    // 7. Malformed wrapper shape rejected
    const c7 = buildSyntheticV3Container();
    c7.staticData.PKStaticEntities['stand:101'].PushbackLimitPositions = []; // should be {id, type, values}
    expect(() => validateDocument(c7.staticData, 'static', schema, { documentName: 'StaticData' })).toThrowError(
      SchemaValidationError
    );

    // 8. Malformed reactive wrapper rejected
    const c8 = buildSyntheticV3Container();
    c8.staticData.PKStaticEntities['taxiway-node:-1001'].ReactivePosition = [0, 0, 0]; // should be {id, value}
    expect(() => validateDocument(c8.staticData, 'static', schema, { documentName: 'StaticData' })).toThrowError(
      SchemaValidationError
    );

    // 9. Zero-length TaxiwaySegment edge rejected by NavigationGraph invariant
    const c9 = buildSyntheticV3Container();
    c9.staticData.PKStaticEntities['taxiway-node:-1002'].ReactivePosition.value = [
      ...c9.staticData.PKStaticEntities['taxiway-node:-1001'].ReactivePosition.value,
    ];
    expect(() => validateV3Container(c9)).toThrowError(SchemaValidationError);
  });

  it('detects format versions explicitly and allocates collision-free IDs in normalizeDocumentGraph', () => {
    // Truncated GATCARC4 header (< 12 bytes) fails explicitly
    expect(() => detectAclFormat(Buffer.from('GATCARC4\x03'))).toThrow();
    // Unsupported future binary version (e.g. v99) fails explicitly on detectAclFormat / openAcl
    const v99 = Buffer.alloc(32);
    v99.write('GATCARC4', 0, 'ascii');
    v99.writeUInt32LE(99, 8);
    expect(() => detectAclFormat(v99)).toThrow(/99/);
    expect(() => openAcl(v99)).toThrow(/99/);

    // Collision-free ID allocation across shared graph references
    const container = buildSyntheticV3Container();
    const schema = getSchemaForHash(container.header.schemaHash);
    const normalized = normalizeDocumentGraph(container.staticData, schema.roots.static, schema);
    validateDocument(normalized, 'static', schema, { documentName: 'StaticData' });
    const idx = indexDocumentGraph(normalized, schema.roots.static, schema);
    expect(idx.maxId).toBeGreaterThan(0);
    expect(idx.byId.size).toBeGreaterThan(5);
  });
});
