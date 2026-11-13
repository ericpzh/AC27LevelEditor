/**
 * Reference graph indexing, wrapper handling, PK cross-document resolution,
 * and canonical DFS ID allocation for GATCARC4 v3 documents (`StaticData` & `RuntimeData`).
 *
 * Wire rules (`schema.wire`):
 *   - `entityGraph`: "newtonsoft-auto-object-references-v1"
 *   - `array`: "id,type,values-or-$ref"
 *   - `reactive`: "id,value-or-$ref"
 *   - `referenceId`: "positive-int32-string-or-pk:concrete-type:key"
 *   - `externalAuthorities`: ["PKStaticEntities", "StaticItems"]
 */
const { INT32_MAX } = require('./q32');

const DICT_META_KEYS = new Set(['$id', '$type', '$ref']);
const POS_INT32_STR_RE = /^[1-9]\d{0,9}$/;

function isValidLocalId(idStr) {
  if (typeof idStr !== 'string' || !POS_INT32_STR_RE.test(idStr)) return false;
  const bi = BigInt(idStr);
  return bi >= 1n && bi <= INT32_MAX;
}

function isRefObject(val) {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val) && typeof val.$ref === 'string');
}

function isPkRefString(refStr) {
  return typeof refStr === 'string' && refStr.startsWith('pk:');
}

/**
 * Parse `"pk:<ConcreteType>:<key>"`, preserving colons inside `<key>`
 * (e.g. `"pk:ContextCross.Models.FixedTaxiNavigationPoint:taxi-navigation:stand:24"`).
 * Returns `{ concreteType, pk } | null`.
 */
function parsePkRef(refStr) {
  if (!isPkRefString(refStr)) return null;
  const secondColon = refStr.indexOf(':', 3);
  if (secondColon <= 3 || secondColon >= refStr.length - 1) return null;
  const concreteType = refStr.slice(3, secondColon);
  const pk = refStr.slice(secondColon + 1);
  if (!concreteType || !pk) return null;
  return { concreteType, pk };
}

function formatPkRef(concreteType, pk) {
  return `pk:${concreteType}:${pk}`;
}

function makePkRef(concreteType, pk) {
  return { $ref: formatPkRef(concreteType, pk) };
}

// ─── Dictionary helpers (keep PK entries distinct from $id/$type/$ref metadata) ───

function dictEntries(dictObj) {
  if (!dictObj || typeof dictObj !== 'object' || Array.isArray(dictObj)) return [];
  const out = [];
  for (const k of Object.keys(dictObj)) {
    if (DICT_META_KEYS.has(k)) continue;
    out.push([k, dictObj[k]]);
  }
  return out;
}

function dictKeys(dictObj) {
  if (!dictObj || typeof dictObj !== 'object' || Array.isArray(dictObj)) return [];
  return Object.keys(dictObj).filter((k) => !DICT_META_KEYS.has(k));
}

function dictGet(dictObj, pk) {
  if (!dictObj || typeof dictObj !== 'object' || DICT_META_KEYS.has(pk)) return undefined;
  return Object.prototype.hasOwnProperty.call(dictObj, pk) ? dictObj[pk] : undefined;
}

function dictHas(dictObj, pk) {
  if (!dictObj || typeof dictObj !== 'object' || DICT_META_KEYS.has(pk)) return false;
  return Object.prototype.hasOwnProperty.call(dictObj, pk);
}

function dictSet(dictObj, pk, value) {
  if (DICT_META_KEYS.has(pk)) {
    throw new Error(`Cannot use reserved metadata key "${pk}" as dictionary PK`);
  }
  if (pk === '__proto__') {
    Object.defineProperty(dictObj, pk, { value, enumerable: true, configurable: true, writable: true });
  } else {
    dictObj[pk] = value;
  }
}

function dictDelete(dictObj, pk) {
  if (!dictObj || typeof dictObj !== 'object' || DICT_META_KEYS.has(pk)) return false;
  if (!Object.prototype.hasOwnProperty.call(dictObj, pk)) return false;
  delete dictObj[pk];
  return true;
}

// ─── Wrapper helpers ──────────────────────────────────────────────────────────

function makeTypedArray(typeName, values = [], id = undefined) {
  const obj = {};
  if (id !== undefined) obj.id = String(id);
  obj.type = typeName;
  obj.values = values;
  return obj;
}

function makeReactive(value, id = undefined) {
  const obj = {};
  if (id !== undefined) obj.id = String(id);
  obj.value = value;
  return obj;
}

// ─── Graph Indexing & Resolution ──────────────────────────────────────────────

