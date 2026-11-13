/**
 * Schema validator for GATCARC4 v3 documents and complete archives.
 *
 * Enforces every wire rule declared in `schema.wire`:
 *   - `members`: "all-required-including-null-no-unknown-members"
 *   - `plainRoots`: ["metadata", "messages"] (no $id, id, $type, or $ref)
 *   - `entityGraph`: "newtonsoft-auto-object-references-v1"
 *   - `array`: "id,type,values-or-$ref"
 *   - `reactive`: "id,value-or-$ref"
 *   - `referenceId`: "positive-int32-string-or-pk:concrete-type:key"
 *   - `externalAuthorities`: ["PKStaticEntities", "StaticItems"]
 *   - `fixed`: "si-q32.32-signed-int64"
 */
const { RawJsonNumber } = require('./lossless_json');
const { INT32_MIN, INT32_MAX, INT64_MIN, INT64_MAX, UINT64_MIN, UINT64_MAX } = require('./q32');
const { getSchemaForHash, SchemaValidationError } = require('./schema_registry');
const {
  DICT_META_KEYS,
  isValidLocalId,
  isRefObject,
  isPkRefString,
  parsePkRef,
  dictEntries,
  indexDocumentGraph,
  indexStaticAuthorities,
  resolveGraphNode,
  unwrapReactive,
} = require('./graph');

const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(?:Z|[+-]\d{2}:\d{2})?$/;
const TIMESPAN_RE = /^-?(?:(\d+)\.)?(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/;

function _extractExactIntegerBigInt(val) {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') {
    if (!Number.isInteger(val) || !Number.isSafeInteger(val)) return null;
    return BigInt(val);
  }
  // RawJsonNumber is only created for fractional/exponent/"-0" tokens, never valid integers
  return null;
}

function _checkSignedRange(val, minBi, maxBi, docName, path, typeLabel) {
  const bi = _extractExactIntegerBigInt(val);
  if (bi === null) {
    throw new SchemaValidationError(docName, path, `expected integer for ${typeLabel}, got ${val instanceof RawJsonNumber ? val.raw : typeof val}`);
  }
  if (bi < minBi || bi > maxBi) {
    throw new SchemaValidationError(docName, path, `${typeLabel} value ${bi.toString()} out of range [${minBi.toString()}, ${maxBi.toString()}]`);
  }
}

function _validateDateTimeString(val, docName, path) {
  if (typeof val !== 'string') {
    throw new SchemaValidationError(docName, path, `expected DateTime string, got ${typeof val}`);
  }
  const m = val.match(ISO_DATETIME_RE);
  if (!m) {
    throw new SchemaValidationError(docName, path, `invalid ISO-8601 DateTime "${val}"`);
  }
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const hh = parseInt(m[4], 10);
  const mm = parseInt(m[5], 10);
  const ss = parseInt(m[6], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) {
    throw new SchemaValidationError(docName, path, `out-of-bounds DateTime components in "${val}"`);
  }
}

function _validateTimeSpanString(val, docName, path) {
  if (typeof val !== 'string') {
    throw new SchemaValidationError(docName, path, `expected TimeSpan string, got ${typeof val}`);
  }
  const m = val.match(TIMESPAN_RE);
  if (!m) {
    throw new SchemaValidationError(docName, path, `invalid TimeSpan "${val}"`);
  }
  const hh = parseInt(m[2], 10);
  const mm = parseInt(m[3], 10);
  const ss = parseInt(m[4], 10);
  if (hh > 23 || mm > 59 || ss > 59) {
    throw new SchemaValidationError(docName, path, `out-of-bounds TimeSpan components in "${val}"`);
  }
}

function _validateFixedTuple(val, len, docName, path, typeName) {
  if (!Array.isArray(val) || val.length !== len) {
    throw new SchemaValidationError(docName, path, `expected ${len}-element int64 array for ${typeName}`);
  }
  for (let i = 0; i < len; i++) {
    _checkSignedRange(val[i], INT64_MIN, INT64_MAX, docName, `${path}[${i}]`, `${typeName}[${i}]`);
  }
}

/**
 * Validate a single document root (`MetaData`, `StaticData`, `RecentMessages`, or `RuntimeData`)
 * against a compiled schema.
 */
