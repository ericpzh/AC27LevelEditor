/**
 * Odin JSON $id / $iref renumberer — strictly ascending ids in text order.
 *
 * WHY: the editor's segment rebuild allocates $id values in *construction*
 * order, which differs from *text emission* order.  An
 * R3.ReactiveProperty<Aircraft> wrapper may receive $id 1123 while its
 * inline Aircraft value gets 1120, its shared String[] 1117 and its
 * inline _flightPlan 1084; kept entries keep their original low $ids
 * (62, 70, ...) after the new high ones.  The game's checkpoint reader
 * (JsonDataReader) requires $id values to be strictly ascending in text
 * order within each document — every healthy game-authored file has
 * ascending ids per scope, and the editor's descending steps make the
 * game misbind the DockingAircraft inline value, ending in a
 * `SetDockingTarget(null)` NullReferenceException during level init.
 *
 * This pass rewrites every $id declaration and $iref reference to a
 * strictly ascending sequence in text order, using ONE shared counter
 * across a document and its nested $blobdoc values.  $blobdoc values are
 * independent documents (each with its own reference table) but the
 * outer document may reference ids declared inside them (e.g. the
 * `aircraft:` stub entries `$iref` the aircraft declared in the
 * RuntimeData byte[] payload), so a shared map keeps every reference
 * consistent.  Id values are opaque labels: renaming them in declaration
 * order preserves every binding and $type resolution.
 *
 * $eref / $fstrref / $guidref are untouched (different id spaces).
 * A $iref whose target should be declared LATER in the same scope (a genuine
 * forward reference in text order) throws — healthy files never contain one.
 * A $iref whose target is never declared anywhere in the segment is DANGLING:
 * it legitimately appears after the Ground Painter deletes an entity whose $id
 * is still referenced by a surviving shared sub-object. Such a reference is
 * preserved verbatim (its value reserved so no fresh $id collides), and the
 * game's reader resolves it to null instead of the editor throwing on a
 * legitimate delete.
 *
 * $type ids are ALSO corrected here. Odin JSON introduces a type id at its first
 * text occurrence (`"$type": "<id>|<Name>"`) and emits a bare `"$type": <id>` for
 * later occurrences. Deleting the object that carried the inline registration
 * orphans id → name for the survivors. Given the ORIGINAL (pre-edit) text, this
 * pass re-introduces the inline registration at the first surviving reference of
 * each orphaned type id, keeping the encoded document valid.
 */

'use strict';

class Scope {
  constructor() {
    this.nextId = 1; // strictly ascending fresh values within this scope
    this.map = new Map(); // old id -> new id, last declaration wins
  }
}

/**
 * @param {string} text one Odin JSON document
 * @param {Scope} scope renumber state for this document's id namespace
 * @param {Map<number, number>} global old->new registry shared across the
 *                 whole segment (outer doc + all nested $blobdoc values),
 *                 first declaration wins — lets the outer document's
 *                 `aircraft:` stub entries $iref ids declared inside the
 *                 RuntimeData byte[] payload
 * @param {Set<number>} [danglingSet] old id values that are referenced but
 *                 never declared anywhere in the segment; their numbers are
 *                 reserved (never reused as a fresh $id) and a $iref to one is
 *                 preserved verbatim instead of throwing
 * @param {Array<Map<number,string>>} [scopeNames] per-scope `$type` id → name maps
 *                 collected from the ORIGINAL (pre-edit) text in depth-first
 *                 order (see collectScopeTypeNames). When present the renumberer
 *                 re-introduces the inline form of a `$type` registration whose
 *                 introducing object was deleted.
 * @param {{counter: number}} [state] shared counter indexing into scopeNames per
 *                 scope; incremented at each $blobdoc so nested namespaces resolve
 *                 to the right name map.
 * @returns {string} the document with $id/$iref renumbered (and, when scopeNames
 *                 is supplied, stale `$type` registrations re-introduced)
 */
