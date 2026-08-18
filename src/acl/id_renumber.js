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
 * A $iref whose target has not been declared yet (forward reference)
 * throws — healthy files never contain one.
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
 * @returns {string} the document with $id/$iref renumbered
 */
function renumberDocument(text, scope, global) {
  if (!scope) scope = new Scope();
  if (!global) global = new Map();
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
          const newId = scope.nextId++;
          scope.map.set(oldId, newId);
          if (!global.has(oldId)) global.set(oldId, newId);
          out += text.slice(chunkStart, i) + '"$id": ' + newId;
          i += m[0].length;
          chunkStart = i;
          continue;
        }
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
          // A $blobdoc value is its own document with its own id namespace,
          // so the content gets a FRESH Scope (ids restart at 1) while the
          // segment-wide `global` registry keeps cross-scope refs resolvable.
          out +=
            text.slice(chunkStart, open + 1) +
            renumberDocument(text.slice(open + 1, k), null, global);
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
          throw new Error(
            'id_renumber: forward $iref:' + oldId + ' at offset ' + i +
            ' (target $id not declared yet) — unsupported reference layout'
          );
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
function renumberAclIds(text) {
  const global = new Map();
  const parts = text.split(/\r?\n\$\$\$ GATCARC4 CHECKPOINT FRAME \$\$\$\r?\n/);
  return parts
    .map((p) => renumberDocument(p, null, global))
    .join('\r\n$$$ GATCARC4 CHECKPOINT FRAME $$$\r\n');
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

module.exports = { renumberDocument, renumberAclIds, countIdDescents };