/**
 * Index all `$id`, wrapper `id`, and `$ref` nodes inside a graph root document
 * (`StaticData` or `RuntimeData`) guided by the compiled schema.
 */
function indexDocumentGraph(rootObj, rootTypeName, schema) {
  const byId = new Map();
  const idByNode = new WeakMap();
  const refs = [];
  const duplicateIds = [];
  const invalidIds = [];
  let maxId = 0;

  function recordId(idStr, node, concreteType, kind, path) {
    if (!isValidLocalId(idStr)) {
      invalidIds.push({ id: idStr, path });
      return;
    }
    const num = Number(idStr);
    if (num > maxId) maxId = num;
    if (byId.has(idStr)) {
      duplicateIds.push({ id: idStr, path, firstPath: byId.get(idStr).path });
      return;
    }
    byId.set(idStr, { id: idStr, node, concreteType, kind, path });
    idByNode.set(node, idStr);
  }

  function visit(val, slotType, path) {
    if (val === null || val === undefined) return;
    const def = schema.getType(slotType);
    if (!def) return;

    if (
      def.kind === 'boolean' ||
      def.kind === 'string' ||
      def.kind === 'integer' ||
      def.kind === 'enum' ||
      def.kind === 'fixedArray'
    ) {
      return;
    }

    if (def.kind === 'nullable') {
      visit(val, def.value, path);
      return;
    }

    if (def.kind === 'list') {
      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          visit(val[i], def.element, `${path}[${i}]`);
        }
      }
      return;
    }

    if (isRefObject(val)) {
      refs.push({ node: val, refId: val.$ref, slotType, path });
      return;
    }

    if (typeof val !== 'object' || Array.isArray(val)) return;

    if (def.kind === 'array') {
      if (Object.prototype.hasOwnProperty.call(val, 'id')) {
        recordId(val.id, val, val.type || slotType, 'array', path);
      }
      if (Array.isArray(val.values)) {
        for (let i = 0; i < val.values.length; i++) {
          visit(val.values[i], def.element, `${path}.values[${i}]`);
        }
      }
      return;
    }

    if (def.kind === 'reactive') {
      if (Object.prototype.hasOwnProperty.call(val, 'id')) {
        recordId(val.id, val, slotType, 'reactive', path);
      }
      visit(val.value, def.value, `${path}.value`);
      return;
    }

    if (def.kind === 'dictionary') {
      if (Object.prototype.hasOwnProperty.call(val, '$id')) {
        recordId(val.$id, val, slotType, 'dictionary', path);
      }
      for (const [k, entryVal] of dictEntries(val)) {
        visit(entryVal, def.value, `${path}[${JSON.stringify(k)}]`);
      }
      return;
    }

    if (def.kind === 'object') {
      const concreteType = typeof val.$type === 'string' ? val.$type : slotType;
      if (Object.prototype.hasOwnProperty.call(val, '$id')) {
        recordId(val.$id, val, concreteType, 'object', path);
      }
      const cDef = schema.getType(concreteType);
      if (cDef && cDef.members) {
        // Follow present key order for DFS fidelity, then check any schema-declared keys
        for (const k of Object.keys(val)) {
          if (DICT_META_KEYS.has(k)) continue;
          const mSpec = cDef.members[k];
          if (mSpec) visit(val[k], mSpec.type, `${path}.${k}`);
        }
      }
    }
  }

  visit(rootObj, rootTypeName, '$');

  return {
    byId,
    idByNode,
    refs,
    duplicateIds,
    invalidIds,
    maxId,
    allocateNextId() {
      maxId += 1;
      if (BigInt(maxId) > INT32_MAX) {
        throw new RangeError('v3 graph ID allocator exceeded positive Int32 limit');
      }
      return String(maxId);
    },
  };
}

/**
 * Index external PK authorities (`PKStaticEntities` and `StaticItems`) in `StaticData`
 * so `pk:<ConcreteType>:<key>` references can be resolved and type-checked.
 */