function validateDocument(rootValue, rootKind, schema, options = {}) {
  const docName = options.documentName || rootKind;
  const rootTypeName = schema.roots[rootKind];
  if (!rootTypeName) {
    throw new SchemaValidationError(docName, '$', `unknown schema root kind "${rootKind}"`);
  }
  const isPlainRoot = schema.plainRoots.has(rootKind);
  const staticAuth = options.staticAuthorities || null;

  let localGraph = null;
  if (!isPlainRoot) {
    if (!rootValue || typeof rootValue !== 'object' || Array.isArray(rootValue)) {
      throw new SchemaValidationError(docName, '$', `expected root object for ${rootTypeName}`);
    }
    localGraph = indexDocumentGraph(rootValue, rootTypeName, schema);
    if (localGraph.invalidIds.length > 0) {
      const bad = localGraph.invalidIds[0];
      throw new SchemaValidationError(docName, bad.path, `invalid object/wrapper ID "${String(bad.id)}" (expected positive int32 string)`);
    }
    if (localGraph.duplicateIds.length > 0) {
      const dup = localGraph.duplicateIds[0];
      throw new SchemaValidationError(docName, dup.path, `duplicate ID "${dup.id}" (already defined at ${dup.firstPath})`);
    }
  }

  // Track DFS definition order so forward local $refs (before target $id) are caught if any
  const definedIdsSoFar = new Set();

  function validateRef(refObj, slotType, slotDef, path) {
    const keys = Object.keys(refObj);
    if (keys.length !== 1 || keys[0] !== '$ref') {
      throw new SchemaValidationError(docName, path, '$ref object must not contain extra properties');
    }
    const refStr = refObj.$ref;
    if (isPkRefString(refStr)) {
      if (slotDef.kind !== 'object') {
        throw new SchemaValidationError(docName, path, `pk: reference "${refStr}" is only valid on object slots, not ${slotDef.kind}`);
      }
      const parsed = parsePkRef(refStr);
      if (!parsed) {
        throw new SchemaValidationError(docName, path, `malformed pk: reference "${refStr}"`);
      }
      if (!schema.isAssignableTo(parsed.concreteType, slotType)) {
        throw new SchemaValidationError(
          docName,
          path,
          `pk: reference concrete type "${parsed.concreteType}" is not assignable to "${slotType}"`
        );
      }
      if (staticAuth) {
        const target = staticAuth.authorities.get(parsed.pk);
        if (!target) {
          throw new SchemaValidationError(
            docName,
            path,
            `unresolved pk: reference "${refStr}" (key "${parsed.pk}" not found in StaticData authorities)`
          );
        }
        if (target.concreteType !== parsed.concreteType) {
          throw new SchemaValidationError(
            docName,
            path,
            `pk: reference type mismatch for "${parsed.pk}": ref declares "${parsed.concreteType}", authority has "${target.concreteType}"`
          );
        }
      }
      return;
    }

    if (!isValidLocalId(refStr)) {
      throw new SchemaValidationError(docName, path, `invalid local $ref "${refStr}" (expected positive int32 string or pk:...)`);
    }
    const target = localGraph.byId.get(refStr);
    if (!target) {
      throw new SchemaValidationError(docName, path, `unresolved local $ref "${refStr}"`);
    }
    if (!definedIdsSoFar.has(refStr)) {
      throw new SchemaValidationError(docName, path, `forward local $ref "${refStr}" precedes target definition at ${target.path}`);
    }
    if (slotDef.kind === 'array') {
      if (target.kind !== 'array' || target.concreteType !== slotType) {
        throw new SchemaValidationError(docName, path, `$ref "${refStr}" points to ${target.kind} (${target.concreteType}), expected array ${slotType}`);
      }
    } else if (slotDef.kind === 'reactive') {
      if (target.kind !== 'reactive' || target.concreteType !== slotType) {
        throw new SchemaValidationError(docName, path, `$ref "${refStr}" points to ${target.kind} (${target.concreteType}), expected reactive ${slotType}`);
      }
    } else if (slotDef.kind === 'dictionary') {
      if (target.kind !== 'dictionary' || target.concreteType !== slotType) {
        throw new SchemaValidationError(docName, path, `$ref "${refStr}" points to ${target.kind} (${target.concreteType}), expected dictionary ${slotType}`);
      }
    } else if (slotDef.kind === 'object') {
      if (target.kind !== 'object' || !schema.isAssignableTo(target.concreteType, slotType)) {
        throw new SchemaValidationError(
          docName,
          path,
          `$ref "${refStr}" target type "${target.concreteType}" is not assignable to "${slotType}"`
        );
      }
    }
  }

  function validateValue(val, slotType, allowNull, path) {
    const def = schema.getType(slotType);
    if (!def) {
      throw new SchemaValidationError(docName, path, `unknown schema type "${slotType}"`);
    }

    if (val === undefined) {
      throw new SchemaValidationError(docName, path, `missing value (undefined) for "${slotType}"`);
    }

    if (val === null) {
      if (!allowNull || (def.nullable === false && def.kind !== 'nullable')) {
        throw new SchemaValidationError(docName, path, `null is not allowed for "${slotType}"`);
      }
      return;
    }

    switch (def.kind) {
      case 'nullable': {
        validateValue(val, def.value, true, path);
        return;
      }

      case 'boolean': {
        if (typeof val !== 'boolean') {
          throw new SchemaValidationError(docName, path, `expected boolean, got ${typeof val}`);
        }
        return;
      }

      case 'string': {
        if (def.encoding === 'DateTime') {
          _validateDateTimeString(val, docName, path);
          return;
        }
        if (def.encoding === 'TimeSpan') {
          _validateTimeSpanString(val, docName, path);
          return;
        }
        if (typeof val !== 'string') {
          throw new SchemaValidationError(docName, path, `expected string, got ${typeof val}`);
        }
        return;
      }

      case 'integer': {
        const minBi = def.min !== undefined ? BigInt(def.min) : INT64_MIN;
        const maxBi = def.max !== undefined ? BigInt(def.max) : INT64_MAX;
        _checkSignedRange(val, minBi, maxBi, docName, path, slotType);
        return;
      }

      case 'fixedArray': {
        _validateFixedTuple(val, def.length, docName, path, slotType);
        return;
      }

      case 'enum': {
        const bi = _extractExactIntegerBigInt(val);
        if (bi === null) {
          throw new SchemaValidationError(docName, path, `expected integer enum value for ${slotType}`);
        }
        if (def.flags) {
          // Bitmask flags enum: check signed Int32 range
          _checkSignedRange(val, INT32_MIN, INT32_MAX, docName, path, slotType);
          return;
        }
        const allowed = schema.getEnumValuesBigIntSet(slotType);
        if (!allowed.has(bi)) {
          throw new SchemaValidationError(docName, path, `invalid enum value ${bi.toString()} for ${slotType}`);
        }
        return;
      }

      case 'list': {
        if (!Array.isArray(val)) {
          throw new SchemaValidationError(docName, path, `expected plain JSON array for List ${slotType}`);
        }
        const elemDef = schema.getType(def.element);
        const elemAllowNull = elemDef ? elemDef.nullable !== false : true;
        for (let i = 0; i < val.length; i++) {
          validateValue(val[i], def.element, elemAllowNull, `${path}[${i}]`);
        }
        return;
      }

      case 'array': {
        const elemDef = schema.getType(def.element);
        const elemAllowNull = elemDef ? elemDef.nullable !== false : true;
        if (isPlainRoot) {
          if (!Array.isArray(val)) {
            throw new SchemaValidationError(docName, path, `expected plain JSON array in plain root for ${slotType}`);
          }
          for (let i = 0; i < val.length; i++) {
            validateValue(val[i], def.element, elemAllowNull, `${path}[${i}]`);
          }
          return;
        }
        if (typeof val !== 'object' || Array.isArray(val)) {
          throw new SchemaValidationError(docName, path, `expected {id, type, values} wrapper or $ref for ${slotType}`);
        }
        if (Object.prototype.hasOwnProperty.call(val, '$ref')) {
          validateRef(val, slotType, def, path);
          return;
        }
        const keys = Object.keys(val);
        if (
          keys.length !== 3 ||
          !Object.prototype.hasOwnProperty.call(val, 'id') ||
          !Object.prototype.hasOwnProperty.call(val, 'type') ||
          !Object.prototype.hasOwnProperty.call(val, 'values')
        ) {
          throw new SchemaValidationError(docName, path, `typed array wrapper must have exact keys {id, type, values} (got {${keys.join(', ')}})`);
        }
        if (!isValidLocalId(val.id)) {
          throw new SchemaValidationError(docName, `${path}.id`, `invalid array wrapper id "${String(val.id)}"`);
        }
        definedIdsSoFar.add(val.id);
        if (val.type !== slotType) {
          throw new SchemaValidationError(docName, `${path}.type`, `array wrapper type "${String(val.type)}" does not match slot "${slotType}"`);
        }
        if (!Array.isArray(val.values)) {
          throw new SchemaValidationError(docName, `${path}.values`, 'expected JSON array for wrapper .values');
        }
        for (let i = 0; i < val.values.length; i++) {
          validateValue(val.values[i], def.element, elemAllowNull, `${path}.values[${i}]`);
        }
        return;
      }

      case 'reactive': {
        if (isPlainRoot) {
          throw new SchemaValidationError(docName, path, `reactive wrapper ${slotType} is not allowed in plain root`);
        }
        if (typeof val !== 'object' || Array.isArray(val)) {
          throw new SchemaValidationError(docName, path, `expected {id, value} wrapper or $ref for ${slotType}`);
        }
        if (Object.prototype.hasOwnProperty.call(val, '$ref')) {
          validateRef(val, slotType, def, path);
          return;
        }
        const keys = Object.keys(val);
        if (
          keys.length !== 2 ||
          !Object.prototype.hasOwnProperty.call(val, 'id') ||
          !Object.prototype.hasOwnProperty.call(val, 'value')
        ) {
          throw new SchemaValidationError(docName, path, `reactive wrapper must have exact keys {id, value} (got {${keys.join(', ')}})`);
        }
        if (!isValidLocalId(val.id)) {
          throw new SchemaValidationError(docName, `${path}.id`, `invalid reactive wrapper id "${String(val.id)}"`);
        }
        definedIdsSoFar.add(val.id);
        const elemDef = schema.getType(def.value);
        const elemAllowNull = elemDef ? elemDef.nullable !== false : true;
        validateValue(val.value, def.value, elemAllowNull, `${path}.value`);
        return;
      }

      case 'dictionary': {
        if (typeof val !== 'object' || Array.isArray(val)) {
          throw new SchemaValidationError(docName, path, `expected object for dictionary ${slotType}`);
        }
        if (!isPlainRoot && Object.prototype.hasOwnProperty.call(val, '$ref')) {
          validateRef(val, slotType, def, path);
          return;
        }
        if (isPlainRoot) {
          if (Object.prototype.hasOwnProperty.call(val, '$id') || Object.prototype.hasOwnProperty.call(val, '$type') || Object.prototype.hasOwnProperty.call(val, '$ref')) {
            throw new SchemaValidationError(docName, path, 'dictionary in plain root must not contain $id/$type/$ref metadata');
          }
        } else {
          if (!Object.prototype.hasOwnProperty.call(val, '$id') || !isValidLocalId(val.$id)) {
            throw new SchemaValidationError(docName, path, `dictionary ${slotType} requires a valid positive-int32 "$id"`);
          }
          if (Object.prototype.hasOwnProperty.call(val, '$type')) {
            throw new SchemaValidationError(docName, path, `dictionary ${slotType} must not declare "$type"`);
          }
          definedIdsSoFar.add(val.$id);
        }
        const valDef = schema.getType(def.value);
        const valAllowNull = valDef ? valDef.nullable !== false : true;
        for (const [k, entryVal] of dictEntries(val)) {
          validateValue(entryVal, def.value, valAllowNull, `${path}[${JSON.stringify(k)}]`);
        }
        return;
      }

      case 'object': {
        if (typeof val !== 'object' || Array.isArray(val)) {
          throw new SchemaValidationError(docName, path, `expected JSON object for ${slotType}`);
        }
        if (Object.prototype.hasOwnProperty.call(val, '$ref')) {
          if (isPlainRoot) {
            throw new SchemaValidationError(docName, path, `$ref is not allowed in plain root ${docName}`);
          }
          validateRef(val, slotType, def, path);
          return;
        }

        let concreteType = slotType;
        if (isPlainRoot) {
          if (Object.prototype.hasOwnProperty.call(val, '$id') || Object.prototype.hasOwnProperty.call(val, '$type')) {
            throw new SchemaValidationError(docName, path, `plain root object ${slotType} must not contain $id or $type`);
          }
        } else {
          if (!Object.prototype.hasOwnProperty.call(val, '$id') || !isValidLocalId(val.$id)) {
            throw new SchemaValidationError(docName, path, `object ${slotType} requires a valid positive-int32 "$id"`);
          }
          definedIdsSoFar.add(val.$id);

          const isPoly = schema.isPolymorphicSlot(slotType);
          const hasType = Object.prototype.hasOwnProperty.call(val, '$type');
          if (isPoly) {
            if (!hasType || typeof val.$type !== 'string') {
              throw new SchemaValidationError(docName, path, `polymorphic slot ${slotType} requires "$type"`);
            }
            if (!schema.isAssignableTo(val.$type, slotType)) {
              throw new SchemaValidationError(
                docName,
                path,
                `concrete "$type" "${val.$type}" is not assignable to slot "${slotType}"`
              );
            }
            concreteType = val.$type;
          } else if (hasType) {
            throw new SchemaValidationError(
              docName,
              path,
              `concrete slot ${slotType} must not include "$type" (got "${String(val.$type)}")`
            );
          }
        }

        const cDef = schema.getType(concreteType);
        if (!cDef || cDef.kind !== 'object' || cDef.abstract) {
          throw new SchemaValidationError(docName, path, `invalid concrete object type "${concreteType}"`);
        }

        const declaredMembers = cDef.members || {};
        const declaredKeys = schema.getMemberNames(concreteType);

        // Reject unknown members
        for (const k of Object.keys(val)) {
          if (!isPlainRoot && (k === '$id' || k === '$type')) continue;
          if (!Object.prototype.hasOwnProperty.call(declaredMembers, k)) {
            throw new SchemaValidationError(docName, `${path}.${k}`, `unknown member "${k}" on ${concreteType}`);
          }
        }

        // Enforce all required members (including explicit null) and validate in wire traversal order
        for (const k of declaredKeys) {
          if (!Object.prototype.hasOwnProperty.call(val, k)) {
            throw new SchemaValidationError(docName, `${path}.${k}`, `missing required member "${k}" on ${concreteType}`);
          }
        }

        // Traverse in actual property order on `val` so `definedIdsSoFar` matches wire serialization order
        for (const k of Object.keys(val)) {
          if (!isPlainRoot && (k === '$id' || k === '$type')) continue;
          const mSpec = declaredMembers[k];
          validateValue(val[k], mSpec.type, Boolean(mSpec.allowNull), `${path}.${k}`);
        }
        return;
      }

      default:
        throw new SchemaValidationError(docName, path, `unsupported schema kind "${def.kind}" on ${slotType}`);
    }
  }

  validateValue(rootValue, rootTypeName, false, '$');
  return localGraph;
}

