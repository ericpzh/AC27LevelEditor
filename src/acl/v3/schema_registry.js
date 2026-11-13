/**
 * Schema registry and canonical SHA-256 verification for GATCARC4 v3.
 *
 * Keys validation and type metadata directly off `header.schemaHash`.
 */
const { sha256 } = require('../framing');
const schemaCa34c2ab = require('./schema_ca34c2ab.json');

const TARGET_SCHEMA_HASH = 'ca34c2ab4444042a719e43df7896794fd87ceb05977556bd405dc51e59721510';

class SchemaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SchemaError';
    Object.assign(this, details);
  }
}

class SchemaValidationError extends Error {
  constructor(document, path, reason) {
    super(`v3 schema validation failed in ${document} at ${path}: ${reason}`);
    this.name = 'SchemaValidationError';
    this.document = document;
    this.path = path;
    this.reason = reason;
  }
}

/**
 * Canonicalize a wire schema JSON object using the game's deterministic
 * lexicographic key-sorted compact JSON representation.
 */
function canonicalizeSchemaJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeSchemaJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map((k) => JSON.stringify(k) + ':' + canonicalizeSchemaJson(value[k]));
  return '{' + entries.join(',') + '}';
}

function computeSchemaHash(schemaObjOrBytes) {
  const bytes = Buffer.isBuffer(schemaObjOrBytes)
    ? schemaObjOrBytes
    : typeof schemaObjOrBytes === 'string'
      ? Buffer.from(schemaObjOrBytes, 'utf8')
      : Buffer.from(canonicalizeSchemaJson(schemaObjOrBytes), 'utf8');
  return sha256(bytes).toString('hex');
}

class CompiledSchema {
  constructor(hash, rawSchema) {
    this.hash = hash;
    this.raw = rawSchema;
    this.format = rawSchema.format;
    this.roots = rawSchema.roots;
    this.wire = rawSchema.wire;
    this.types = rawSchema.types;
    this._enumCache = new Map();
    this._memberNamesCache = new Map();
    this._assignableCache = new Map();
    this.plainRoots = new Set(Array.isArray(rawSchema.wire?.plainRoots) ? rawSchema.wire.plainRoots : []);
    this.externalAuthorities = Array.isArray(rawSchema.wire?.externalAuthorities)
      ? rawSchema.wire.externalAuthorities.slice()
      : [];
  }

  getType(typeName) {
    return Object.prototype.hasOwnProperty.call(this.types, typeName) ? this.types[typeName] : null;
  }

  /**
   * True iff a slot of `typeName` requires an explicit `"$type"` discriminator
   * on inline JSON objects in graph documents.
   */
  isPolymorphicSlot(typeName) {
    const def = this.getType(typeName);
    if (!def || def.kind !== 'object') return false;
    return def.abstract === true || (Array.isArray(def.assignable) && def.assignable.length > 0);
  }

  /**
   * True iff a concrete type `concreteTypeName` can occupy a slot declared as `slotTypeName`.
   */
  isAssignableTo(concreteTypeName, slotTypeName) {
    const concreteDef = this.getType(concreteTypeName);
    if (!concreteDef || concreteDef.kind !== 'object' || concreteDef.abstract === true) {
      return false;
    }
    if (concreteTypeName === slotTypeName) return true;
    const slotDef = this.getType(slotTypeName);
    if (!slotDef || slotDef.kind !== 'object') return false;
    let set = this._assignableCache.get(slotTypeName);
    if (!set) {
      set = new Set(Array.isArray(slotDef.assignable) ? slotDef.assignable : []);
      this._assignableCache.set(slotTypeName, set);
    }
    return set.has(concreteTypeName);
  }

  getMemberNames(typeName) {
    let names = this._memberNamesCache.get(typeName);
    if (!names) {
      const def = this.getType(typeName);
      names = def && def.members ? Object.keys(def.members) : [];
      this._memberNamesCache.set(typeName, names);
    }
    return names;
  }

  getEnumValuesBigIntSet(typeName) {
    let set = this._enumCache.get(typeName);
    if (!set) {
      const def = this.getType(typeName);
      set = new Set();
      if (def && def.values) {
        for (const v of Object.values(def.values)) {
          set.add(BigInt(v));
        }
      }
      this._enumCache.set(typeName, set);
    }
    return set;
  }
}

const REGISTRY = new Map();

(function registerBuiltInSchemas() {
  const actualHash = computeSchemaHash(schemaCa34c2ab);
  if (actualHash !== TARGET_SCHEMA_HASH) {
    throw new SchemaError(
      `Bundled v3 schema hash mismatch: expected ${TARGET_SCHEMA_HASH}, computed ${actualHash}`
    );
  }
  REGISTRY.set(TARGET_SCHEMA_HASH, new CompiledSchema(TARGET_SCHEMA_HASH, schemaCa34c2ab));
})();

function getSchemaForHash(schemaHash) {
  if (typeof schemaHash !== 'string' || !schemaHash) {
    throw new SchemaError(`GATCARC4 v3: missing or non-string header schemaHash (${String(schemaHash)})`, {
      schemaHash,
    });
  }
  const compiled = REGISTRY.get(schemaHash);
  if (!compiled) {
    throw new SchemaError(
      `GATCARC4 v3: unsupported schemaHash "${schemaHash}" (supported: ${[...REGISTRY.keys()].join(', ')})`,
      { schemaHash }
    );
  }
  return compiled;
}

module.exports = {
  TARGET_SCHEMA_HASH,
  SchemaError,
  SchemaValidationError,
  CompiledSchema,
  canonicalizeSchemaJson,
  computeSchemaHash,
  getSchemaForHash,
};