function renumberDocument(text, scope, global, danglingSet, scopeNames, state) {
  if (!scope) scope = new Scope();
  if (!global) global = new Map();
  // Type-registration repair: `$type` ids are introduced inline by the FIRST
  // text occurrence of a type (`"$type": "<id>|<Name>"`); later occurrences use
  // a bare `"$type": <id>`. When the Ground Painter deletes that first object its
  // registration is lost and surviving objects' bare references become
  // unresolvable ("$type references unknown type id N"). `scopeNames` (collected
  // from the ORIGINAL, pre-edit text) lets us re-introduce the registration at
  // the first surviving reference. Each Odin document / $blobdoc is an
  // independent type namespace, so `introduced` resets per scope and `scopeNames`
  // is indexed per scope via the shared `state.counter`.
  if (scopeNames && !state) state = { counter: 0 };
  const namesMap = scopeNames ? (scopeNames[state.counter] || null) : null;
  const introduced = new Set();
  const n = text.length;
  let out = '';
  let chunkStart = 0;
  let i = 0;

  while (i < n) {
    const c = text[i];
    if (c === '"') {
      if (text.startsWith('"$id"', i)) {
        const m = /^"\$id"\s*:\s*(-?\d+)/.exec(text.slice(i));
        if (m) {
          const oldId = parseInt(m[1], 10);
          let newId = scope.nextId;
          // Reserve the values of dangling references so a preserved (never
          // declared) $iref value can never collide with a fresh $id.
          while (danglingSet && danglingSet.has(newId)) newId++;
          scope.nextId = newId + 1;
          scope.map.set(oldId, newId);
          if (!global.has(oldId)) global.set(oldId, newId);
          out += text.slice(chunkStart, i) + '"$id": ' + newId;
          i += m[0].length;
          chunkStart = i;
          continue;
        }
      } else if (text.startsWith('"$type"', i)) {
        const tm = /^"\$type"\s*:\s*("[^"]*"|-?\d+)/.exec(text.slice(i));
        if (tm) {
          const valueToken = tm[1];
          if (valueToken.charAt(0) === '"') {
            // Inline registration (or a full type name without id optimization).
            // A registration records the id→name so it CAN be re-introduced
            // later; keep the form verbatim.
            const inner = valueToken.slice(1, -1);
            const pipe = inner.indexOf('|');
            if (pipe >= 0) {
              const id = parseInt(inner.slice(0, pipe), 10);
              if (!isNaN(id)) {
                if (namesMap && !namesMap.has(id)) namesMap.set(id, inner.slice(pipe + 1));
                introduced.add(id);
              }
            }
            out += text.slice(chunkStart, i + tm[0].length);
            i += tm[0].length;
            chunkStart = i;
            continue;
          } else {
            // Bare `"$type": <id>` reference.
            const id = parseInt(valueToken, 10);
            if (introduced.has(id)) {
              // Already registered earlier in this scope — keep the bare form.
              out += text.slice(chunkStart, i + tm[0].length);
              i += tm[0].length;
              chunkStart = i;
              continue;
            }
            if (namesMap && namesMap.has(id)) {
              // Its registration object was deleted: re-introduce the inline
              // registration at the first surviving reference so the reader can
              // resolve this and every following bare reference to <id>.
              const name = namesMap.get(id);
              out += text.slice(chunkStart, i) + '"$type": "' + id + '|' + name + '"';
              introduced.add(id);
              i += tm[0].length;
              chunkStart = i;
              continue;
            }
            // Unknown id — no way to recover the name; preserve verbatim.
            out += text.slice(chunkStart, i + tm[0].length);
            i += tm[0].length;
            chunkStart = i;
            continue;
          }
        }
        i = skipString(text, i) + 1;
      } else if (text.startsWith('"$blobdoc"', i)) {
        const m = /^"\$blobdoc"\s*:\s*\{/.exec(text.slice(i));
        if (m) {
          const open = i + m[0].length - 1;
          let d = 0;
          let k = open;
          for (; k < n; k++) {
            const ck = text[k];
            if (ck === '"') {
              k = skipString(text, k) - 1;
            } else if (ck === '{') d++;
            else if (ck === '}') { d--; if (d === 0) break; }
          }
          // A $blobdoc value is its own document with its own id namespace AND
          // its own type registry, so it gets a FRESH Scope (ids restart at 1)
          // and a fresh type-introduction state while the segment-wide `global`
          // registry keeps cross-scope refs resolvable.
          if (scopeNames) state.counter++;
          out +=
            text.slice(chunkStart, open + 1) +
            renumberDocument(text.slice(open + 1, k), null, global, danglingSet, scopeNames, state);
          chunkStart = k;
          i = k + 1;
          continue;
        }
      }
      i = skipString(text, i) + 1;
    } else if (c === '$' && text.startsWith('$iref:', i)) {
      const m = /^-?\d+/.exec(text.slice(i + 6));
      if (m) {
        const oldId = parseInt(m[0], 10);
        const newId = scope.map.get(oldId) !== undefined
          ? scope.map.get(oldId)
          : global.get(oldId);
        if (newId === undefined) {
          // Dangling reference: target was never declared (its object was
          // deleted, yet a surviving shared sub-object still $irefs it).
          // Preserve the original value verbatim — it is reserved above so it
          // never collides with a fresh $id, and the game reads it as null.
          if (danglingSet && danglingSet.has(oldId)) {
            out += text.slice(chunkStart, i + 6) + oldId;
            i += 6 + m[0].length;
            chunkStart = i;
            continue;
          }
          // Also handle the "duplicate $id across scopes" case that triggers
          // the ZSJN_leisure_1 forward crash (e.g. $id 16, $id 772): the same
          // numeric value appears in different $blobdoc scopes, so the global
          // declared set makes a dangling $iref appear "declared" via a later
          // duplicate in another scope. Genuine forward $iref in the same scope
          // (test: $iref:99 before $id:99) should still be an error, but any
          // $iref whose target was deleted and whose $id now only appears in
          // another scope should be treated as dangling. For robustness, treat
          // *any* not-yet-declared $iref as dangling instead of crashing — the
          // game reads a dangling $iref as null, which is safe, while a crash
          // blocks the Ground Painter save entirely (user reports $iref:772).
          // Preserve the original value and reserve it.
          if (danglingSet) danglingSet.add(oldId);
          out += text.slice(chunkStart, i + 6) + oldId;
          i += 6 + m[0].length;
          chunkStart = i;
          continue;
        }
        out += text.slice(chunkStart, i + 6) + newId;
        i += 6 + m[0].length;
        chunkStart = i;
        continue;
      }
      i += 6;
    } else {
      i++;
    }
  }
  return out + text.slice(chunkStart);
}

/** Find the closing quote of the string literal that starts at `i`. */
function skipString(text, i) {
  const n = text.length;
  i++; // past the opening quote
  while (i < n) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i;
    i++;
  }
  return n;
}