function indexStaticAuthorities(staticData, schema, staticGraphIndex = null) {
  const sIdx = staticGraphIndex || indexDocumentGraph(staticData, schema.roots.static, schema);
  const authorities = new Map(); // pk -> { authorityName, pk, node, concreteType }

  for (const authName of schema.externalAuthorities) {
    let dictObj = staticData ? staticData[authName] : null;
    if (isRefObject(dictObj)) {
      dictObj = sIdx.byId.get(dictObj.$ref)?.node || null;
    }
    if (!dictObj || typeof dictObj !== 'object') continue;
    const dictSlotType = schema.getType(schema.roots.static)?.members?.[authName]?.type;
    const elemSlotType = dictSlotType ? schema.getType(dictSlotType)?.value : null;

    for (const [pk, rawEntry] of dictEntries(dictObj)) {
      let targetNode = rawEntry;
      let concreteType = null;
      if (isRefObject(rawEntry)) {
        const hit = sIdx.byId.get(rawEntry.$ref);
        if (hit) {
          targetNode = hit.node;
          concreteType = hit.concreteType;
        }
      } else if (rawEntry && typeof rawEntry === 'object') {
        concreteType = typeof rawEntry.$type === 'string' ? rawEntry.$type : elemSlotType;
      }
      if (targetNode && concreteType) {
        authorities.set(pk, { authorityName: authName, pk, node: targetNode, concreteType });
      }
    }
  }

  return { staticGraph: sIdx, authorities };
}

/**
 * Resolve a value that may be an inline object/wrapper or a `{"$ref": ...}` object.
 */
function resolveGraphNode(val, localGraph, staticAuth = null) {
  if (!isRefObject(val)) return val;
  const refStr = val.$ref;
  if (isPkRefString(refStr)) {
    if (!staticAuth) return null;
    const parsed = parsePkRef(refStr);
    if (!parsed) return null;
    const entry = staticAuth.authorities.get(parsed.pk);
    if (!entry || entry.concreteType !== parsed.concreteType) return null;
    return entry.node;
  }
  return localGraph?.byId.get(refStr)?.node || null;
}

function unwrapReactive(val, localGraph) {
  const resolved = resolveGraphNode(val, localGraph);
  if (!resolved || typeof resolved !== 'object') return undefined;
  return resolved.value;
}

function unwrapTypedArray(val, localGraph) {
  const resolved = resolveGraphNode(val, localGraph);
  if (!resolved || typeof resolved !== 'object' || !Array.isArray(resolved.values)) return [];
  return resolved.values;
}

/**
 * Canonicalize a mutated graph document (`StaticData` or `RuntimeData`) in-place/rebuilt:
 *   1. Resolves any pre-existing local `{"$ref": "<oldId>"}` pointers against `existingIndex`
 *      so moved/reordered subtrees never break local `$ref` links.
 *   2. Walks the document in DFS order, assigning clean consecutive positive-int32 string IDs
 *      `"1".."N"` to every first-seen object (`$id`), dictionary (`$id`), typed-array (`id`),
 *      and reactive (`id`), and emitting `{"$ref": "<assignedId>"}` on subsequent visits to
 *      the same JS object instance.
 *   3. Preserves `"pk:<ConcreteType>:<key>"` cross-document references untouched.
 *   4. Ensures `"$type"` is present iff `schema.isPolymorphicSlot(slotType)` is true.
 */