/**
 * Validate an entire parsed GATCARC4 v3 container (`header`, `metaData`, `staticData`,
 * and every checkpoint frame's `summary`, `runtimeData`, and `recentMessages`).
 */
function validateV3Container(container) {
  if (!container || !container.header) {
    throw new SchemaValidationError('Header', '$', 'missing v3 archive header');
  }
  const h = container.header;
  const schema = getSchemaForHash(h.schemaHash);

  for (const field of ['schemaHash', 'archiveGuid', 'levelGuid', 'airportIcao']) {
    if (typeof h[field] !== 'string' || !h[field]) {
      throw new SchemaValidationError('Header', `$.${field}`, `expected non-empty string header.${field}`);
    }
  }
  if (h.progressDisplayName !== null && typeof h.progressDisplayName !== 'string') {
    throw new SchemaValidationError('Header', '$.progressDisplayName', 'expected string or null header.progressDisplayName');
  }

  validateDocument(container.metaData, 'metadata', schema, { documentName: 'MetaData' });

  if (container.metaData.Guid !== h.levelGuid) {
    throw new SchemaValidationError(
      'Header',
      '$.levelGuid',
      `header.levelGuid "${h.levelGuid}" does not match MetaData.Guid "${container.metaData.Guid}"`
    );
  }

  const staticGraph = validateDocument(container.staticData, 'static', schema, {
    documentName: 'StaticData',
  });
  const staticAuthorities = indexStaticAuthorities(container.staticData, schema, staticGraph);

  // Also check any pk: references inside StaticData itself against staticAuthorities
  for (const r of staticGraph.refs) {
    if (isPkRefString(r.refId)) {
      const parsed = parsePkRef(r.refId);
      const hit = parsed ? staticAuthorities.authorities.get(parsed.pk) : null;
      if (!hit || hit.concreteType !== parsed.concreteType) {
        throw new SchemaValidationError('StaticData', r.path, `unresolved StaticData pk: reference "${r.refId}"`);
      }
    }
  }

  // Enforce NavigationGraph invariant: TaxiwaySegments must have >= 2 nodes and non-zero consecutive edge lengths
  const pkDict = resolveGraphNode(container.staticData.PKStaticEntities, staticGraph);
  if (pkDict) {
    for (const [pk, rawVal] of dictEntries(pkDict)) {
      if (!pk.startsWith('taxiway-segment:')) continue;
      const seg = resolveGraphNode(rawVal, staticGraph);
      const nodes = (unwrapReactive(seg?.Nodes, staticGraph) || []).map((r) => resolveGraphNode(r, staticGraph));
      if (nodes.length < 2) {
        throw new SchemaValidationError(
          'StaticData',
          `$.PKStaticEntities[${JSON.stringify(pk)}].Nodes`,
          'TaxiwaySegment must contain at least 2 nodes',
        );
      }
      for (let ni = 1; ni < nodes.length; ni++) {
        const pA = unwrapReactive(nodes[ni - 1]?.ReactivePosition, staticGraph);
        const pB = unwrapReactive(nodes[ni]?.ReactivePosition, staticGraph);
        if (
          Array.isArray(pA) &&
          Array.isArray(pB) &&
          String(pA[0]) === String(pB[0]) &&
          String(pA[1]) === String(pB[1]) &&
          String(pA[2]) === String(pB[2])
        ) {
          throw new SchemaValidationError(
            'StaticData',
            `$.PKStaticEntities[${JSON.stringify(pk)}].Nodes.value[${ni}]`,
            `zero-length TaxiwaySegment edge between "${nodes[ni - 1]?.PK}" and "${nodes[ni]?.PK}"`,
          );
        }
      }
    }
  }

  const frames = container.frames || [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const s = f.summary;
    const sumDoc = `Frame[${i}].Summary`;
    if (!s || typeof s !== 'object') {
      throw new SchemaValidationError(sumDoc, '$', 'missing frame summary');
    }
    _checkSignedRange(s.kind, 0n, 1n, sumDoc, '$.kind', 'CheckpointKind');
    if (s.displayName !== null && typeof s.displayName !== 'string') {
      throw new SchemaValidationError(sumDoc, '$.displayName', 'expected string or null displayName');
    }
    _checkSignedRange(s.createdAtUtcTicks, 1n, INT64_MAX, sumDoc, '$.createdAtUtcTicks', 'createdAtUtcTicks');
    _checkSignedRange(s.inGameDateTimeTicks, 0n, INT64_MAX, sumDoc, '$.inGameDateTimeTicks', 'inGameDateTimeTicks');
    _checkSignedRange(s.departureCount, 0n, INT32_MAX, sumDoc, '$.departureCount', 'departureCount');
    _checkSignedRange(s.arrivalCount, 0n, INT32_MAX, sumDoc, '$.arrivalCount', 'arrivalCount');

    validateDocument(f.recentMessages, 'messages', schema, {
      documentName: `Frame[${i}].RecentMessages`,
    });
    validateDocument(f.runtimeData, 'runtime', schema, {
      documentName: `Frame[${i}].RuntimeData`,
      staticAuthorities,
    });
  }

  return { schema, staticAuthorities };
}

module.exports = {
  validateDocument,
  validateV3Container,
};