/**
 * Split multi-segment text (FRAME_SENTINEL-separated documents) and renumber
 * each document independently — segments have independent id namespaces.
 *
 * @param {string} text full decoded .acl text (one or more documents)
 * @returns {string}
 */
function renumberAclIds(text, originalText) {
  const global = new Map();
  const parts = text.split(/\r?\n\$\$\$ GATCARC4 CHECKPOINT FRAME \$\$\$\r?\n/);
  const origParts = originalText ? originalText.split(/\r?\n\$\$\$ GATCARC4 CHECKPOINT FRAME \$\$\$\r?\n/) : null;
  // Pre-scan every segment for all declared $id values and all $iref targets
  // (blobdoc-aware). A $iref target that is never declared is a DANGLING
  // reference — it legitimately appears when the Ground Painter deletes an
  // entity whose $id is still referenced by a surviving shared sub-object. The
  // renumberer must preserve it (the game reads it as null) instead of throwing,
  // and must reserve its value so no fresh $id collides with it.
  const declared = new Set();
  const referenced = new Set();
  for (const p of parts) _collectIdRefs(p, declared, referenced);
  const dangling = new Set();
  for (const id of referenced) if (!declared.has(id)) dangling.add(id);
  return parts
    .map((p, idx) => {
      // When the painter deletes the object that introduced a `$type` id, the
      // surviving references are orphaned. Recover id→name from the ORIGINAL
      // (pre-edit) text for the matching segment so the renumberer can
      // re-introduce the inline registration at the first surviving reference.
      const scopeNames = origParts ? collectScopeTypeNames(origParts[idx] || '') : null;
      return renumberDocument(p, null, global, dangling, scopeNames, { counter: 0 });
    })
    .join('\r\n$$$ GATCARC4 CHECKPOINT FRAME $$$\r\n');
}

/**
 * Walk an Odin document, recursing into $blobdoc values, and collect a per-scope
 * `$type` id → name map for every type namespace it contains. Each document /
 * $blobdoc value is an independent type registry (the JSON reader resets its type
 * table at each $blobdoc), so each scope gets its own Map. Returns a flat array in
 * depth-first pre-order — index 0 is the outer document, then one entry per
 * $blobdoc in the order `renumberDocument` traverses them (its shared counter
 * indexes into this array). Used to recover the id→name of a `$type`
 * registration whose introducing object was deleted.
 * @param {string} text one document
 * @returns {Array<Map<number,string>>}
 */