function normalizeDocumentGraph(rootObj, rootTypeName, schema, preMutationIndex = null) {
  // Pass 1: seed from `preMutationIndex` (if captured before mutating `rootObj` so shared
  // sub-objects originally inlined inside a now-removed entity still resolve cleanly!) and
  // also collect all existing $id / id targets in the current tree.
  const oldTargets = new Map();
  const knownConcreteTypes = new WeakMap();
  if (preMutationIndex && preMutationIndex.byId) {
    for (const [idStr, entry] of preMutationIndex.byId.entries()) {
      if (entry && entry.node) {
        oldTargets.set(idStr, entry.node);
        if (entry.concreteType) {
          knownConcreteTypes.set(entry.node, entry.concreteType);
        }
      }
    }
  }
  function collectOldIds(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const el of node) collectOldIds(el);
      return;
    }
    if (isRefObject(node)) return;
    if (typeof node.$type === 'string') {
      knownConcreteTypes.set(node, node.$type);
    }
    if (typeof node.$id === 'string' && !oldTargets.has(node.$id)) {
      oldTargets.set(node.$id, node);
    } else if (typeof node.id === 'string' && (Object.prototype.hasOwnProperty.call(node, 'values') || Object.prototype.hasOwnProperty.call(node, 'value')) && !oldTargets.has(node.id)) {
      oldTargets.set(node.id, node);
    }
    for (const k of Object.keys(node)) {
      if (DICT_META_KEYS.has(k)) continue;
      collectOldIds(node[k]);
    }
  }
  collectOldIds(rootObj);

  // Pass 2: DFS emit with consecutive 1..N IDs and automatic duplicate-object -> $ref
  const assignedIds = new WeakMap();
  let nextId = 0;
  function allocId(sourceObj) {
    nextId += 1;
    if (BigInt(nextId) > INT32_MAX) {
      throw new RangeError('v3 graph normalization exceeded positive Int32 ID limit');
    }
    const idStr = String(nextId);
    assignedIds.set(sourceObj, idStr);
    return idStr;
  }

  function emit(val, slotType, path) {
    if (val === null || val === undefined) return null;
    const def = schema.getType(slotType);
    if (!def) {
      throw new Error(`Unknown schema type "${slotType}" at ${path}`);
    }

    if (
      def.kind === 'boolean' ||
      def.kind === 'string' ||
      def.kind === 'integer' ||
      def.kind === 'enum' ||
      def.kind === 'fixedArray'
    ) {
      return val;
    }

    if (def.kind === 'nullable') {
      return emit(val, def.value, path);
    }

    if (def.kind === 'list') {
      if (!Array.isArray(val)) {
        throw new Error(`Expected Array for list ${slotType} at ${path}`);
      }
      return val.map((el, i) => emit(el, def.element, `${path}[${i}]`));
    }

    // Resolve local {"$ref": oldId} to target JS object; keep pk: refs as-is
    let target = val;
    if (isRefObject(val)) {
      if (isPkRefString(val.$ref)) {
        return { $ref: val.$ref };
      }
      const resolved = oldTargets.get(val.$ref);
      if (!resolved) {
        throw new Error(`Dangling local $ref "${val.$ref}" at ${path}`);
      }
      target = resolved;
    }

    if (typeof target !== 'object' || Array.isArray(target)) {
      throw new Error(`Expected wrapper/object for ${slotType} at ${path}`);
    }

    // If this exact JS object/wrapper was already emitted earlier in DFS, emit $ref!
    const existingId = assignedIds.get(target);
    if (existingId) {
      return { $ref: existingId };
    }

    if (def.kind === 'array') {
      const idStr = allocId(target);
      const values = Array.isArray(target.values) ? target.values : [];
      const outValues = new Array(values.length);
      for (let i = 0; i < values.length; i++) {
        outValues[i] = emit(values[i], def.element, `${path}.values[${i}]`);
      }
      return { id: idStr, type: slotType, values: outValues };
    }

    if (def.kind === 'reactive') {
      const idStr = allocId(target);
      const outVal = emit(target.value, def.value, `${path}.value`);
      return { id: idStr, value: outVal };
    }

    if (def.kind === 'dictionary') {
      const idStr = allocId(target);
      const out = { $id: idStr };
      for (const [k, entryVal] of dictEntries(target)) {
        dictSet(out, k, emit(entryVal, def.value, `${path}[${JSON.stringify(k)}]`));
      }
      return out;
    }

    if (def.kind === 'object') {
      const needPoly = schema.isPolymorphicSlot(slotType);
      const concreteType = typeof target.$type === 'string'
        ? target.$type
        : (knownConcreteTypes.get(target) || slotType);
      const cDef = schema.getType(concreteType);
      if (!cDef || cDef.kind !== 'object' || cDef.abstract) {
        throw new Error(`Invalid concrete type "${concreteType}" for slot "${slotType}" at ${path}`);
      }
      const idStr = allocId(target);
      const out = { $id: idStr };
      if (needPoly) {
        out.$type = concreteType;
      }
      // Preserve existing member order when present, appending any missing declared keys
      const declaredMembers = cDef.members || {};
      const seenMembers = new Set();
      for (const k of Object.keys(target)) {
        if (DICT_META_KEYS.has(k)) continue;
        if (!Object.prototype.hasOwnProperty.call(declaredMembers, k)) {
          // Keep unknown member if caller accidentally passed one so validator flags it with path,
          // OR throw immediately; throwing/preserving lets validator catch it cleanly.
          out[k] = target[k];
          continue;
        }
        seenMembers.add(k);
        out[k] = emit(target[k], declaredMembers[k].type, `${path}.${k}`);
      }
      for (const k of Object.keys(declaredMembers)) {
        if (!seenMembers.has(k)) {
          const rawMemberVal = Object.prototype.hasOwnProperty.call(target, k) ? target[k] : null;
          out[k] = emit(rawMemberVal, declaredMembers[k].type, `${path}.${k}`);
        }
      }
      return out;
    }

    return target;
  }

  return emit(rootObj, rootTypeName, '$');
}

module.exports = {
  DICT_META_KEYS,
  isValidLocalId,
  isRefObject,
  isPkRefString,
  parsePkRef,
  formatPkRef,
  makePkRef,
  dictEntries,
  dictKeys,
  dictGet,
  dictHas,
  dictSet,
  dictDelete,
  makeTypedArray,
  makeReactive,
  indexDocumentGraph,
  indexStaticAuthorities,
  resolveGraphNode,
  unwrapReactive,
  unwrapTypedArray,
  normalizeDocumentGraph,
};