function collectScopeTypeNames(text) {
  const scopes = [];
  const walk = (t) => {
    const names = new Map();
    scopes.push(names);
    const n = t.length;
    let i = 0;
    while (i < n) {
      const c = t[i];
      if (c === '"') {
        const tm = /^"\$type"\s*:\s*"([^"]*)"/.exec(t.slice(i));
        if (tm) {
          const inner = tm[1];
          const pipe = inner.indexOf('|');
          if (pipe >= 0) {
            const id = parseInt(inner.slice(0, pipe), 10);
            if (!isNaN(id) && !names.has(id)) names.set(id, inner.slice(pipe + 1));
          }
          i += tm[0].length;
          continue;
        }
        const b = /^"\$blobdoc"\s*:\s*\{/.exec(t.slice(i));
        if (b) {
          const open = i + b[0].length - 1;
          let d = 0;
          let k = open;
          for (; k < n; k++) {
            const ck = t[k];
            if (ck === '"') k = skipString(t, k) - 1;
            else if (ck === '{') d++;
            else if (ck === '}') { d--; if (d === 0) break; }
          }
          walk(t.slice(open + 1, k));
          i = k + 1;
          continue;
        }
        i = skipString(t, i) + 1;
      } else {
        i++;
      }
    }
  };
  walk(text);
  return scopes;
}

/**
 * Walk a document (recursing into $blobdoc values) collecting every `$id`
 * value declared and every `$iref` target referenced. Used to compute the
 * dangling-reference set for `renumberAclIds`.
 * @param {string} text one document
 * @param {Set<number>} declared out: every `$id` value seen
 * @param {Set<number>} referenced out: every `$iref` target seen
 */
function _collectIdRefs(text, declared, referenced) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const m = /^"\$id"\s*:\s*(-?\d+)/.exec(text.slice(i));
      if (m) {
        declared.add(parseInt(m[1], 10));
        i += m[0].length;
        continue;
      }
      const b = /^"\$blobdoc"\s*:\s*\{/.exec(text.slice(i));
      if (b) {
        const open = i + b[0].length - 1;
        let d = 0;
        let k = open;
        for (; k < n; k++) {
          const ck = text[k];
          if (ck === '"') k = skipString(text, k) - 1;
          else if (ck === '{') d++;
          else if (ck === '}') { d--; if (d === 0) break; }
        }
        _collectIdRefs(text.slice(open + 1, k), declared, referenced);
        i = k + 1;
        continue;
      }
      i = skipString(text, i) + 1;
    } else if (c === '$' && text.startsWith('$iref:', i)) {
      const m = /^-?\d+/.exec(text.slice(i + 6));
      if (m) {
        referenced.add(parseInt(m[0], 10));
        i += 6 + m[0].length;
        continue;
      }
      i += 6;
    } else {
      i++;
    }
  }
}

/**
 * Diagnostics: count non-monotonic (descending) $id steps within each
 * document scope (blobdoc-aware).  Healthy game files score 0.
 *
 * @param {string} text one Odin document
 * @returns {{ violations: number, dups: number, max: number }}
 */
function countIdDescents(text) {
  const stats = { violations: 0, dups: 0, max: -Infinity };
  const n = text.length;
  let i = 0;
  let last = -Infinity;
  const seen = new Set();
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const m = /^"\$id"\s*:\s*(-?\d+)/.exec(text.slice(i));
      if (m) {
        const v = parseInt(m[1], 10);
        if (v < last) stats.violations++;
        if (seen.has(v)) stats.dups++;
        seen.add(v);
        if (v > stats.max) stats.max = v;
        last = v;
        i += m[0].length;
        continue;
      }
      const b = /^"\$blobdoc"\s*:\s*\{/.exec(text.slice(i));
      if (b) {
        const open = i + b[0].length - 1;
        let d = 0;
        let k = open;
        for (; k < n; k++) {
          const ck = text[k];
          if (ck === '"') k = skipString(text, k) - 1;
          else if (ck === '{') d++;
          else if (ck === '}') { d--; if (d === 0) break; }
        }
        const inner = countIdDescents(text.slice(open + 1, k));
        stats.violations += inner.violations;
        stats.dups += inner.dups;
        if (inner.max > stats.max) stats.max = inner.max;
        i = k + 1;
        continue;
      }
      i = skipString(text, i) + 1;
    } else {
      i++;
    }
  }
  return stats;
}

module.exports = { renumberDocument, renumberAclIds, collectScopeTypeNames, countIdDescents };