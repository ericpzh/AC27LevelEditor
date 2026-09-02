/**
 * SceneryWriter — Graph → ACL text (id-free variant).
 *
 * `patchSceneryBlob(snapshotText, graph, blobTypeMap, meta)` mutates the two
 * static-entity arrays (`PKStaticEntities.$rcontent`, `NonPKStaticEntities.$rcontent`)
 * in an Odin text WITHOUT touching any other section (flights, metadata, runtime).
 *
 * Lossless strategy (satisfies the §7.1 no-touch invariant):
 *   - every surviving entity keeps its ORIGINAL raw block verbatim, so
 *     sub-fields the Graph does not model (runway `Routes`/`Entries`/
 *     `HoldingAreas`, stand `TaxiwayNode[]`, etc.) are preserved byte-for-byte;
 *   - only entities that are genuinely removed are dropped; only genuinely new
 *     entities are synthesized and appended.
 *
 * Id allocation is centralized here (survivor → reuse original `$id`, new →
 * allocate fresh, see §4.3). Final `$id`/`$iref` renumbering is done by
 * `writeAcl` → `renumberAclIds`, never here (double-renumber would corrupt).
 */

const path = require('path');
const { createTokenizer } = require('./tokenizer');
const { extractVector3FromV4, extractIrefArray, extractIntFromV4 } = require('./v4_pk_index');

// ─── Taxiway OSM pool (finite reuse) ───────────────────────────────────
// The game only knows a fixed set of OsmIds per level (those that existed in
// the original ACL). New taxiway nodes/segments must REUSE a freed OsmId
// from that pool — we never mint fresh negative ids any more. The pool is
// derived from the original snapshot's PK entries; free = pool \ survivors.
// Nodes: each OsmId is unique (1:1 with PK), so Set is sufficient.
// Segments: a single OsmId may own many PK entries (taxiway-segment:<osm>:<ord>),
// so we keep BOTH a unique Set (for allocation) and a per-entry multiset
// (for user-visible remaining count — deleting any single straight piece frees one).
function _taxiwayOsmPoolsFromEntries(pkEntries) {
  const nodePool = new Set();
  const segPool = new Set();
  const segPoolEntries = []; // per-entry list with duplicates, for display/limit
  for (const e of pkEntries || []) {
    const type = _entryTypePrefix(e);
    if (type === 'taxiway-node') {
      const osm = _entryOsm(e);
      if (osm != null) nodePool.add(osm);
    } else if (type === 'taxiway-segment') {
      const osm = _entryOsm(e);
      if (osm != null) {
        segPool.add(osm);
        segPoolEntries.push(osm);
      }
    }
  }
  return { nodePool, segPool, segPoolEntries };
}

function _parseOsmFromNodePk(pk) {
  const m = /^taxiway-node:(-?\d+)$/.exec(pk);
  return m ? parseInt(m[1], 10) : null;
}
function _parseOsmFromSegPk(pk) {
  const m = /^taxiway-segment:(-?\d+):\d+$/.exec(pk);
  return m ? parseInt(m[1], 10) : null;
}

function getTaxiwayOsmPoolInfo(pkEntries, graph, meta) {
  const { nodePool, segPool, segPoolEntries } = _taxiwayOsmPoolsFromEntries(pkEntries);
  const deletedSet = new Set((meta && meta.deletedPks) || []);
  const survivorNodeOsm = new Set();
  const survivorSegOsm = new Set();
  // Per-entry survivor counts for display (any straight piece deletion frees one)
  const survivorSegEntries = [];
  if (graph && meta) {
    for (let i = 0; i < (graph.nodes || []).length; i++) {
      const pk = meta.nodeOrigPk ? meta.nodeOrigPk[i] : null;
      if (pk != null && !deletedSet.has(pk)) {
        const osm = _parseOsmFromNodePk(pk);
        if (osm != null) survivorNodeOsm.add(osm);
      }
    }
    for (let i = 0; i < (graph.segments || []).length; i++) {
      const pk = meta.segOrigPk ? meta.segOrigPk[i] : null;
      if (pk != null && !deletedSet.has(pk)) {
        const osm = _parseOsmFromSegPk(pk);
        if (osm != null) {
          survivorSegOsm.add(osm);
          survivorSegEntries.push(osm);
        }
      }
    }
  }
  const freeNodeIds = [...nodePool].filter((id) => !survivorNodeOsm.has(id)).sort((a, b) => a - b);
  const freeSegIds = [...segPool].filter((id) => !survivorSegOsm.has(id)).sort((a, b) => a - b);
  // Per-entry free: total entries - surviving entries - pending new segs
  const totalSegEntries = segPoolEntries.length;
  const pendingNewSegs = (graph && meta) ? (graph.segments || []).filter((_, i) => meta?.segOrigPk?.[i] == null).length : 0;
  const pendingNewNodes = (graph && meta) ? (graph.nodes || []).filter((_, i) => meta?.nodeOrigPk?.[i] == null).length : 0;
  const freeSegEntryCount = Math.max(0, totalSegEntries - survivorSegEntries.length - pendingNewSegs);
  const freeNodeEntryCount = Math.max(0, freeNodeIds.length - pendingNewNodes); // nodes are unique, same as unique
  // For allocation we still need unique free list; for display/limit we use per-entry
  // Build per-entry free list (multiset difference) for allocation when per-entry is desired:
  // Count per OsmId in pool vs survivors
  const poolSegCountByOsm = new Map();
  for (const osm of segPoolEntries) poolSegCountByOsm.set(osm, (poolSegCountByOsm.get(osm) || 0) + 1);
  const survSegCountByOsm = new Map();
  for (const osm of survivorSegEntries) survSegCountByOsm.set(osm, (survSegCountByOsm.get(osm) || 0) + 1);
  const freeSegEntryIds = [];
  for (const [osm, cnt] of poolSegCountByOsm) {
    const surv = survSegCountByOsm.get(osm) || 0;
    const free = cnt - surv;
    for (let i = 0; i < free; i++) freeSegEntryIds.push(osm);
  }
  freeSegEntryIds.sort((a, b) => a - b);
  return {
    nodePool, segPool, segPoolEntries,
    survivorNodeOsm, survivorSegOsm, survivorSegEntries,
    freeNodeIds, freeSegIds, freeSegEntryIds,
    nodePoolSize: nodePool.size,
    segPoolSize: segPool.size,
    segEntriesTotal: totalSegEntries,
    freeNodeCount: freeNodeIds.length,
    freeSegCount: freeSegIds.length, // unique
    freeSegEntryCount,
    freeNodeEntryCount,
    pendingNewNodes, pendingNewSegs,
  };
}

// Public helper for UI / tests: derive pool sizes from a raw ACL text.
function extractTaxiwayOsmPool(text) {
  if (!text) return { nodeIds: [], segIds: [], segEntries: [] };
  const ranges = _staticEntitiesRanges(text);
  if (!ranges) return { nodeIds: [], segIds: [], segEntries: [] };
  const pkArrayValue = text.substring(ranges.pkRc.start, ranges.pkRc.end);
  const pkEntries = _splitArrayEntries(pkArrayValue);
  const { nodePool, segPool, segPoolEntries } = _taxiwayOsmPoolsFromEntries(pkEntries);
  return {
    nodeIds: [...nodePool].sort((a, b) => a - b),
    segIds: [...segPool].sort((a, b) => a - b),
    segEntries: [...segPoolEntries].sort((a, b) => a - b),
    segEntriesTotal: segPoolEntries.length,
  };
}

// Managed PK type prefixes the painter may add/remove. Everything else
// (airway-node, airway-segment, taxi-navigation, physical-runway, jetway) is
// preserved verbatim unless a dedicated reconciliation removes it.
const MANAGED_PK_TYPES = new Set(['taxiway-node', 'taxiway-segment', 'runway', 'stand']);

// ─── Absolute section navigation (tokenizer is offset-relative) ──

function _childAbs(text, parentAbs, key) {
  const slice = text.substring(parentAbs.start, parentAbs.end);
  const st = createTokenizer(slice);
  const sec = st.findSection(key);
  if (!sec) return null;
  return { start: parentAbs.start + sec.valueStart, end: parentAbs.start + sec.valueEnd };
}

function _rootAbs(text, key) {
  const st = createTokenizer(text);
  const sec = st.findSection(key);
  if (!sec) return null;
  return { start: sec.valueStart, end: sec.valueEnd };
}

// Direct-child value finder: locate `"key": value` at brace-depth 1 within the
// object at [objStart, objEnd). Unlike findSection (which finds the FIRST `"key"`
// anywhere, matching nested ones like a runway's `Routes.$rlength`), this only
// matches the key as a direct property of the object.
function _depthValueAbs(text, objStart, objEnd, key) {
  const search = '"' + key + '"';
  let depth = 0;
  for (let i = objStart; i < objEnd; i++) {
    const c = text[i];
    if (depth === 1 && text.startsWith(search, i)) {
      const colon = text.indexOf(':', i + search.length);
      if (colon < 0 || colon >= objEnd) return null;
      let vs = colon + 1;
      while (vs < objEnd && ' \t\n\r'.includes(text[vs])) vs++;
      let ve = vs;
      while (ve < objEnd && !',}\r\n]'.includes(text[ve])) ve++;
      return { valueStart: vs, valueEnd: ve };
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '"') {
      const end = _skipStr(text, i);
      if (end > i) i = end - 1;
    }
  }
  return null;
}

function _skipStr(text, i) {
  const n = text.length;
  i++;
  while (i < n) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '"') return i + 1;
    i++;
  }
  return n;
}

function _staticEntitiesRanges(text) {
  const sd = _rootAbs(text, 'StaticData');
  if (!sd) return null;
  const bd = _childAbs(text, sd, '$blobdoc');
  if (!bd) return null;

  const pk = _childAbs(text, bd, 'PKStaticEntities');
  const npk = _childAbs(text, bd, 'NonPKStaticEntities');
  if (!pk || !npk) return null;

  const pkLen = _depthValueAbs(text, pk.start, pk.end, '$rlength');
  const pkRc = _childAbs(text, pk, '$rcontent');
  const npkLen = _depthValueAbs(text, npk.start, npk.end, '$rlength');
  const npkRc = _childAbs(text, npk, '$rcontent');
  if (!pkLen || !pkRc || !npkLen || !npkRc) return null;

  // StaticItems holds the physical-runway registry (physical-runway:XX/YY → $iref) plus jetways.
  // It lives alongside PKStaticEntities under the same $blobdoc.
  const si = _childAbs(text, bd, 'StaticItems');
  let siLen = null, siRc = null;
  if (si) {
    siLen = _depthValueAbs(text, si.start, si.end, '$rlength');
    siRc = _childAbs(text, si, '$rcontent');
  }
  return { pkLen, pkRc, npkLen, npkRc, siLen, siRc };
}

// ─── Array entry splitting ────────────────────────────────────────

/**
 * Split an array value (text `[ ... ]`) into its top-level object entry blocks.
 * Returns array of raw entry strings (each `{...}`), preserving nothing else.
 */
function _splitArrayEntries(arrayValue) {
  const open = arrayValue.indexOf('[');
  const close = arrayValue.lastIndexOf(']');
  if (open < 0 || close <= open) return [];
  const inner = arrayValue.substring(open + 1, close);
  const t = createTokenizer(inner);
  const entries = [];
  let pos = 0;
  while (pos < inner.length) {
    while (pos < inner.length && ' \t\n\r,'.includes(inner[pos])) pos++;
    if (pos >= inner.length) break;
    if (inner[pos] !== '{') { pos++; continue; }
    const end = t.findObjectEnd(pos);
    if (!end) break;
    entries.push(inner.substring(pos, end));
    pos = end;
  }
  return entries;
}

function _entryPk(entry) {
  const t = createTokenizer(entry);
  const sec = t.findSection('$k');
  if (!sec) return null;
  const v = t.substring(sec.valueStart, sec.valueEnd).trim();
  return v.startsWith('"') ? v.slice(1, -1) : v;
}

function _entryId(entry) {
  const t = createTokenizer(entry);
  const sec = t.findSection('$id');
  if (!sec) return null;
  const v = t.substring(sec.valueStart, sec.valueEnd).trim();
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

// Extract a taxiway entity's OsmId (the trailing integer in its `taxiway-node:N`
// / `taxiway-segment:N:ord` $k, echoed in the `OsmId` field inside `$v`).
function _entryOsm(entry) {
  const m = /"OsmId"\s*:\s*(-?\d+)/.exec(entry);
  return m ? parseInt(m[1], 10) : null;
}

// Minimum taxiway OsmId present across a set of PK entries (nodes + segments),
// or 0 when nothing negative exists. Used by _synthesizeNew to carve out a
// collision-free fresh-negative OsmId namespace.
function _minTaxiwayOsm(pkEntries) {
  let min = 0;
  for (const e of pkEntries || []) {
    const type = _entryTypePrefix(e);
    if (type !== 'taxiway-node' && type !== 'taxiway-segment') continue;
    const os = _entryOsm(e);
    if (os != null && os < min) min = os;
  }
  return min;
}

// Every `$id` value declared inside a raw entry block (top-level `$id` plus the
// nested wrapper ids such as a stand's PushbackLimitPositions).
function _idsInBlock(entry) {
  const ids = new Set();
  const re = /"\$id"\s*:\s*(-?\d+)/g;
  let m;
  while ((m = re.exec(entry)) !== null) ids.add(parseInt(m[1], 10));
  return ids;
}

// True when any `$iref` inside `entry` targets one of `deletedIds`. The
// non-digit lookahead keeps 8667 from matching a longer id like 86670.
function _referencesDeleted(entry, deletedIds) {
  if (!deletedIds || deletedIds.size === 0) return false;
  for (const id of deletedIds) {
    if (new RegExp('\\$iref:' + id + '(?!\\d)').test(entry)) return true;
  }
  return false;
}

// Delete-cascade fixed point (§4.1 item 3): a deleted stand/taxiway/runway also
// drops its `jetway:*` entries (StaticItems) that `$iref` a now-dead id, so a
// jetway does not outlive the stand it serves. We repeat until stable because a
// dropped jetway can itself be referenced by a runtime list (its own id then
// becoming dead too). taxi-navigation entries are deliberately left in place —
// though a nav node can `$iref` a deleted stand, dropping it would also remove
// the shared sub-objects it declares (e.g. an empty CrossTaxiwayNames String[]
// reused airport-wide), which cascades into nuking the whole nav graph. Those
// single remaining references are preserved by `renumberAclIds` (see the
// dangling-reference handling there). Returns the filtered arrays plus a
// drop-count tally.
// Updated per user request "any deleted item should have fully clear iref":
// taxi-navigation entries that $iref a deleted entity are now dropped as well
// (except the single declarer of the shared CrossTaxiwayNames array, which is
// kept and rewired by the gate instead of being deleted).
function _cascadeOrphanEntries(pkEntries, siEntries, deadIds) {
  const drop = { jetway: 0, taxiNavigation: 0 };
  let changed = true;
  while (changed) {
    changed = false;
    // PK: drop orphaned taxi-navigation (stand / pushback) that reference a deleted id
    const newPkEntries = [];
    for (const e of pkEntries) {
      if (_entryTypePrefix(e) === 'taxi-navigation' && _referencesDeleted(e, deadIds)) {
        const isDeclarer = e.includes('"CrossTaxiwayNames": { "$id":');
        if (isDeclarer) {
          // Keep the declarer — its shared array is $iref'd by every other nav point.
          // The gate will rewire its Reference instead of dropping it.
          newPkEntries.push(e);
          continue;
        }
        for (const id of _idsInBlock(e)) deadIds.add(id);
        drop.taxiNavigation++;
        changed = true;
        continue;
      }
      newPkEntries.push(e);
    }
    if (newPkEntries.length !== pkEntries.length) {
      pkEntries = newPkEntries;
      changed = true;
    } else {
      pkEntries = newPkEntries;
    }
    const siOut = [];
    for (const e of siEntries) {
      if (_entryTypePrefix(e) === 'jetway' && _referencesDeleted(e, deadIds)) {
        for (const id of _idsInBlock(e)) deadIds.add(id);
        drop.jetway++;
        changed = true;
        continue;
      }
      siOut.push(e);
    }
    siEntries = siOut;
  }
  return { pkEntries, siEntries, drop };
}

// ─── Survivor dangling-$iref gate ─────────────────────────────────
// When this patch deletes taxiway nodes, every SURVIVOR entry that still
// $irefs one of them serializes a reference the game resolves to null —
// TaxiwaySegment2DFactory dereferences it and crashes level init
// (ZSJN_leisure_1: $iref:2004 / $iref:2040). Survivor entries are copied
// verbatim, so unlike new entities (whose node refs are null-filtered at
// synthesis) nothing else repairs them.
//
// Repair order per dead reference:
//   1. rewire to a LIVE taxiway-node at the deleted node's coordinate —
//      co-located junction twins are geometrically identical;
//   2. excise the dead reference from the entry's $rcontent list, when enough
//      refs remain (a polyline needs both ends);
//   3. drop the whole entry (a dropped stand cascades its jetways, because
//      its ids join `deletedIds` before the jetway cascade runs).
//
// Runs BEFORE _cascadeOrphanEntries. Mutates pkEntries (patched strings),
// pkDelete (gate-dropped entries) and deletedIds (ids of gate-dropped
// entries). Returns true when it changed anything — the caller must then skip
// the lossless no-op path so the repairs actually persist.
function _gateSurvivorDanglingRefs(pkEntries, pkDelete, deletedIds, warnings, droppedRunwayPhys) {
  const deletedSet = new Set(pkDelete);
  // Deleted taxiway-node $id -> coordinate (the rewire source of truth).
  const deadNodeCoord = new Map();
  for (const e of pkDelete) {
    if (_entryTypePrefix(e) !== 'taxiway-node') continue;
    const id = _entryId(e);
    const pos = extractVector3FromV4(e);
    if (id != null && pos) deadNodeCoord.set(id, pos);
  }
  if (deadNodeCoord.size === 0) return false;

  // Live taxiway-node coordinate -> $id (first wins), skipping deleted entries.
  const liveIdByCoord = new Map();
  for (const e of pkEntries) {
    if (deletedSet.has(e)) continue;
    if (_entryTypePrefix(e) !== 'taxiway-node') continue;
    const id = _entryId(e);
    const pos = extractVector3FromV4(e);
    if (id == null || !pos) continue;
    const key = _coordKey(pos.x, pos.z);
    if (!liveIdByCoord.has(key)) liveIdByCoord.set(key, id);
  }

  // Warnings are structured { key, params, text }: the writer runs in the
  // Electron main process where no translation context exists, so `key` +
  // `params` drive the renderer-side i18n translation and `text` is the
  // plain-English rendering for console logs (and as a display fallback).
  const warn = (w) => { console.warn('[scenery_write] ' + w.text); if (warnings) warnings.push(w); };
  let dirty = false;

  for (let i = 0; i < pkEntries.length; i++) {
    let entry = pkEntries[i];
    if (deletedSet.has(entry)) continue;
    const prefix = _entryTypePrefix(entry);
    // `runway` is included so a survivor runway whose ThresholdPoints reference
    // a deleted node is rewired to a live twin (or dropped) — left dangling it
    // makes the game (and this editor's reader) drop the runway silently,
    // orphaning its pavement strips.
    if (prefix !== 'taxiway-segment' && prefix !== 'stand' && prefix !== 'taxi-navigation' && prefix !== 'runway') continue;

    // Dead node ids this entry still references (deduped, first-seen order).
    const deadRefs = [];
    for (const m of entry.matchAll(/\$iref:\s*(\d+)/g)) {
      const id = parseInt(m[1], 10);
      if (deadNodeCoord.has(id) && !deadRefs.includes(id)) deadRefs.push(id);
    }
    if (deadRefs.length === 0) continue;
    const pk = _entryPk(entry);

    // 1) Rewire every dead ref that has a live coordinate twin.
    let repaired = 0;
    const unrepairable = [];
    for (const d of deadRefs) {
      const pos = deadNodeCoord.get(d);
      const twin = liveIdByCoord.get(_coordKey(pos.x, pos.z));
      if (twin != null && twin !== d) {
        entry = entry.replace(new RegExp('\\$iref:' + d + '(?!\\d)', 'g'), () => '$iref:' + twin);
        repaired++;
      } else {
        unrepairable.push(d);
      }
    }

    // 2) Excise unrepairable refs from the entry's $rcontent list when enough
    //    refs remain. Refs that are bare properties (a stand's NosePosition /
    //    TailPosition) cannot be excised — _exciseIrefFromRcontent returns
    //    null for them and the entry falls through to the drop path.
    //    Runways never excise: a ThresholdPoints list must keep both ends, an
    //    one-threshold runway is invalid — an unrepairable threshold drops the
    //    runway entry instead.
    let excised = 0;
    const totalRefs = (entry.match(/\$iref:\s*\d+/g) || []).length;
    const remaining = [];
    if (unrepairable.length > 0 && prefix !== 'runway' && totalRefs - unrepairable.length >= 2) {
      for (const d of unrepairable) {
        const out = _exciseIrefFromRcontent(entry, d);
        if (out != null) { entry = out; excised++; } else remaining.push(d);
      }
    } else {
      remaining.push(...unrepairable);
    }

    // A rewire must not collapse a polyline onto a single node (a degenerate
    // self-loop the game's edge validator refuses): force the drop path when
    // every reference would point at the same node.
    let degenerate = false;
    if ((repaired > 0 || excised > 0) && prefix === 'taxiway-segment') {
      const nodesKey = entry.indexOf('"Nodes"');
      const rcKey = nodesKey >= 0 ? entry.indexOf('"$rcontent"', nodesKey) : -1;
      if (rcKey >= 0) {
        const open = entry.indexOf('[', rcKey);
        const close = entry.indexOf(']', open);
        const refs = [...entry.slice(open + 1, close).matchAll(/\$iref:\s*(\d+)/g)].map((m) => m[1]);
        if (refs.length > 0 && new Set(refs).size < 2) degenerate = true;
      }
    }

    // 3) Whatever could not be repaired drops the whole entry.
    // Taxi-navigation declarer of the shared CrossTaxiwayNames array (first nav point)
    // must not be dropped — its "$id": 8735 is $iref'd by every other nav point.
    // Keep it and rewire its Reference to any live node instead.
    if ((remaining.length > 0 || degenerate) && prefix === 'taxi-navigation' && entry.includes('"CrossTaxiwayNames": { "$id":')) {
      let fallback = null;
      for (const v of liveIdByCoord.values()) { fallback = v; break; }
      if (fallback != null && remaining.length > 0 && !degenerate) {
        for (const dead of remaining) {
          entry = entry.replace(new RegExp('\\$iref:' + dead + '(?!\\d)', 'g'), () => '$iref:' + fallback);
        }
        pkEntries[i] = entry;
        // Silent for taxi-navigation declarer — auto-fixed without popup
        console.warn('[scenery_write] repaired ' + pk + ' — rewired ' + remaining.length + ' deleted-node reference(s) to live node(s) at the same coordinate');
        dirty = true;
        continue;
      }
      // No fallback live node — preserve declarer, let final validation handle silently
      // (do not drop, do not add its shared id to dead set)
      if (fallback == null) {
        continue;
      }
    }
    if (remaining.length > 0 || degenerate) {
      pkDelete.push(entry);
      // A dropped runway takes its pavement strips with it (taxiway-segment
      // entries named after the physical runway) — otherwise they survive as
      // orphan paint no runway claims.
      if (prefix === 'runway') {
        const physM = entry.match(/"PhysicalRunwayStaticItem"[\s\S]{0,500}?"PhysicalName"\s*:\s*"([^"]+)"/) ||
          entry.match(/"PhysicalName"\s*:\s*"([^"]+)"/);
        const physName = physM ? physM[1] : null;
        if (physName) {
          if (droppedRunwayPhys) droppedRunwayPhys.add(physName);
          for (const segEntry of pkEntries) {
            if (deletedSet.has(segEntry) || pkDelete.includes(segEntry)) continue;
            if (_entryTypePrefix(segEntry) !== 'taxiway-segment') continue;
            const nm = segEntry.match(/"Name"\s*:\s*"([^"]*)"/);
            if (nm && nm[1] === physName) pkDelete.push(segEntry);
          }
        }
      }
      let idsToDead = [..._idsInBlock(entry)];
      // Preserve shared CrossTaxiwayNames declaration when dropping a declarer
      if (prefix === 'taxi-navigation' && entry.includes('"CrossTaxiwayNames": { "$id":')) {
        const crossM = entry.match(/"CrossTaxiwayNames":\s*\{\s*"\$id":\s*(\d+)/);
        if (crossM) {
          const sharedId = parseInt(crossM[1], 10);
          idsToDead = idsToDead.filter(id => id !== sharedId);
        }
      }
      for (const id of idsToDead) deletedIds.add(id);
      if (degenerate) {
        const msg = 'dropped ' + pk + ' — rewiring its deleted-node reference(s) would collapse it onto a single node';
        if (prefix === 'taxi-navigation') console.warn('[scenery_write] ' + msg);
        else warn({ key: 'ground_painter_writer_gate_dropped_collapse', params: { pk }, text: msg });
      } else {
        const msg = 'dropped ' + pk + ' — referenced deleted node(s) ' + remaining.join(', ') + ' with no repairable replacement';
        if (prefix === 'taxi-navigation') console.warn('[scenery_write] ' + msg);
        else warn({ key: 'ground_painter_writer_gate_dropped_unrepairable', params: { pk, ids: remaining.join(', ') }, text: msg });
      }
      dirty = true;
      continue;
    }
    if (repaired > 0 || excised > 0) {
      pkEntries[i] = entry;
      if (repaired) {
        if (prefix === 'taxi-navigation') console.warn('[scenery_write] repaired ' + pk + ' — rewired ' + repaired + ' deleted-node reference(s) to live node(s) at the same coordinate');
        else warn({ key: 'ground_painter_writer_gate_rewired', params: { pk, count: repaired }, text: 'repaired ' + pk + ' — rewired ' + repaired + ' deleted-node reference(s) to live node(s) at the same coordinate' });
      }
      if (excised) {
        if (prefix === 'taxi-navigation') console.warn('[scenery_write] repaired ' + pk + ' — excised ' + excised + ' deleted-node reference(s) from its node list');
        else warn({ key: 'ground_painter_writer_gate_excised', params: { pk, count: excised }, text: 'repaired ' + pk + ' — excised ' + excised + ' deleted-node reference(s) from its node list' });
      }
      dirty = true;
    }
  }
  return dirty;
}

/**
 * Remove one `$iref:<deadId>` from an entry's `$rcontent` ref list and
 * decrement the `$rlength` that declares the list's length. Returns the
 * patched entry, or null when no $rcontent list in the entry contains the ref
 * (e.g. a stand's NosePosition — a bare property, not a list member).
 */
function _exciseIrefFromRcontent(entry, deadId) {
  const trailingRe = new RegExp('[\\s]*\\$iref:' + deadId + '(?!\\d)\\s*,');
  const leadingRe = new RegExp(',\\s*\\$iref:' + deadId + '(?!\\d)\\s*');
  let searchFrom = 0;
  for (;;) {
    const rcKey = entry.indexOf('"$rcontent"', searchFrom);
    if (rcKey < 0) return null;
    const open = entry.indexOf('[', rcKey);
    const close = entry.indexOf(']', open);
    if (open < 0 || close < 0) return null;
    const span = entry.slice(open + 1, close);
    if (!new RegExp('\\$iref:' + deadId + '(?!\\d)').test(span)) {
      searchFrom = close + 1;
      continue;
    }
    let spanOut;
    if (trailingRe.test(span)) spanOut = span.replace(trailingRe, '');
    else if (leadingRe.test(span)) spanOut = span.replace(leadingRe, '');
    else return null;
    if (new RegExp('\\$iref:' + deadId + '(?!\\d)').test(spanOut)) return null; // duplicated ref — bail to drop path
    // The $rlength declaring THIS list's length is the last one before the
    // "$rcontent" key (the list object serializes as
    // {..., "$rlength": N, "$rcontent": [...]}).
    const head = entry.slice(0, rcKey);
    let last = null;
    for (const r of head.matchAll(/("\$rlength":\s*)(\d+)/g)) last = r;
    if (!last) return null;
    const n = parseInt(last[2], 10);
    if (!(n > 0)) return null;
    return entry.slice(0, last.index) + last[1] + String(n - 1) +
      entry.slice(last.index + last[0].length, open + 1) +
      spanOut +
      entry.slice(close);
  }
}

// Collect every `$id` declared in `text` into `out` (flat, all scopes — the
// same merged semantics the renumberer's pre-scan uses).
function _collectDeclaredIds(text, out) {
  for (const m of text.matchAll(/"\$id":\s*(-?\d+)/g)) out.add(parseInt(m[1], 10));
}

// The document minus the three managed list bodies: everything whose ids this
// writer never touches (nav graph, runtime data, airways, checkpoint frame).
// Those sections legally declare ids that PK entries may reference.
function _textOutsideListSpans(snapshotText, ranges) {
  const spans = [ranges.pkRc, ranges.npkRc, ranges.siRc].filter(Boolean).sort((a, b) => b.start - a.start);
  let rest = snapshotText;
  for (const s of spans) rest = rest.slice(0, s.start) + rest.slice(s.end);
  return rest;
}

// Crash-class dangling count: `$iref`s from taxiway-segment / stand entries
// that no declared id satisfies — the game null-derefs these on level init.
function _countCrashClassDangling(entries, declared) {
  let n = 0;
  for (const e of entries) {
    const prefix = _entryTypePrefix(e);
    if (prefix !== 'taxiway-segment' && prefix !== 'stand') continue;
    for (const m of e.matchAll(/\$iref:\s*(\d+)/g)) {
      if (!declared.has(parseInt(m[1], 10))) n++;
    }
  }
  return n;
}

function _hasNull(arr) {
  return Array.isArray(arr) && arr.some((v) => v == null);
}

// True when a graph array has grown past its parallel meta array (appended new
// objects that the painter did not reflect in meta). Used to gate the no-op
// early return so newly-drawn geometry is synthesized instead of dropped.
function _arrayLongerThan(metaArr, graphArr) {
  return Array.isArray(metaArr) && Array.isArray(graphArr) && graphArr.length > metaArr.length;
}

function _entryTypePrefix(entry) {
  const pk = _entryPk(entry);
  if (!pk) return null;
  const ci = pk.indexOf(':');
  return ci >= 0 ? pk.substring(0, ci) : pk;
}

// ─── Canonical PK type regroup ────────────────────────────────────
// The game serializes `PKStaticEntities.$rcontent` as a dictionary whose entries
// are grouped by entity type in a fixed order (verified against the shipped
// `.acl`: taxiway-node, taxiway-segment, airway-node, airway-segment, runway,
// stand, taxi-navigation). The rebuild path keeps survivors in their original
// position and APPENDS synthesized objects at the tail of the array, which would
// drop a newly-drawn taxiway-node AFTER every taxi-navigation entry — breaking
// the grouping the game's reader assumes. `_regroupPkByType` restores the
// source file's type-group order so added objects land inside their type's block.
//
// Only the GROUPING is restored here — the within-group relative order is
// preserved verbatim. That matters twice: (1) `buildSceneryGraph` maps a node's
// array position to its graph index and the `meta` side-tables are index-parallel,
// so appending a new node at the END of its type block keeps every original
// node's index stable across a re-parse; (2) `runway` / `stand` /
// `taxi-navigation` blocks are NOT key-ordered in the file, so their original
// order must be kept. New members simply append to their type's block.
const PK_TYPE_ORDER = ['taxiway-node', 'taxiway-segment', 'airway-node', 'airway-segment', 'runway', 'stand', 'taxi-navigation'];

// The canonical type-group order for a snapshot's PK array: the source file's
// first-appearance order, padded with the canonical defaults so a type absent
// from the file (e.g. a brand-new runway in a runway-less level) still gets a
// deterministic slot instead of the tail.
function _pkTypeOrder(sourceEntries) {
  const seen = [];
  for (const e of sourceEntries || []) {
    const p = _entryTypePrefix(e);
    if (!p || seen.includes(p)) continue;
    seen.push(p);
  }
  for (const c of PK_TYPE_ORDER) if (!seen.includes(c)) seen.push(c);
  return seen;
}

// Bucket `entries` by type prefix and concatenate in `typeOrder` order, keeping
// each bucket's relative order intact (stable). Types absent from `typeOrder` (a
// synthesized type the source never declared) append at the end in first-seen
// order.
function _regroupPkByType(entries, typeOrder) {
  const buckets = new Map();
  const known = new Set(typeOrder);
  const tail = [];
  for (const e of entries) {
    const p = _entryTypePrefix(e) || '';
    if (!buckets.has(p)) {
      buckets.set(p, []);
      if (!known.has(p)) tail.push(p);
    }
    buckets.get(p).push(e);
  }
  const out = [];
  for (const p of typeOrder) { const b = buckets.get(p); if (b) out.push(...b); }
  for (const p of tail) { const b = buckets.get(p); if (b) out.push(...b); }
  return out;
}

// Extract the set of `physical-runway:*` $k keys from an array of entry strings.
// Used to build the set of static physical-runway keys that legitimately exist,
// which the checkpoint-frame reconciliation validates stale runtime entities
// against.
function _physKeysFromEntries(entries) {
  const keys = new Set();
  for (const e of entries || []) {
    const pk = _entryPk(e);
    if (pk && pk.startsWith('physical-runway:')) keys.add(pk);
  }
  return keys;
}

// Extract the set of `jetway:*` $k keys from an array of entry strings. Used to
// build the set of static jetway keys that legitimately exist, so the
// checkpoint-frame reconciliation can drop orphaned jetway runtime entities
// (see _cascadeOrphanEntries: a deleted stand also drops every jetway that
// serves it, so a jetway must not outlive the stand).
function _jetwayKeysFromEntries(entries) {
  const keys = new Set();
  for (const e of entries || []) {
    const pk = _entryPk(e);
    if (pk && pk.startsWith('jetway:')) keys.add(pk);
  }
  return keys;
}

// Rebuild an array value as `[ <entries joined by ",\n"> ]`.
function _arrayValue(entries) {
  if (entries.length === 0) return '[]';
  return '[\n      ' + entries.join(',\n      ') + '\n    ]';
}

// Left-pad the committed entries (indentation is cosmetic; the game's reader
// is whitespace-insensitive). We keep it simple and deterministic.
function _joinEntries(entries) {
  return entries.join(',');
}

// ─── Node coordinate patching (moved survivors) ───────────────────

// Canonical coordinate key MUST match scenery_graph.coordKey (toFixed(6)) so the
// writer can co-locate node entries that buildSceneryGraph deduped.
function _coordKey(x, z) {
  return (Number(x)).toFixed(6) + ',' + (Number(z)).toFixed(6);
}

function _extractNums(s) {
  const nums = [];
  const re = /[-\d.eE+]+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const v = parseFloat(m[0]);
    if (!isNaN(v)) nums.push(v);
  }
  return nums;
}

function _fmtNum(n) {
  // Use the same float string form that Odin writes (avoid exponent for small).
  return String(n);
}

// Rebuild the innermost Vector3 object, preserving its $type and middle (y),
// setting the new x (1st) and z (3rd) numbers. Vector3 is positional:
//   { "$type": N, x, y, z }
function _setVec3XZ(inner, nx, nz) {
  const t = createTokenizer(inner);
  const typeSec = t.findSection('$type');
  if (!typeSec) return inner;
  const typeRaw = inner.substring(typeSec.valueStart, typeSec.valueEnd); // e.g. "5|Vector3, ..."
  const after = inner.substring(typeSec.valueEnd);
  const nums = _extractNums(after);
  if (nums.length < 3) return inner;
  const y = nums[1];
  return '{ "$type": ' + typeRaw + ', ' + _fmtNum(nx) + ', ' + _fmtNum(y) + ', ' + _fmtNum(nz) + ' }';
}

// Patch a direct child int field ("Type" / "Flags") in a PK entry.
function _patchIntField(entry, key, newVal) {
  const t = createTokenizer(entry);
  const sec = t.findSection(key);
  if (!sec) return entry;
  // Ensure depth 1 (direct child) — _depthValueAbs already handles depth, but findSection is first occurrence; for taxiway-node Type is direct.
  return entry.slice(0, sec.valueStart) + String(newVal) + entry.slice(sec.valueEnd);
}

// Patch a taxiway-node entry's ReactivePosition x/z to (nx, nz). Returns the
// (possibly unchanged) entry. ReactivePosition value is:
//   { "$id":N, "$type":T, { "$type":S, x, y, z } }
function _patchNodePosition(entry, nx, nz) {
  const t = createTokenizer(entry);
  const rp = t.findSection('ReactivePosition');
  if (!rp) return entry;
  const rpText = entry.substring(rp.valueStart, rp.valueEnd);
  let brace = 0, innerStart = -1;
  for (let i = 0; i < rpText.length; i++) {
    if (rpText[i] === '{') { brace++; if (brace === 2) { innerStart = i; break; } }
  }
  if (innerStart < 0) return entry;
  const rt = createTokenizer(rpText);
  const innerEnd = rt.findObjectEnd(innerStart);
  if (innerEnd == null) return entry;
  const inner = rpText.substring(innerStart, innerEnd);
  const newInner = _setVec3XZ(inner, nx, nz);
  if (newInner === inner) return entry;
  const newRpVal = rpText.slice(0, innerStart) + newInner + rpText.slice(innerEnd);
  return entry.slice(0, rp.valueStart) + newRpVal + entry.slice(rp.valueEnd);
}

// ─── New-object synthesis (nodes + segments) ─────────────────────

function _valueOf(entry, key) {
  const t = createTokenizer(entry);
  const sec = t.findSection(key);
  if (!sec) return null;
  return entry.substring(sec.valueStart, sec.valueEnd).trim();
}

// Sample the $type strings + a node/segment shape from the first real entry so
// synthesized entries use the exact ambient format (e.g. "3|TaxiwayNode, Asm").
function _sampleShapes(pkEntries) {
  const node = pkEntries.find((e) => _entryTypePrefix(e) === 'taxiway-node');
  const seg = pkEntries.find((e) => _entryTypePrefix(e) === 'taxiway-segment');
  const shapes = { nodeType: null, reactiveType: null, vec3Type: null, segType: null, segListType: null, segInnerType: null };
  if (node) {
    const raw = _valueOf(node, '$type');
    shapes.nodeType = _isCorruptType(raw) ? null : raw;
    if (!shapes.nodeType) shapes.nodeType = '"3|ContextCross.Models.TaxiwayNode, GroundATC.Core"';
    const rp = node.match(/"ReactivePosition":\s*\{[^{]*?"\$type":\s*("[^"]+"|\d+)/);
    const v3 = node.match(/"\$type":\s*("[^"]+"|\d+),\s*-?[\d.eE+]+,/);
    const rawRp = rp ? rp[1] : null;
    shapes.reactiveType = _isCorruptType(rawRp) ? null : rawRp;
    if (!shapes.reactiveType) shapes.reactiveType = '"4|R3.ReactiveProperty`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], R3"';
    const rawV3 = v3 ? v3[1] : null;
    shapes.vec3Type = _isCorruptType(rawV3) ? null : rawV3;
    if (!shapes.vec3Type) shapes.vec3Type = '"5|UnityEngine.Vector3, UnityEngine.CoreModule"';
  } else {
    shapes.nodeType = '"3|ContextCross.Models.TaxiwayNode, GroundATC.Core"';
    shapes.reactiveType = '"4|R3.ReactiveProperty`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], R3"';
    shapes.vec3Type = '"5|UnityEngine.Vector3, UnityEngine.CoreModule"';
  }
  if (seg) {
    const rawSeg = _valueOf(seg, '$type');
    shapes.segType = _isCorruptType(rawSeg) ? null : rawSeg;
    if (!shapes.segType) shapes.segType = '"6|ContextCross.Models.TaxiwaySegment, GroundATC.Core"';
    // Nodes: { "$type": TD, { "$type": TDL, $rcontent } }
    const rc = seg.match(/"Nodes":\s*\{[^{]*?"\$type":\s*("[^"]+"|\d+)/);
    const rawRc = rc ? rc[1] : null;
    shapes.segListType = _isCorruptType(rawRc) ? null : rawRc;
    if (!shapes.segListType) shapes.segListType = '"7|R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[ContextCross.Models.TaxiwayNode, GroundATC.Core]], mscorlib]], R3"';
    const inner = seg.match(/"\$type":\s*("[^"]+"|\d+),\s*"\$rlength"/);
    const rawInner = inner ? inner[1] : null;
    shapes.segInnerType = _isCorruptType(rawInner) ? null : rawInner;
    if (!shapes.segInnerType) shapes.segInnerType = '"8|System.Collections.Generic.List`1[[ContextCross.Models.TaxiwayNode, GroundATC.Core]], mscorlib"';
  } else {
    shapes.segType = '"6|ContextCross.Models.TaxiwaySegment, GroundATC.Core"';
    shapes.segListType = '"7|R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[ContextCross.Models.TaxiwayNode, GroundATC.Core]], mscorlib]], R3"';
    shapes.segInnerType = '"8|System.Collections.Generic.List`1[[ContextCross.Models.TaxiwayNode, GroundATC.Core]], mscorlib"';
  }
  return shapes;
}

function _fmtType(v) {
  if (v == null) return '0';
  const s = String(v).trim();
  if (s === '0' || s === '"0"') return '0';
  return v;
}
function _isCorruptType(v) {
  if (v == null) return true;
  const s = String(v).trim();
  // Bare "0" is the ArchiveHeader type — never valid for scenery entities.
  // A quoted "0|..." with id 0 is also invalid for TaxiwayNode/Runway etc.
  if (s === '0' || s === '"0"' || s.startsWith('"0|')) return true;
  if (/^"?0"?$/.test(s)) return true;
  return false;
}

// ── Corrupt-type auto-repair (replaces bare "$type": 0 with canonical fallbacks) ──
// When the original file is missing a type (e.g. 404-entry ZSJN_leisure_1 with 0
// runways) the sampler previously returned null → _fmtType produced "0" and the
// guard threw. Instead repair the entry so the save succeeds.
function _repairPkEntryTypes(entry) {
  if (!/"\$type":\s*0(?=[,\}\]])/.test(entry)) return entry;
  const prefix = _entryTypePrefix(entry);
  if (prefix === 'taxiway-node') {
    const f = [
      '"3|ContextCross.Models.TaxiwayNode, GroundATC.Core"',
      '"4|R3.ReactiveProperty`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], R3"',
      '"5|UnityEngine.Vector3, UnityEngine.CoreModule"',
    ];
    let i = 0;
    return entry.replace(/"\$type":\s*0(?=[,\}\]])/g, () => '"$type": ' + (f[i++] || f[f.length - 1]));
  } else if (prefix === 'taxiway-segment') {
    const f = [
      '"6|ContextCross.Models.TaxiwaySegment, GroundATC.Core"',
      '"7|R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[ContextCross.Models.TaxiwayNode, GroundATC.Core]], mscorlib]], R3"',
      '"8|System.Collections.Generic.List`1[[ContextCross.Models.TaxiwayNode, GroundATC.Core]], mscorlib"',
    ];
    let i = 0;
    return entry.replace(/"\$type":\s*0(?=[,\}\]])/g, () => '"$type": ' + (f[i++] || f[f.length - 1]));
  } else if (prefix === 'stand') {
    const f = [
      '"20|ContextCross.Models.Stand, GroundATC.Core"',
      '"21|R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib]], R3"',
      '"5|UnityEngine.Vector3, UnityEngine.CoreModule"',
    ];
    let i = 0;
    return entry.replace(/"\$type":\s*0(?=[,\}\]])/g, () => '"$type": ' + (f[i++] || f[f.length - 1]));
  } else if (prefix === 'runway') {
    // Field order in _synthesizeRunway (11 distinct $types, last is vec3 repeated per vertex)
    const f = [
      '"13|ContextCross.Models.Runway, GroundATC.Core"',
      '"14|ContextCross.Models.PhysicalRunwayStaticItem, GroundATC.Core"',
      '"15|ContextCross.Models.Runway+Entry[], GroundATC.Core"',
      '"17|ContextCross.Models.Runway+Exit[], GroundATC.Core"',
      '"19|ContextCross.Models.Route[], GroundATC.Core"',
      '"22|ContextCross.Models.TaxiwayNode[], GroundATC.Core"',
      '"22|ContextCross.Models.TaxiwayNode[], GroundATC.Core"',
      '"23|UnityEngine.Vector3[], UnityEngine.CoreModule"',
      '"24|ContextCross.Models.Runway+HoldingAreaData[], GroundATC.Core"',
      '"26|R3.ReactiveProperty`1[[System.Boolean, mscorlib]], R3"',
    ];
    const vec3 = '"5|UnityEngine.Vector3, UnityEngine.CoreModule"';
    let i = 0;
    return entry.replace(/"\$type":\s*0(?=[,\}\]])/g, () => {
      if (i < f.length) return '"$type": ' + f[i++];
      return '"$type": ' + vec3;
    });
  } else if (prefix === 'physical-runway' || prefix === 'jetway' || prefix === 'taxi-navigation') {
    // Should not be managed, but repair generically if needed
    return entry.replace(/"\$type":\s*0(?=[,\}\]])/g, '"$type": "99|Repaired.Fallback, GroundATC.Core"');
  }
  // Unknown prefix — generic repair so the file remains loadable
  return entry.replace(/"\$type":\s*0(?=[,\}\]])/g, '"$type": "99|Repaired.Fallback, GroundATC.Core"');
}
function _repairNpkEntryTypes(entry) {
  if (!/"\$type":\s*0(?=[,\}\]])/.test(entry)) return entry;
  if (entry.includes('ContextCross.Models.Area')) {
    const f = [
      '"31|ContextCross.Models.Area, GroundATC.Core"',
      '"32|R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib]], R3"',
      '"33|System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib"',
    ];
    const vec3 = '"5|UnityEngine.Vector3, UnityEngine.CoreModule"';
    let i = 0;
    return entry.replace(/"\$type":\s*0(?=[,\}\]])/g, () => {
      if (i < f.length) return '"$type": ' + f[i++];
      return '"$type": ' + vec3;
    });
  }
  return entry.replace(/"\$type":\s*0(?=[,\}\]])/g, '"$type": "99|Repaired.Fallback, GroundATC.Core"');
}

function _synthesizeNode(node, id, osm, s) {
  const rpId = id + 1;
  const v3Id = id + 2;
  const nType = node.type != null && Number.isFinite(Number(node.type)) ? Math.trunc(Number(node.type)) : 1;
  const nFlags = node.flags != null && Number.isFinite(Number(node.flags)) ? Math.trunc(Number(node.flags)) : 0;
  return '{ "$k": "taxiway-node:' + osm + '", "$v": { "$id": ' + id +
    ', "$type": ' + _fmtType(s.nodeType) +
    ', "ReactivePosition": { "$id": ' + rpId + ', "$type": ' + _fmtType(s.reactiveType) +
    ', { "$type": ' + _fmtType(s.vec3Type) + ', ' + _fmtNum(node.x) + ', 0, ' + _fmtNum(node.z) + ' } },' +
    ' "PK": "taxiway-node:' + osm + '", "OsmId": ' + osm + ', "Name": null, "Type": ' + nType +
    ', "Flags": ' + nFlags + ' } }';
}

function _synthesizeSegment(seg, id, osm, segNodeIds, s) {
  const nodesId = id + 1;
  const innerId = id + 2;
  const name = seg.name != null && String(seg.name).length > 0 ? JSON.stringify(String(seg.name)) : '""';
  const segFlags = seg.flags != null && Number.isFinite(Number(seg.flags)) ? Math.trunc(Number(seg.flags)) : 2;
  // Every emitted node must resolve to a declared $id. A null/undefined entry
  // used to fall back to [null, null] and serialize as "$iref:null", which the
  // Odin JSON reader rejects (`invalid $iref payload "null"`) — aborting the
  // whole Ground Painter save. Return null so the caller drops the entry.
  const ids = (segNodeIds || []).filter((v) => v != null);
  if (ids.length < 2) return null;
  const irefStr = ids.map((nid) => '$iref:' + nid).join(', ');
  // Match the canonical TaxiwaySegment shape: every original segment carries
  // Head (the first/linked node for directed taxilanes, null for undirected),
  // IsHidden and IsUnselectable booleans. The writer previously omitted all
  // three, so editor-created taxiways deserialized into an incomplete segment
  // that the game dropped from its ground/route graph (the "doesn't show up
  // in-game" report). See _sampleShapes-verified ambient type.
  const head = seg.directed && ids[0] != null ? '$iref:' + ids[0] : 'null';
  // Canonical TaxiwaySegment field ORDER (matches the game's serializer): Odin's
  // binary format is POSITIONAL — data fields must appear in the type's declared
  // order ($id, $type, PK, Name, OsmId, Nodes, Flags, Directed, Head, IsHidden,
  // IsUnselectable). The writer previously emitted Name first and PK/OsmId LAST,
  // so the game misassigned every field and dropped editor-created taxiways
  // ("add a taxiway → doesn't show in-game"). That field order is the root cause
  // of the deserialize-drop; the inner $id and Head/IsHidden/IsUnselectable were
  // also needed but are now emitted in the canonical position.
  return '{ "$k": "taxiway-segment:' + osm + ':0", "$v": { "$id": ' + id +
    ', "$type": ' + _fmtType(s.segType) + ', "PK": "taxiway-segment:' + osm + ':0"' +
    ', "Name": ' + name + ', "OsmId": ' + osm +
    ', "Nodes": { "$id": ' + nodesId + ', "$type": ' + _fmtType(s.segListType) +
    ', { "$id": ' + innerId + ', "$type": ' + _fmtType(s.segInnerType) + ', "$rlength": ' + ids.length + ', "$rcontent": [ ' + irefStr + ' ] } },' +
    ' "Flags": ' + segFlags + ', "Directed": ' + (seg.directed ? 'true' : 'false') +
    ', "Head": ' + head + ', "IsHidden": false, "IsUnselectable": false } }';
}

function _sampleStandShapes(pkEntries) {
  const s = { standType: null, pbArrayType: null };
  const st = pkEntries.find((e) => _entryTypePrefix(e) === 'stand');
  if (st) {
    const rawSt = _valueOf(st, '$type');
    s.standType = _isCorruptType(rawSt) ? null : rawSt;
    if (!s.standType) s.standType = '"20|ContextCross.Models.Stand, GroundATC.Core"';
    const m = st.match(/"PushbackLimitPositions":\s*\{[^{]*?"\$type":\s*("[^"]+"|\d+)/);
    const rawPb = m ? m[1] : null;
    s.pbArrayType = _isCorruptType(rawPb) ? null : rawPb;
    if (!s.pbArrayType) s.pbArrayType = '"21|R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib]], R3"';
  } else {
    s.standType = '"20|ContextCross.Models.Stand, GroundATC.Core"';
    s.pbArrayType = '"21|R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib]], R3"';
  }
  return s;
}

function _synthesizeStand(stand, id, ident, noseId, tailId, pbIds, s) {
  // Nose/tail are mandatory references (see _synthesizeSegment): emitting them
  // as "$iref:null" makes the encoded blob unreadable. Return null so the
  // caller drops the stand instead.
  if (noseId == null || tailId == null) return null;
  const arrId = id + 1;
  const pbIdsArr = (pbIds || []).filter((i) => i != null);
  const pbStr = pbIdsArr.map((i) => '$iref:' + i).join(', ');
  // The user-entered Name (if any) is used as the display name; the Identifier
  // stays the unique numeric id that flight plans / aircraft reference. When no
  // name was entered, fall back to the identifier (as before) so a default stand
  // keeps a meaningful Name.
  const standName = stand.name != null && String(stand.name).length > 0 ? String(stand.name) : ident;
  return '{ "$k": "stand:' + ident + '", "$v": { "$id": ' + id + ', "$type": ' + _fmtType(s.standType) +
    ', "TailPosition": $iref:' + tailId + ', "NosePosition": $iref:' + noseId +
    ', "PushbackLimitPositions": { "$id": ' + arrId + ', "$type": ' + _fmtType(s.pbArrayType) +
    ', "$rlength": ' + pbIdsArr.length + ', "$rcontent": [ ' + pbStr + ' ] },' +
    ' "ParkingType": ' + (stand.parkingType ?? 1) + ', "EgressType": ' + (stand.egressType ?? 0) +
    ', "Name": ' + JSON.stringify(standName) + ', "Identifier": "' + ident + '" } }';
}

// Extract the numeric type id from a $type value: "N|Name", bare N, or quoted "N|Name".
function _typeId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(/"?(\d+)(?:\|(?:[^"]*))?"?/);
  return m ? parseInt(m[1], 10) : null;
}

// Sample a runway section's INNER (element) type id — the $type of the FIRST object
// inside Entries/Exits.$rcontent. The array wrapper's own type ("Runway+Entry[]" /
// "Runway+Exit[]") is a DIFFERENT type from its elements ("Runway+Entry"/"Runway+Exit")
// and MUST use a distinct id, or the GATCARC4 writer aborts with
// "Type id N claimed by both ...". Returns the full "N|name" string, or NULL when the
// element type id cannot be determined (no $rcontent element anywhere). Callers must
// assert on a null return — NO hardcoded fallback is allowed.
function _sampleRunwayInnerType(runwayEntries, sectionType, sectionName, innerName) {
  const arrId = _typeId(sectionType);
  const re = new RegExp(
    '"' + sectionName + '"[\\s\\S]{0,900}?"\\$rcontent"\\s*:\\s*\\[\\s*\\{\\s*"\\$id":\\s*\\d+\\s*,\\s*"\\$type":\\s*("[^"]+"|\\d+)',
    'm'
  );
  for (const e of runwayEntries) {
    const m = e.match(re);
    if (!m) continue;
    const raw = m[1];
    if (_isCorruptType(raw)) continue;
    const id = _typeId(raw);
    if (id !== null && id !== arrId) return '"' + id + '|' + innerName + '"';
  }
  return null;
}

function _sampleRunwayShapes(pkEntries) {
  const s = {
    runwayType: null, itemType: null,
    entriesType: null, exitsType: null, entryInnerType: null, exitInnerType: null, routesType: null,
    edgePointsType: null, thresholdPointsType: null,
    areaVerticesType: null, holdingAreasType: null,
    boolReactiveType: null, vec3Type: null,
  };
  const rw = pkEntries.find((e) => _entryTypePrefix(e) === 'runway');
  const runwayEntries = pkEntries.filter((e) => _entryTypePrefix(e) === 'runway');
  if (!rw) {
    // No runway to sample — return canonical fallbacks so synthesis never emits "$type": 0.
    // Array and inner (element) types MUST use distinct ids or the GATCARC4 writer
    // aborts with "Type id N claimed by both ...".
    s.runwayType = '"13|ContextCross.Models.Runway, GroundATC.Core"';
    s.itemType = '"14|ContextCross.Models.PhysicalRunwayStaticItem, GroundATC.Core"';
    s.entriesType = '"15|ContextCross.Models.Runway+Entry[], GroundATC.Core"';
    s.entryInnerType = '"16|ContextCross.Models.Runway+Entry, GroundATC.Core"';
    s.exitsType = '"17|ContextCross.Models.Runway+Exit[], GroundATC.Core"';
    s.exitInnerType = '"18|ContextCross.Models.Runway+Exit, GroundATC.Core"';
    s.routesType = '"19|ContextCross.Models.Route[], GroundATC.Core"';
    s.edgePointsType = '"22|ContextCross.Models.TaxiwayNode[], GroundATC.Core"';
    s.thresholdPointsType = s.edgePointsType;
    s.areaVerticesType = '"23|UnityEngine.Vector3[], UnityEngine.CoreModule"';
    s.holdingAreasType = '"24|ContextCross.Models.Runway+HoldingAreaData[], GroundATC.Core"';
    s.boolReactiveType = '"26|R3.ReactiveProperty`1[[System.Boolean, mscorlib]], R3"';
    s.vec3Type = '"5|UnityEngine.Vector3, UnityEngine.CoreModule"';
    return s;
  }
  const rawRunwayType = _valueOf(rw, '$type');
  s.runwayType = _isCorruptType(rawRunwayType) ? null : rawRunwayType;
  const mItem = rw.match(/"PhysicalRunwayStaticItem":\s*\{\s*"\$id":\s*\d+\s*,\s*"\$type":\s*("[^"]+"|\d+)/);
  const rawItem = mItem ? mItem[1] : null;
  s.itemType = _isCorruptType(rawItem) ? null : rawItem;
  const mEntries = rw.match(/"Entries":\s*\{\s*"\$id":\s*\d+\s*,\s*"\$type":\s*("[^"]+"|\d+)/);
  const rawEntries = mEntries ? mEntries[1] : null;
  s.entriesType = _isCorruptType(rawEntries) ? null : rawEntries;
  // Inner Entry type (the object inside Entries.$rcontent) — a DIFFERENT type from
  // the array wrapper ("Runway+Entry[]"), so it MUST use a distinct id. No fallback:
  // if the element type can't be sampled, leave null and the caller asserts.
  s.entryInnerType = _sampleRunwayInnerType(runwayEntries, s.entriesType, 'Entries', 'ContextCross.Models.Runway+Entry, GroundATC.Core');
  const mExits = rw.match(/"Exits":\s*\{\s*"\$id":\s*\d+\s*,\s*"\$type":\s*("[^"]+"|\d+)/);
  const rawExits = mExits ? mExits[1] : null;
  s.exitsType = _isCorruptType(rawExits) ? null : rawExits;
  // Inner Exit type (the object inside Exits.$rcontent) — distinct from the array.
  s.exitInnerType = _sampleRunwayInnerType(runwayEntries, s.exitsType, 'Exits', 'ContextCross.Models.Runway+Exit, GroundATC.Core');
  const mRoutes = rw.match(/"Routes":\s*\{\s*"\$id":\s*\d+\s*,\s*"\$type":\s*("[^"]+"|\d+)/);
  const rawRoutes = mRoutes ? mRoutes[1] : null;
  s.routesType = _isCorruptType(rawRoutes) ? null : rawRoutes;
  const mEdge = rw.match(/"EdgePoints":\s*\{\s*"\$id":\s*\d+\s*,\s*"\$type":\s*("[^"]+"|\d+)/);
  const rawEdge = mEdge ? mEdge[1] : null;
  s.edgePointsType = _isCorruptType(rawEdge) ? null : rawEdge;
  const mTh = rw.match(/"ThresholdPoints":\s*\{\s*"\$id":\s*\d+\s*,\s*"\$type":\s*("[^"]+"|\d+)/);
  const rawTh = mTh ? mTh[1] : null;
  s.thresholdPointsType = _isCorruptType(rawTh) ? null : rawTh;
  if (!s.thresholdPointsType) s.thresholdPointsType = s.edgePointsType;
  const mArea = rw.match(/"AreaVertices":\s*\{\s*"\$id":\s*\d+\s*,\s*"\$type":\s*("[^"]+"|\d+)/);
  const rawArea = mArea ? mArea[1] : null;
  s.areaVerticesType = _isCorruptType(rawArea) ? null : rawArea;
  const mHold = rw.match(/"HoldingAreas":\s*\{\s*"\$id":\s*\d+\s*,\s*"\$type":\s*("[^"]+"|\d+)/);
  const rawHold = mHold ? mHold[1] : null;
  s.holdingAreasType = _isCorruptType(rawHold) ? null : rawHold;
  const mBool = rw.match(/"IsActive":\s*\{\s*"\$id":\s*\d+\s*,\s*"\$type":\s*("[^"]+"|\d+)/);
  const rawBool = mBool ? mBool[1] : null;
  s.boolReactiveType = _isCorruptType(rawBool) ? null : rawBool;
  // Vector3 type for AreaVertices points: find { "$type": 5, x,0,z }
  const mVec = rw.match(/"\$type":\s*("[^"]*Vector3[^"]*"|\d+),\s*-?[\d.eE+]+,\s*0,\s*-?[\d.eE+]+/);
  const rawVec = mVec ? mVec[1] : null;
  if (rawVec && !_isCorruptType(rawVec)) s.vec3Type = rawVec;
  else {
    const node = pkEntries.find((e) => _entryTypePrefix(e) === 'taxiway-node');
    s.vec3Type = node ? (_isCorruptType((node.match(/"\$type":\s*("[^"]+"|\d+),\s*-?[\d.eE+]+,/) || [])[1]) ? null : (node.match(/"\$type":\s*("[^"]+"|\d+),\s*-?[\d.eE+]+,/) || [])[1]) : null;
  }
  return s;
}

// Assert that a sampled type value is a non-corrupt, non-null Odin $type string.
// No hardcoded fallback is allowed — if a type can't be determined from the file,
// fail loudly rather than emitting a guessed (and potentially colliding) type id.
function _assertSampledType(label, v) {
  if (v == null || _isCorruptType(v)) {
    throw new Error(`GATCARC4: cannot determine type "${label}" from the runway — no fallback allowed, refusing to emit a guessed $type`);
  }
  return v;
}

// ─── Runway Entries/Exits patch helpers (for GroundPainter checkbox editing) ──

function _extractSectionObjectText(blockText, sectionName) {
  const t = createTokenizer(blockText);
  const sec = t.findSection(sectionName);
  if (!sec) return null;
  return t.substring(sec.valueStart, sec.valueEnd);
}

function _buildEntriesWrapperForPatch(newEntries, origWrapperText, nodeIds, s, nextIdRef) {
  let origId = null;
  let origType = null;
  if (origWrapperText) {
    const mId = origWrapperText.match(/"\$id"\s*:\s*(\d+)/);
    if (mId) origId = parseInt(mId[1], 10);
    const mType = origWrapperText.match(/"\$type"\s*:\s*("[^"]+"|\d+)/);
    if (mType) origType = mType[1];
  }
  if (origId == null) origId = nextIdRef.value++;
  // No fallback: the array wrapper's type must be determinable (from the block or
  // the sampled runway). If not, fail loudly rather than emit a guessed $type.
  if (_isCorruptType(origType)) origType = s.entriesType;
  origType = _assertSampledType('Runway+Entry[]', origType);
  const innerStrs = [];
  for (const en of newEntries || []) {
    const holding = en.holdingIdx != null ? nodeIds[en.holdingIdx] : null;
    const lineUp = en.lineUpIdx != null ? nodeIds[en.lineUpIdx] : null;
    const definePt = en.defineIdx != null ? nodeIds[en.defineIdx] : null;
    if (holding == null || lineUp == null || definePt == null) continue;
    const nid = nextIdRef.value++;
    const name = JSON.stringify(String(en.name || ''));
    _assertSampledType('Runway+Entry', s.entryInnerType);
    innerStrs.push(`{ "$id": ${nid}, "$type": ${_fmtType(s.entryInnerType)}, "Name": ${name}, "HoldingPosition": $iref:${holding}, "LineUpPosition": $iref:${lineUp}, "DefinePoint": $iref:${definePt} }`);
  }
  return `{ "$id": ${origId}, "$type": ${_fmtType(origType)}, "$rlength": ${innerStrs.length}, "$rcontent": [ ${innerStrs.join(', ')} ] }`;
}

function _buildExitsWrapperForPatch(newExits, origWrapperText, nodeIds, s, nextIdRef) {
  let origId = null;
  let origType = null;
  if (origWrapperText) {
    const mId = origWrapperText.match(/"\$id"\s*:\s*(\d+)/);
    if (mId) origId = parseInt(mId[1], 10);
    const mType = origWrapperText.match(/"\$type"\s*:\s*("[^"]+"|\d+)/);
    if (mType) origType = mType[1];
  }
  if (origId == null) origId = nextIdRef.value++;
  if (_isCorruptType(origType)) origType = s.exitsType;
  origType = _assertSampledType('Runway+Exit[]', origType);
  const innerStrs = [];
  for (const ex of newExits || []) {
    const exitPos = ex.exitIdx != null ? nodeIds[ex.exitIdx] : null;
    const holding = ex.holdingIdx != null ? nodeIds[ex.holdingIdx] : null;
    const definePt = ex.defineIdx != null ? nodeIds[ex.defineIdx] : null;
    if (exitPos == null || holding == null || definePt == null) continue;
    const nid = nextIdRef.value++;
    const name = JSON.stringify(String(ex.name || ''));
    const isLeft = ex.isLeft ? 'true' : 'false';
    _assertSampledType('Runway+Exit', s.exitInnerType);
    innerStrs.push(`{ "$id": ${nid}, "$type": ${_fmtType(s.exitInnerType)}, "Name": ${name}, "ExitPosition": $iref:${exitPos}, "HoldingPosition": $iref:${holding}, "DefinePoint": $iref:${definePt}, "IsLeft": ${isLeft} }`);
  }
  return `{ "$id": ${origId}, "$type": ${_fmtType(origType)}, "$rlength": ${innerStrs.length}, "$rcontent": [ ${innerStrs.join(', ')} ] }`;
}

function _patchRunwayBlockWithEntriesExits(blockText, newEntriesWrapper, newExitsWrapper) {
  let out = blockText;
  if (newEntriesWrapper) {
    const t1 = createTokenizer(out);
    const sec1 = t1.findSection('Entries');
    if (sec1) out = out.slice(0, sec1.valueStart) + newEntriesWrapper + out.slice(sec1.valueEnd);
  }
  if (newExitsWrapper) {
    const t2 = createTokenizer(out);
    const sec2 = t2.findSection('Exits');
    if (sec2) out = out.slice(0, sec2.valueStart) + newExitsWrapper + out.slice(sec2.valueEnd);
  }
  return out;
}

// Emit a full runway pair (both reciprocal directions) sharing one nested
// PhysicalRunwayStaticItem, with threshold $irefs into the node $ids.
// Generates valid Unity entries: includes Entries/Exits/Routes (empty), Edge/Threshold
// with proper $id wrappers, AreaVertices rectangle, HoldingAreas empty, IsActive.
function _synthesizeRunway(rw, idBase, thAId, thBId, s, graph) {
  // Support both new graph shape (names:[A,B]) and legacy (name + physicalName)
  let nameA, nameB, phys;
  if (Array.isArray(rw.names) && rw.names.length >= 2) {
    nameA = String(rw.names[0] || '01');
    nameB = String(rw.names[1] || '19');
    phys = rw.physicalName || (nameA + '/' + nameB);
  } else {
    const parts = (rw.physicalName || '').split('/');
    nameA = rw.name || parts[0] || '01';
    nameB = parts[1] || (nameA === '01' ? '19' : '01');
    phys = rw.physicalName || (nameA + '/' + nameB);
  }
  phys = nameA + '/' + nameB; // enforce join per user request
  const width = (rw.width != null && Number(rw.width) !== 0) ? Number(rw.width) : 0.50;
  // Allocate ids: item, rA, rB, plus wrappers per side
  // For each side we need: entries, exits, routes, edge, threshold, area, holding, isActive (8)
  // Total = 1 + 2*(1+8) = 19 ids, but we allocate sequentially
  let cur = idBase;
  const itemId = cur++;
  const rA = cur++;
  const entriesA = cur++;
  const exitsA = cur++;
  const routesA = cur++;
  const edgeA = cur++;
  const thA = cur++;
  const areaA = cur++;
  const holdA = cur++;
  const activeA = cur++;
  const rB = cur++;
  const entriesB = cur++;
  const exitsB = cur++;
  const routesB = cur++;
  const edgeB = cur++;
  const thB = cur++;
  const areaB = cur++;
  const holdB = cur++;
  const activeB = cur++;
  // AreaVertices rectangle around thresholds with halfWidth
  const nodeA = graph ? graph.nodes[thAId] : null; // thAId is $id of node, not graph index! Wait we pass nodeIds, not graph nodes
  // Instead compute AreaVertices from graph nodes via th indices: we have graph.nodes[runway.thAIdx] etc.
  // But here we receive thAId as $id of taxiway-node, not coordinates. Need coordinates via graph.
  let areaPtsA = [];
  let areaPtsB = [];
  if (graph && rw.thAIdx != null && rw.thBIdx != null) {
    const a = graph.nodes[rw.thAIdx];
    const b = graph.nodes[rw.thBIdx];
    if (a && b) {
      const halfW = (Number(width) || 0.50) / 2;
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const px = (-dz / len) * halfW, pz = (dx / len) * halfW;
      areaPtsA = [
        { x: a.x - px, z: a.z - pz },
        { x: b.x - px, z: b.z - pz },
        { x: b.x + px, z: b.z + pz },
        { x: a.x + px, z: a.z + pz },
      ];
      areaPtsB = areaPtsA.slice(); // same rectangle
    }
  }
  if (areaPtsA.length === 0) {
    // Fallback: generate degenerate rectangle around origin if missing
    areaPtsA = [{x:0,z:0},{x:1,z:0},{x:1,z:1},{x:0,z:1}];
    areaPtsB = areaPtsA;
  }
  const areaStrA = areaPtsA.map((p) => '{ "$type": ' + _fmtType(s.vec3Type) + ', ' + _fmtNum(p.x) + ', 0, ' + _fmtNum(p.z) + ' }').join(', ');
  const areaStrB = areaPtsB.map((p) => '{ "$type": ' + _fmtType(s.vec3Type) + ', ' + _fmtNum(p.x) + ', 0, ' + _fmtNum(p.z) + ' }').join(', ');
  // No fallback is allowed: every type the synthesized runway emits must be
  // determined from the file, or we refuse to fabricate a (potentially colliding)
  // $type id.
  _assertSampledType('Runway', s.runwayType);
  _assertSampledType('PhysicalRunwayStaticItem', s.itemType);
  _assertSampledType('Runway+Entry[]', s.entriesType);
  _assertSampledType('Runway+Exit[]', s.exitsType);
  _assertSampledType('Route[]', s.routesType);
  _assertSampledType('TaxiwayNode[] (EdgePoints)', s.edgePointsType);
  _assertSampledType('TaxiwayNode[] (ThresholdPoints)', s.thresholdPointsType);
  _assertSampledType('Vector3[]', s.areaVerticesType);
  _assertSampledType('Runway+HoldingAreaData[]', s.holdingAreasType);
  _assertSampledType('ReactiveProperty<bool>', s.boolReactiveType);
  _assertSampledType('Vector3', s.vec3Type);
  const entryTemplate = (rId, name, itemRef, edgeId, thId, areaId, holdId, activeId, entriesId, exitsId, routesId, thFirst, thSecond, areaStr) => {
    return '{ "$k": "runway:' + name + '", "$v": { "$id": ' + rId + ', "$type": ' + _fmtType(s.runwayType) +
      ', "Name": "' + name + '", "PhysicalRunwayStaticItem": ' + itemRef +
      ', "Entries": { "$id": ' + entriesId + ', "$type": ' + _fmtType(s.entriesType) + ', "$rlength": 0, "$rcontent": [] }' +
      ', "Exits": { "$id": ' + exitsId + ', "$type": ' + _fmtType(s.exitsType) + ', "$rlength": 0, "$rcontent": [] }' +
      ', "Routes": { "$id": ' + routesId + ', "$type": ' + _fmtType(s.routesType) + ', "$rlength": 0, "$rcontent": [] }' +
      ', "TouchDownPoint": $iref:' + thFirst +
      ', "EdgePoints": { "$id": ' + edgeId + ', "$type": ' + _fmtType(s.edgePointsType) + ', "$rlength": 2, "$rcontent": [ $iref:' + thFirst + ', $iref:' + thSecond + ' ] }' +
      ', "ThresholdPoints": { "$id": ' + thId + ', "$type": ' + _fmtType(s.thresholdPointsType) + ', "$rlength": 2, "$rcontent": [ $iref:' + thFirst + ', $iref:' + thSecond + ' ] }' +
      ', "AreaVertices": { "$id": ' + areaId + ', "$type": ' + _fmtType(s.areaVerticesType) + ', "$rlength": 4, "$rcontent": [ ' + areaStr + ' ] }' +
      ', "HoldingAreas": { "$id": ' + holdId + ', "$type": ' + _fmtType(s.holdingAreasType) + ', "$rlength": 0, "$rcontent": [] }' +
      ', "Width": ' + _fmtNum(width) +
      ', "LabelPositionNode": $iref:' + thFirst +
      ', "IsActive": { "$id": ' + activeId + ', "$type": ' + _fmtType(s.boolReactiveType) + ', ' + (name === nameA ? 'true' : 'false') + ' } } }';
  };
  const itemInline = '{ "$id": ' + itemId + ', "$type": ' + _fmtType(s.itemType) + ', "PhysicalName": "' + phys + '" }';
  const entryA = entryTemplate(rA, nameA, itemInline, edgeA, thA, areaA, holdA, activeA, entriesA, exitsA, routesA, thAId, thBId, areaStrA);
  const entryB = entryTemplate(rB, nameB, '$iref:' + itemId, edgeB, thB, areaB, holdB, activeB, entriesB, exitsB, routesB, thBId, thAId, areaStrB);
  return [entryA, entryB];
}

// Build the synthesized PK entries for every NEW node + segment, and return
// { entries, nodeIds } where nodeIds is the $id per graph node index (survivors
// reuse their original $id; new nodes get a fresh one).
// Unified id allocation: nextId starts above the max $id seen in PK+NPK+SI
// within the same $blobdoc, and advances by the exact number of $ids each
// synthesized object consumes (node=3, segment=3, stand=2, runway=19) so that
// no two declarations share the same old $id before renumber. Duplicate old
// ids cause renumberAclIds (scope.map last-wins) to misbind $iref targets,
// which previously produced the 09/01 -> Area 8930 corruption.
function _synthesizeNew(graph, meta, pkEntries, npkEntries, siEntries, warnings) {
  const s = _sampleShapes(pkEntries);
  // survivor node $id by original pk
  const survivorNodeId = new Map();
  for (const e of pkEntries) {
    if (_entryTypePrefix(e) === 'taxiway-node') survivorNodeId.set(_entryPk(e), _entryId(e));
  }
  // Unified max across all blobdoc id spaces (PK, NPK, SI) to avoid collision.
  let maxId = 0;
  const allEntrySets = [pkEntries, npkEntries || [], siEntries || []];
  for (const set of allEntrySets) {
    for (const e of set) {
      const id = _entryId(e); if (id != null && id > maxId) maxId = id;
      // Also scan for nested $ids inside the entry block (e.g. Area's
      // ReactiveProperty/List, runway's wrapper objects) that are not the
      // top-level entry $id. A regex scan is cheap and guarantees we stay
      // above every id declared in the blobdoc.
      const re = /"\$id"\s*:\s*(\d+)/g;
      let m;
      while ((m = re.exec(e)) !== null) {
        const nid = parseInt(m[1], 10);
        if (nid > maxId) maxId = nid;
      }
    }
  }
  // Fallback: also consider any $id in the raw arrays that _entryId missed
  // (defensive, but the loop above already covers it).
  let nextId = maxId + 1;
  // ── Auto-generated OsmId (fresh negatives) ───────────────────────
  // New taxiway nodes/segments use fresh negative OsmIds below the current
  // minimum, guaranteeing no collision with existing file OsmIds.
  const deletedSet = new Set((meta && meta.deletedPks) || []);
  const minOsm = _minTaxiwayOsm(pkEntries);
  let nextOsm = minOsm <= -1 ? minOsm - 1 : -1;
  function allocNodeOsm() { return nextOsm--; }
  function allocSegOsm() { return nextOsm--; }

  const entries = [];
  const nodeIds = [];
  for (let g = 0; g < graph.nodes.length; g++) {
    const pk = meta.nodeOrigPk ? meta.nodeOrigPk[g] : null;
    if (pk != null && deletedSet.has(pk)) {
      // Ghost node kept in graph for index stability (fillet) but marked deleted — do not persist.
      nodeIds[g] = null;
      continue;
    }
    if (pk != null && survivorNodeId.has(pk) && !deletedSet.has(pk)) {
      nodeIds[g] = survivorNodeId.get(pk);
    } else {
      const id = nextId;
      nodeIds[g] = id;
      // _synthesizeNode consumes 3 ids: node $id, ReactiveProperty $id, Vector3 wrapper $id
      nextId += 3;
      entries.push(_synthesizeNode(graph.nodes[g], id, allocNodeOsm(), s));
    }
  }
  for (let j = 0; j < graph.segments.length; j++) {
    const pk = meta.segOrigPk ? meta.segOrigPk[j] : null;
    if (pk != null) continue; // survivor kept verbatim
    const seg = graph.segments[j];
    // Full polyline: every node in the segment (nodeIdxs, or legacy 2-endpoint).
    const nodePkIdxs = []; // graph node indices in segment order
    if (seg.nodeIdxs && seg.nodeIdxs.length >= 2) {
      for (const ni of seg.nodeIdxs) nodePkIdxs.push(ni);
    } else {
      nodePkIdxs.push(seg.aIdx, seg.bIdx);
    }
    const segNodeIds = nodePkIdxs.map((ni) => nodeIds[ni]).filter((v) => v != null);
    if (segNodeIds.length < 2) {
      // Both endpoints must resolve to a persisted node $id (a node marked
      // deleted in the painter, or a stale node index, resolves to null). Same
      // policy as the runway guard below: drop the unusable entity rather than
      // write a blob the game cannot read.
      const w = { key: 'ground_painter_writer_new_segment_dropped', params: { indices: JSON.stringify(nodePkIdxs) },
        text: 'dropped a new taxiway segment: its endpoint node(s) no longer exist (indices ' +
          JSON.stringify(nodePkIdxs) + ')' };
      console.warn('[scenery_write] ' + w.text);
      if (warnings) warnings.push(w);
      continue;
    }
    const id = nextId;
    nextId += 3; // seg $id, Nodes wrapper $id, inner list $id
    // A split-piece segment carries `parentOsm` (the original taxiway visual path
    // it was severed from). Re-emit it under THAT OsmId — as a later ordinal — so a
    // runway's type-4 pavement keeps ONE continuous path. A genuinely-new taxiway
    // (no parentOsm) gets a fresh OsmId.
    const segOsm = seg.parentOsm != null ? seg.parentOsm : allocSegOsm();
    const segEntry = _synthesizeSegment(seg, id, segOsm, segNodeIds, s);
    if (segEntry) entries.push(segEntry);
  }

  // New stands: allocate a dense unique Identifier above the file's max, and
  // reference the newly-synthesized (or survivor) nose/tail/pushback node ids.
  const ss = _sampleStandShapes(pkEntries);
  let maxStand = 0;
  for (const e of pkEntries) {
    if (_entryTypePrefix(e) === 'stand') {
      const pk = _entryPk(e);
      const num = /^stand:(\d+)$/.exec(pk);
      if (num) { const n = parseInt(num[1], 10); if (n > maxStand) maxStand = n; }
    }
  }
  let nextStand = maxStand + 1;
  for (let st = 0; st < graph.stands.length; st++) {
    const pk = meta.standOrigPk ? meta.standOrigPk[st] : null;
    if (pk != null) continue; // survivor kept verbatim
    const stand = graph.stands[st];
    const ident = String(nextStand++);
    const noseId = nodeIds[stand.noseIdx], tailId = nodeIds[stand.tailIdx];
    const pbIds = (stand.pushbackIdxs || []).map((i) => nodeIds[i]).filter((v) => v != null);
    if (noseId == null || tailId == null) {
      const w = { key: 'ground_painter_writer_new_stand_dropped', params: { ident, index: noseId == null ? stand.noseIdx : stand.tailIdx },
        text: 'dropped a new stand (' + ident + '): its nose/tail node no longer exists (index ' +
          (noseId == null ? stand.noseIdx : stand.tailIdx) + ')' };
      console.warn('[scenery_write] ' + w.text);
      if (warnings) warnings.push(w);
      continue;
    }
    const id = nextId;
    nextId += 2; // stand $id + PushbackLimitPositions wrapper $id
    const standEntry = _synthesizeStand(stand, id, ident, noseId, tailId, pbIds, ss);
    if (standEntry) entries.push(standEntry);
  }

  // New runways: emit a full pair (both directions) sharing one PhysicalRunwayStaticItem.
  const rs = _sampleRunwayShapes(pkEntries);
  const newPhysEntries = []; // for StaticItems
  for (let k = 0; k < graph.runways.length; k++) {
    const pk = meta.runwayOrigPk ? meta.runwayOrigPk[k] : null;
    if (pk != null) continue; // survivor kept verbatim (patched later if names changed)
    const rw = graph.runways[k];
    const thAId = nodeIds[rw.thAIdx], thBId = nodeIds[rw.thBIdx];
    if (thAId == null || thBId == null) continue;
    const pair = _synthesizeRunway(rw, nextId, thAId, thBId, rs, graph);
    // _synthesizeRunway allocates 19 ids (1 item + 2*9)
    const phys = (Array.isArray(rw.names) ? rw.names.join('/') : (rw.physicalName || '01/19'));
    const itemId = nextId; // first allocated is item
    newPhysEntries.push({ phys, itemId });
    nextId += 19;
    entries.push(pair[0], pair[1]);
  }

  return { entries, nodeIds, survivorNodeId, newPhysEntries, nextId };
}

/**
 * @param {string} snapshotText decoded ACL text
 * @param {Graph} graph id-free painter Graph
 * @param {Map<number,string>} blobTypeMap
 * @param {object} [meta] { nodeOrigPk, segOrigPk, runwayOrigPk, areaOrigId, standOrigPk }
 * @returns {string} updated ACL text (no disk I/O)
 */
// ─── New-area synthesis (NonPK) ───────────────────────────────────

function _sampleAreaShapes(npkEntries) {
  const s = { areaType: null, rpType: null, listType: null, vecType: null };
  const area = npkEntries.find((e) => e.includes('ContextCross.Models.Area'));
  if (area) {
    const rawArea = _valueOf(area, '$type');
    s.areaType = _isCorruptType(rawArea) ? null : rawArea;
    const rp = area.match(/"NodePositions":\s*\{[^{]*?"\$type":\s*("[^"]+"|\d+)/);
    const rawRp = rp ? rp[1] : null;
    s.rpType = _isCorruptType(rawRp) ? null : rawRp;
    // The inner List object is "{ $id, $type, $rlength, ... }" — the `$id`
    // wrapper precedes `$type`, so a regex that requires `$type` to be the first
    // key fails and the sampled type degrades to `$fmtType(null) === "0"`, which
    // Unity resolves to the wrong type and throws "Invalid Area static entity".
    const list = area.match(/\{\s*(?:"\$id"\s*:\s*\d+\s*,\s*)?"\$type":\s*("[^"]+"|\d+),\s*"\$rlength"/);
    const rawList = list ? list[1] : null;
    s.listType = _isCorruptType(rawList) ? null : rawList;
    const v = area.match(/"\$type":\s*("[^"]+"|\d+),\s*-?[\d.eE+]+,\s*-?[\d.eE+]+/);
    const rawV = v ? v[1] : null;
    s.vecType = _isCorruptType(rawV) ? null : rawV;
    if (!s.vecType) s.vecType = '5';
  }
  // Fallbacks so `_fmtType` never emits `$type: 0` (a bogus reference to the
  // ArchiveHeader type) — this is what makes Unity reject a new Area as an
  // "Invalid Area static entity". Only used when there is no existing Area to
  // sample (e.g. adding the first Area to a file with none).
  if (!s.areaType || _isCorruptType(s.areaType)) s.areaType = '"31|ContextCross.Models.Area, GroundATC.Core"';
  if (!s.rpType || _isCorruptType(s.rpType)) s.rpType = '"32|R3.ReactiveProperty`1[[System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib]], R3"';
  if (!s.listType || _isCorruptType(s.listType)) s.listType = '"33|System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib"';
  if (!s.vecType || _isCorruptType(s.vecType)) s.vecType = '5';
  return s;
}

function _synthesizeArea(area, id, s) {
  const rpId = id + 1, listId = id + 2;
  const pts = area.points || [];
  const ptsStr = pts.map((p) => '{ "$type": ' + _fmtType(s.vecType) + ', ' + _fmtNum(p.x) + ', 0, ' + _fmtNum(p.z) + ' }').join(', ');
  return '{ "$id": ' + id + ', "$type": ' + _fmtType(s.areaType) +
    ', "NodePositions": { "$id": ' + rpId + ', "$type": ' + _fmtType(s.rpType) +
    ', { "$id": ' + listId + ', "$type": ' + _fmtType(s.listType) +
    ', "$rlength": ' + pts.length + ', "$rcontent": [ ' + ptsStr + ' ] } }, ' +
    '"AreaType": ' + (area.areaType ?? 1) + ', "Enabled": true }';
}

// ─── Area (NonPK) entry point reading / patching ─────────────────
// Locate the NodePositions.$rcontent array range within an Area entry.
function _areaRcontentRange(entry) {
  const t = createTokenizer(entry);
  const np = t.findSection('NodePositions');
  if (!np) return null;
  const npText = entry.substring(np.valueStart, np.valueEnd);
  const npT = createTokenizer(npText);
  const rc = npT.findSection('$rcontent');
  if (!rc) return null;
  if (npText[rc.valueStart] !== '[') return null;
  const rcEnd = npT.findArrayEnd(rc.valueStart);
  if (!rcEnd) return null;
  return { npStart: np.valueStart, npEnd: np.valueEnd, npText, rcStart: rc.valueStart, rcEnd };
}

// Parse a Vec3 block `{ "$type": N|"N|Name", x, y, z }` → [x, y, z].
function _areaVec3(block) {
  let numText = block;
  const typeIdx = numText.indexOf('"$type"');
  if (typeIdx >= 0) {
    const colon = numText.indexOf(':', typeIdx);
    if (colon >= 0) {
      let after = colon + 1;
      while (after < numText.length && ' \t\n\r'.includes(numText[after])) after++;
      if (after < numText.length && numText[after] === '"') {
        const qEnd = numText.indexOf('"', after + 1);
        if (qEnd >= 0) after = qEnd + 1;
      } else {
        while (after < numText.length && numText[after] >= '0' && numText[after] <= '9') after++;
      }
      while (after < numText.length && ' \t\n\r'.includes(numText[after])) after++;
      if (after < numText.length && numText[after] === ',') after++;
      numText = numText.substring(after);
    }
  }
  let s = 0, e = numText.length;
  while (s < e && ' \t\n\r,'.includes(numText[s])) s++;
  while (e > s && ' \t\n\r,'.includes(numText[e - 1])) e--;
  const parts = numText.substring(s, e).split(',').map((p) => parseFloat(p.trim()));
  return (parts.length >= 3 && parts.slice(0, 3).every((p) => !isNaN(p))) ? parts : null;
}

// Read an Area entry's NodePositions.$rcontent into [{x, z, ...}].
function _areaEntryPoints(entry) {
  const r = _areaRcontentRange(entry);
  if (!r) return null;
  const arrText = r.npText.substring(r.rcStart + 1, r.rcEnd);
  const pts = [];
  let i = 0;
  while (i < arrText.length) {
    while (i < arrText.length && arrText[i] !== '{') i++;
    if (i >= arrText.length) break;
    const objStart = i;
    let depth = 1; i++;
    while (i < arrText.length && depth > 0) {
      if (arrText[i] === '{') depth++;
      else if (arrText[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) break;
    const vals = _areaVec3(arrText.substring(objStart, i));
    if (vals) pts.push({ x: vals[0], z: vals[2] });
  }
  return pts;
}

// Sample just the Vector3 `$type` from a specific Area entry (used when
// re-emitting moved vertices so the ambient type number stays exact).
function _areaEntryVecType(entry) {
  const m = entry.match(/"\$type":\s*("[^"]+"|\d+),\s*-?[\d.eE+]+,\s*-?[\d.eE+]+/);
  return m ? m[1] : '5';
}

// Patch an Area entry's NodePositions.$rcontent with new points, preserving the
// wrapper $ids/$types and updating $rlength to the new count. Mirrors the
// shape emitted by _synthesizeArea so the graph parser reads it back identically.
function _patchAreaPoints(entry, pts, vecType) {
  const r = _areaRcontentRange(entry);
  if (!r) return entry;
  const ptsStr = pts.map((p) => '{ "$type": ' + _fmtType(vecType) + ', ' + _fmtNum(p.x) + ', 0, ' + _fmtNum(p.z) + ' }').join(', ');
  const newRc = '[' + ptsStr + ']';
  let npText = r.npText.slice(0, r.rcStart) + newRc + r.npText.slice(r.rcEnd);
  // Keep $rlength in lockstep with the new count (unchanged for a pure move;
  // updated defensively if a vertex was added/removed).
  npText = npText.replace(/("\$rlength"\s*:\s*)\d+/, '$1' + pts.length);
  return entry.slice(0, r.npStart) + npText + entry.slice(r.npEnd);
}

function _patchRunwayEntry(entry, oldName, newName, oldPhys, newPhys, newWidth) {
  let out = entry;
  // $k: "runway:OLD" -> "runway:NEW"
  if (oldName != null && newName != null && oldName !== newName) {
    out = out.replace('"black"','"black"'); // no-op to avoid empty
    const kRe = new RegExp('("\\$k"\\s*:\\s*")runway:' + oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"');
    // fallback generic: replace first runway:*
    if (kRe.test(out)) out = out.replace(kRe, '$1runway:' + newName + '"');
    else out = out.replace(/("\$k"\s*:\s*"runway:)[^"]+"/, '$1' + newName + '"');
  }
  // Inside $v: "Name": "OLD" -> "NEW" (first occurrence after $k)
  if (oldName != null && newName != null && oldName !== newName) {
    // Replace the first "Name": "OLD" after $k
    let idx = out.indexOf('"Name"');
    if (idx >= 0) {
      const before = out.slice(0, idx);
      const after = out.slice(idx);
      const re = new RegExp('("Name"\\s*:\\s*")' + oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"');
      const replaced = after.replace(re, '$1' + newName + '"');
      if (replaced !== after) out = before + replaced;
    }
  }
  // PhysicalName inside inline PhysicalRunwayStaticItem
  if (oldPhys != null && newPhys != null && oldPhys !== newPhys) {
    const physRe = new RegExp('("PhysicalName"\\s*:\\s*")' + oldPhys.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"');
    if (physRe.test(out)) out = out.replace(physRe, '$1' + newPhys + '"');
  }
  // Width
  if (newWidth != null) {
    const wRe = /("Width"\s*:\s*)[-\d.eE+]+/;
    if (wRe.test(out)) out = out.replace(wRe, '$1' + _fmtNum(newWidth));
  }
  return out;
}

// ─── Checkpoint-frame physical-runway reconciliation ────────────
//
// A GATCARC4 `.acl` can be a multi-segment archive: a header document plus zero
// or more "$$$ GATCARC4 CHECKPOINT FRAME $$$" segments. Each segment is an
// independent Odin `$blobdoc`. The checkpoint frame snapshots the RUNTIME state
// (RuntimeData.$blobdoc.RuntimeEntities), which includes a `PhysicalRunway`
// runtime entity for every physical runway, keyed `physical-runway:XX/YY`.
//
// When the Ground Painter deletes or renames a runway, `patchSceneryBlob`
// rebuilds the header's STATIC `StaticData.$blobdoc.StaticItems` (removing /
// renaming the `physical-runway:*` dictionary entries), but the checkpoint
// frame keeps a `PhysicalRunway` runtime entity whose static-item key no longer
// exists. Unity reconciles RuntimeEntities against StaticItems on load and
// throws:
//
//   "PhysicalRunway: static item 'physical-runway:XX/YY' does not exist in
//    CurrentLevel.StaticField.StaticItems"   (reference integrity is broken)
//
// We reconcile every segment's RuntimeEntities.$rcontent against the set of
// static runtime-entity keys that currently exist: orphaned entries (whose key
// is not in `validKeys`) are removed; entries remapped by `patchMap`
// (old → new key, from a static rename) get their `$k` rewritten so the runtime
// snapshot follows the static rename.
//
// `validKeys` is a Set of `<prefix>:` keys derived from the final STATIC
// StaticItems. `prefix` is the entry-type prefix this reconciler owns
// (e.g. 'physical-runway', 'jetway'). `patchMap` is optional (old → new key).
// A single segment is reconciled against one or more reconcilers so a checkpoint
// frame can clean up both stale physical-runway AND stale jetway runtime
// entities in one pass.
function _reconcileRuntimeSegment(segText, reconciles) {
  const t = createTokenizer(segText);
  const reSec = t.findSection('RuntimeEntities');
  if (!reSec) return segText;
  const reText = t.substring(reSec.valueStart, reSec.valueEnd);
  const reT = createTokenizer(reText);
  const rcSec = reT.findSection('$rcontent');
  if (!rcSec) return segText;
  const rcStart = rcSec.valueStart;
  if (reText[rcStart] !== '[') return segText;
  const rcEnd = reT.findArrayEnd(rcStart);
  if (rcEnd === null) return segText;

  // Positions in reText space; map back to segText via segStart offset.
  const segStart = reSec.valueStart;
  const beforeRc = segText.substring(0, segStart + rcStart + 1); // up to & incl '['
  const content = reText.substring(rcStart + 1, rcEnd - 1);
  const afterRc = segText.substring(segStart + rcEnd - 1);       // from ']' on
  const contentT = createTokenizer(content);

  const entries = [];
  let pos = 0;
  while (pos < content.length) {
    while (pos < content.length && ' \t\n\r'.includes(content[pos])) pos++;
    if (pos >= content.length) break;
    if (content[pos] === ',') { pos++; continue; }
    if (content[pos] !== '{') { pos++; continue; }
    const entryEnd = contentT.findObjectEnd(pos);
    if (entryEnd === null) break;
    const entryText = content.substring(pos, entryEnd);
    const entryT = createTokenizer(entryText);
    const kSec = entryT.findSection('$k');
    let modifiedEntry = entryText;
    let isOrphan = false;
    let nameChanged = false;
    let finalKey = null;
    if (kSec) {
      const kStrEnd = entryT.skipString(kSec.valueStart);
      if (kStrEnd) {
        const key = entryText.substring(kSec.valueStart + 1, kStrEnd - 1);
        for (const rec of reconciles) {
          // Only the reconciler that owns this entry type acts on it.
          if (!key.startsWith(rec.prefix + ':')) continue;
          if (rec.patchMap && rec.patchMap.has(key)) {
            // Rename follows the static rename so the runtime snapshot stays
            // valid (e.g. physical-runway:01/19 → physical-runway:04/22).
            modifiedEntry =
              entryText.substring(0, kSec.valueStart + 1) + rec.patchMap.get(key) +
              entryText.substring(kStrEnd - 1);
            nameChanged = modifiedEntry !== entryText;
            finalKey = rec.patchMap.get(key);
          } else if (!rec.validKeys.has(key)) {
            // Static item was deleted: this runtime entity is now a dangling
            // reference → drop it.
            isOrphan = true;
            finalKey = key;
          } else {
            finalKey = key;
          }
          break;
        }
      }
    }
    entries.push({ text: modifiedEntry, orphan: isOrphan, nameChanged, key: finalKey });
    pos = entryEnd;
  }

  // Keys that will remain in the runtime snapshot after reconciliation.
  const presentKeys = new Set();
  for (const e of entries) if (!e.orphan && e.key) presentKeys.add(e.key);
  const kept0 = entries.filter((e) => !e.orphan);

  // Add MISSING runtime entities for reconcilers that request it (e.g. a
  // physical runway that is registered in StaticItems but has no matching
  // `PhysicalRunway` runtime entity in the checkpoint frame). Unity reconciles
  // RuntimeEntities against StaticItems on load; a runnable runway without a
  // runtime entity is a silent gap (no persisted `_latestDepartureRoll`), so we
  // synthesize one to keep the snapshot consistent with the static registry.
  // `addMissing` is opt-in: only physical-runway enables it, never jetway (per
  // stand), to avoid fabricating entities the game expects to own.
  const adds = [];
  let nextId = 0;
  for (const rec of reconciles) {
    if (!rec.addMissing) continue;
    // Sample the runtime `$type` from an existing <prefix> runtime entity so we
    // reproduce the game's own type string; default to the canonical
    // PhysicalRunway type when the checkpoint frame has none yet.
    let sampleType = null;
    for (const e of entries) {
      if (e.orphan || !e.key || !e.key.startsWith(rec.prefix + ':')) continue;
      const tm = e.text.match(/"\$v"\s*:\s*\{[^{}]*?"\$type"\s*:\s*("[^"]+"|\d+)/);
      if (tm) { sampleType = tm[1]; break; }
    }
    if (!sampleType) sampleType = '"3|ContextCross.Models.PhysicalRunway, GroundATC.Core"';
    if (nextId === 0) {
      // Allocate fresh runtime ids above every id already declared in this
      // RuntimeEntities blobdoc (its own id space).
      let maxId = 0;
      const idRe = /"\$id"\s*:\s*(\d+)/g;
      let im;
      while ((im = idRe.exec(reText)) !== null) {
        const nid = parseInt(im[1], 10);
        if (nid > maxId) maxId = nid;
      }
      nextId = maxId + 1;
    }
    for (const key of rec.validKeys) {
      if (presentKeys.has(key)) continue;
      adds.push('{ "$k": "' + key + '", "$v": { "$id": ' + nextId + ', "$type": ' + sampleType + ', "_latestDepartureRoll": null } }');
      nextId++;
    }
  }

  const kept = kept0.map((e) => e.text).concat(adds);
  const removed = entries.length - kept0.length;
  const renamed = entries.some((e) => e.nameChanged);
  const addedCount = adds.length;
  if (removed === 0 && !renamed && addedCount === 0) return segText;

  const newContent = kept.join(',\n');
  let newBeforeRc = beforeRc;
  if (removed > 0 || addedCount > 0) {
    const rlSec = reT.findSection('$rlength');
    if (rlSec) {
      const oldRlen = parseInt(reText.substring(rlSec.valueStart, rlSec.valueEnd), 10);
      const newRlen = Math.max(0, oldRlen - removed + addedCount);
      const rlStartF = segStart + rlSec.valueStart;
      const rlEndF = segStart + rlSec.valueEnd;
      newBeforeRc = beforeRc.substring(0, rlStartF) + String(newRlen) + beforeRc.substring(rlEndF);
    }
  }
  return newBeforeRc + newContent + afterRc;
}

function _reconcileRuntimeFrames(text, reconciles) {
  if (!text) return text;
  const separator = /\r?\n\$\$\$ GATCARC4 CHECKPOINT FRAME \$\$\$\r?\n/;
  const sentinelMatch = text.match(separator);
  if (!sentinelMatch) {
    // No checkpoint frame → nothing to reconcile (fast path).
    return text;
  }
  const exactSentinel = sentinelMatch[0];
  const parts = text.split(separator);
  let changed = false;
  const out = parts.map((part) => {
    const next = _reconcileRuntimeSegment(part, reconciles);
    if (next !== part) changed = true;
    return next;
  });
  return changed ? out.join(exactSentinel) : text;
}

// Reconcile the checkpoint frame against the static physical-runway key set.
// Kept as a dedicated wrapper (used by tests and callers that only care about
// runway renames/deletes).
function _reconcilePhysicalRunwayFrames(text, validPhysKeys, physPatchMap) {
  return _reconcileRuntimeFrames(text, [
    { prefix: 'physical-runway', validKeys: validPhysKeys, patchMap: physPatchMap || null },
  ]);
}

// Reconcile the checkpoint frame against the static jetway key set. Called on
// every save path so a deleted stand's orphaned jetway runtime entity is dropped
// from the checkpoint frame — otherwise Unity throws "Jetway: static item
// 'jetway:NN' does not exist in CurrentLevel.StaticField.StaticItems".
function _reconcileJetwayFrames(text, validJetwayKeys) {
  return _reconcileRuntimeFrames(text, [
    { prefix: 'jetway', validKeys: validJetwayKeys, patchMap: null },
  ]);
}

// Build the full reconciler list for a checkpoint frame: physical-runway (with
// the optional rename map) plus jetway. Callers pass the FINAL static entries so
// both staleness classes are cleaned in one pass.
function _runtimeReconcilers(siEntries, physPatchMap) {
  return [
    // physical-runway: also ADD a runtime PhysicalRunway entity for every
    // registered physical runway that lacks one (a runway added/renamed by the
    // painter would otherwise have no checkpoint-frame runtime snapshot).
    { prefix: 'physical-runway', validKeys: _physKeysFromEntries(siEntries), patchMap: physPatchMap || null, addMissing: true },
    { prefix: 'jetway', validKeys: _jetwayKeysFromEntries(siEntries), patchMap: null },
  ];
}

// ─── Runway-name reference cascade (rename) ─────────────────────
//
// When a runway end is renamed (e.g. `01` → `01C`, `19` → `19C`), the runway
// entity itself is patched by `_patchRunwayEntry` and the physical-runway
// StaticItems/checkpoint keys are handled above — but flight plans, aircraft and
// the initial-runway configuration reference the runway by its end NAME string,
// and those go stale, which makes the game's dynamic-flight engine throw a
// NullReferenceException on load ("Dynamics: RestoreRuntimeData").
//
// We remap every runway-name STRING field whose value equals a renamed old end
// name. A field is treated as a runway-name field when its key contains "Runway"
// or "RWY" (case-insensitive) — this covers `"Runway"`, `"RelatedRunway"`,
// and the aircraft runtime `"_departureRunway"`/`"_arrivalRunway"`, while
// skipping object values (`PhysicalRunwayStaticItem`, `RunwayTimeline`,
// `InitialRunways`) and non-runway fields (stand ids, `Name`/`Identifier`,
// dictionary `comparer` keys that mix runway and stand names).
function _remapRunwayNameFields(text, oldNameToNewName) {
  if (!text || !oldNameToNewName || oldNameToNewName.size === 0) return text;
  let out = text;
  for (const [oldName, newName] of oldNameToNewName) {
    const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lead = newName.replace(/[$\\]/g, '\\$&');
    out = out.replace(
      new RegExp('("(?:[^"]*[Rr]unway[^"]*|[^"]*RWY[^"]*)"\\s*:\\s*")' + esc + '(")', 'g'),
      (m, p1) => p1 + lead + '"'
    );
    // InitialRunways: a System.String[] of runway end names ("$rcontent": [ ... ]).
    out = out.replace(
      /("InitialRunways"\s*:\s*\{[^{}]*?"\$rcontent"\s*:\s*\[)([^\]]*)(\])/g,
      (m, pre, body, post) => {
        const newBody = body.replace(new RegExp('"' + esc + '"', 'g'), '"' + lead + '"');
        return newBody === body ? m : pre + newBody + post;
      }
    );
  }
  return out;
}

// ─── Taxiway runway-name coupling (rename/move cascade) ─────────
//
// A level's physical runway is drawn NOT only as `runway:*` / `physical-runway:*`
// entries but also as a set of `taxiway-segment` pavement strips whose `Name`
// field is the runway's PHYSICAL name (e.g. "01/19"). Verified in ZSJN: runway
// `01/19` is coupled to 9 `taxiway-segment` entries whose `Name` === "01/19".
// Flight plans / aircraft reach a runway by END name ("01"/"19", handled by
// `_remapRunwayNameFields`), but these pavement strips are named by the whole
// physical pair, so a runway rename/move must also rewrite the taxiway `Name`
// fields or the strips keep pointing at the old physical runway.
//
// `physNameMap` = oldPhysicalName → newPhysicalName (e.g. "01/19" → "19R/01L").
// `endNameMap` = oldEndName → newEndName (e.g. "01" → "01L"), applied as a
// fallback for the (rare) taxiway named after a single end. Match is exact
// against the whole `Name` string value, so end names never trim a physical
// "01/19" (that would need a substring match which we intentionally avoid).
function _remapTaxiwaySegmentName(entry, physNameMap, endNameMap) {
  if ((!physNameMap || physNameMap.size === 0) && (!endNameMap || endNameMap.size === 0)) return entry;
  if (_entryTypePrefix(entry) !== 'taxiway-segment') return entry;
  const t = createTokenizer(entry);
  const nameSec = t.findSection('Name');
  if (!nameSec) return entry;
  const cur = entry.substring(nameSec.valueStart, nameSec.valueEnd).trim();
  if (!cur.startsWith('"')) return entry;
  const name = cur.slice(1, -1);
  if (physNameMap && physNameMap.has(name)) {
    const newName = physNameMap.get(name);
    return entry.slice(0, nameSec.valueStart) + JSON.stringify(newName) + entry.slice(nameSec.valueEnd);
  }
  if (endNameMap && endNameMap.has(name)) {
    const newName = endNameMap.get(name);
    return entry.slice(0, nameSec.valueStart) + JSON.stringify(newName) + entry.slice(nameSec.valueEnd);
  }
  return entry;
}

// ─── Stand / taxiway Name read + patch ──────────────────────────
// A user-entered Name on an EXISTING (survivor) stand or taxiway-segment must be
// written back. Survivors are otherwise preserved verbatim (so sub-fields the
// Graph does not model stay intact), so the Name field is patched in place, or —
// when the entry carries no Name at all — inserted in its canonical position
// (taxiway-segment: between `PK` and `OsmId`; stand: between `EgressType` and
// `Identifier`), matching the Odin positional field order.

// Read the top-level `"Name"` string value of a managed entry ("" when absent).
function _entryNameValue(entry) {
  const t = createTokenizer(entry);
  const sec = t.findSection('Name');
  if (!sec) return '';
  const val = entry.substring(sec.valueStart, sec.valueEnd).trim();
  if (val === 'null') return ''; // `"Name": null` — treat as empty (matches the reader)
  if (val.startsWith('"')) {
    try { return JSON.parse(val); } catch (_) { return val.slice(1, -1); }
  }
  return val;
}

// Insert `insertStr` (a `"Key": <val>` literal) in the object immediately before
// the direct child field named `key`. Used to add a missing Name field without
// disturbing the surrounding commas.
function _insertBeforeField(entry, key, insertStr) {
  const t = createTokenizer(entry);
  const sec = t.findSection(key);
  if (!sec) return entry;
  const keyStr = '"' + key + '"';
  const before = entry.slice(0, sec.valueStart);
  const kIdx = before.lastIndexOf(keyStr);
  if (kIdx < 0) return entry;
  return entry.slice(0, kIdx) + insertStr + ', ' + entry.slice(kIdx);
}

// Patch (or insert) the top-level `Name` field of a managed entry to `newName`.
function _patchEntryName(entry, newName) {
  const lit = JSON.stringify(String(newName));
  const t = createTokenizer(entry);
  const sec = t.findSection('Name');
  if (sec) {
    return entry.slice(0, sec.valueStart) + lit + entry.slice(sec.valueEnd);
  }
  const prefix = _entryTypePrefix(entry);
  const insertKey = prefix === 'stand' ? 'Identifier' : 'OsmId';
  return _insertBeforeField(entry, insertKey, '"Name": ' + lit);
}

// ─── Taxiway-segment ordinal renumbering ────────────────────────
// Unity requires each taxiway visual path (all taxiway-segment entries sharing
// one OsmId) to have CONTIGUOUS ordinals starting at 0 in its
// "taxiway-segment:<osm>:<ord>" key. When the painter deletes ONE segment of a
// multi-segment taxiway, the surviving siblings keep their old ordinals and
// leave a gap (e.g. "1481:1..21" after "1481:0" is removed), which Unity rejects
// with "non-contiguous ordinal N; expected M". Rewrite the $k/PK ordinal of each
// surviving entry, grouped by osm and ordered by the CURRENT ordinal (which
// encodes the path's segment sequence), back to 0..N-1.
function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Order one OsmId's taxiway-segment entries along the connected path, so the
// renumber below can assign ordinals that encode the path's segment sequence.
// A visual path is a polyline chain: consecutive entries must share an endpoint
// node. We walk from a terminus (an endpoint node only one entry touches), then
// repeatedly attach the next entry sharing the current junction node. This places
// auto-slice SPLIT PIECES back at their correct position in the parent strip's
// chain (they otherwise all carry ordinal 0 and would sort to the front, breaking
// continuity). Falls back to the current ordinal order when the group cannot be
// walked as one chain (cycle / disconnected / branching).
function _orderSegmentsForPath(list) {
  if (list.length <= 1) return list;
  const endpoints = list.map((it) => {
    const irefs = extractIrefArray(it.entry, 'Nodes');
    if (irefs.length >= 2) return [irefs[0], irefs[irefs.length - 1]];
    return irefs.length === 1 ? [irefs[0], irefs[0]] : [null, null];
  });
  const adj = new Map(); // node -> [itemIdx]
  for (let i = 0; i < list.length; i++) {
    const [a, b] = endpoints[i];
    for (const nd of [a, b]) {
      if (nd == null) continue;
      if (!adj.has(nd)) adj.set(nd, []);
      adj.get(nd).push(i);
    }
  }
  // Find a terminus (an entry whose first or last node is touched by no other entry).
  let start = -1;
  for (let i = 0; i < list.length; i++) {
    const [a, b] = endpoints[i];
    if ((a != null && (adj.get(a) || []).length === 1) || (b != null && (adj.get(b) || []).length === 1)) { start = i; break; }
  }
  if (start === -1) start = 0;
  const used = new Set([start]);
  const ordered = [list[start]];
  const [sa, sb] = endpoints[start];
  let curNode;
  if (sa != null && (adj.get(sa) || []).length === 1) curNode = sb; // continue from the non-terminus end
  else if (sb != null && (adj.get(sb) || []).length === 1) curNode = sa;
  else curNode = sa ?? sb;
  while (ordered.length < list.length) {
    let next = -1, nextNode = null;
    for (let j = 0; j < list.length; j++) {
      if (used.has(j)) continue;
      const [a, b] = endpoints[j];
      if (a === curNode) { next = j; nextNode = b; break; }
      if (b === curNode) { next = j; nextNode = a; break; }
    }
    if (next === -1) break;
    used.add(next);
    ordered.push(list[next]);
    curNode = nextNode;
  }
  // Append anything not reached (disconnected group / cycle) in original order.
  for (let j = 0; j < list.length; j++) if (!used.has(j)) ordered.push(list[j]);
  return ordered;
}

function _renumberTaxiwaySegmentOrdinals(entries) {
  const groups = new Map(); // osm -> [{ entry, pk, oldOrd }]
  for (const e of entries) {
    const pk = _entryPk(e);
    if (!pk) continue;
    const m = /^taxiway-segment:(-?\d+):(\d+)$/.exec(pk);
    if (!m) continue;
    const osm = m[1];
    const oldOrd = parseInt(m[2], 10);
    if (!groups.has(osm)) groups.set(osm, []);
    groups.get(osm).push({ entry: e, pk, oldOrd, osm });
  }
  let changed = false;
  const newPkByEntry = new Map();
  for (const list of groups.values()) {
    // Order by chain position, so a reinserted split piece lands at its true spot
    // in the visual path (falling back to current ordinal for unbroken chains,
    // which are already in path order — no change).
    const ordered = _orderSegmentsForPath(list);
    for (let i = 0; i < ordered.length; i++) {
      const it = ordered[i];
      if (it.oldOrd !== i) {
        newPkByEntry.set(it.entry, 'taxiway-segment:' + it.osm + ':' + i);
        changed = true;
      }
    }
  }
  if (!changed) return entries;
  const out = [];
  for (const e of entries) {
    const newPk = newPkByEntry.get(e);
    if (!newPk) { out.push(e); continue; }
    // The pk string appears both as the Odin "$k" and inside "$v" as "PK";
    // rewriting both keeps the runtime's mirrored key in sync.
    out.push(e.replace(new RegExp(_escapeRe(_entryPk(e)), 'g'), newPk));
  }
  return out;
}

function patchSceneryBlob(snapshotText, graph, blobTypeMap, meta, opts) {
  // Optional sink for non-fatal problems (e.g. an entity dropped because its
  // node references no longer resolve). Callers that pass `{ warnings: [] }` get
  // a human-readable list back so the drop is visible instead of silent.
  const warnings = (opts && opts.warnings) || null;
  const ranges = _staticEntitiesRanges(snapshotText);
  if (!ranges) throw new Error('[scenery_write] could not locate PK/NonPK static entities');

  const pkArrayValue = snapshotText.substring(ranges.pkRc.start, ranges.pkRc.end);
  const npkArrayValue = snapshotText.substring(ranges.npkRc.start, ranges.npkRc.end);
  let pkEntries = _splitArrayEntries(pkArrayValue);
  // Canonical type-group order for THIS file (measured first-appearance). New
  // entities regroup into their type's block on save (see _regroupPkByType).
  const pkTypeOrder = _pkTypeOrder(pkEntries);
  const npkEntries = _splitArrayEntries(npkArrayValue);
  // StaticItems: physical-runway registry (may be absent in some files, but present for ZSJN)
  let siEntries = [];
  let siArrayValue = null;
  if (ranges.siRc) {
    siArrayValue = snapshotText.substring(ranges.siRc.start, ranges.siRc.end);
    siEntries = _splitArrayEntries(siArrayValue);
  }

  const mm = meta || {};
  const deletedPks = mm.deletedPks ? new Set(mm.deletedPks) : new Set();
  const deletedAreaIds = mm.deletedAreaIds ? new Set(mm.deletedAreaIds) : new Set();

  const hasNew = _hasNull(mm.nodeOrigPk) || _hasNull(mm.segOrigPk) ||
    _hasNull(mm.runwayOrigPk) || _hasNull(mm.standOrigPk) ||
    _hasNull(mm.areaOrigId) ||
    _arrayLongerThan(mm.nodeOrigPk, graph.nodes) ||
    _arrayLongerThan(mm.segOrigPk, graph.segments) ||
    _arrayLongerThan(mm.runwayOrigPk, graph.runways) ||
    _arrayLongerThan(mm.standOrigPk, graph.stands) ||
    _arrayLongerThan(mm.areaOrigId, graph.areas);

  // ---- Runway reconciliation: expected physical set from graph ----
  const expectedRunwayPks = new Set();
  const expectedPhysicalSet = new Set();
  for (const rw of graph.runways || []) {
    let names, phys;
    if (Array.isArray(rw.names) && rw.names.length >= 2) {
      names = rw.names; phys = rw.physicalName || names.join('/');
    } else {
      const parts = (rw.physicalName || '').split('/');
      const n1 = rw.name || parts[0] || '01';
      const n2 = parts[1] || (n1 === '01' ? '19' : '01');
      names = [n1, n2]; phys = n1 + '/' + n2;
    }
    expectedRunwayPks.add('runway:' + names[0]);
    expectedRunwayPks.add('runway:' + names[1]);
    expectedPhysicalSet.add(phys);
    // Also add physical with slash variants? Keep as is.
  }
  // Detect runway name/width changes for survivors
  let runwayDirty = false;
  const runwayPatchInfo = new Map(); // oldPk -> { newName, oldPhys, newPhys, newWidth }
  const physPatchMap = new Map(); // oldPhysPk -> newPhysPk
  if (mm.runwayOrigInfo && Array.isArray(mm.runwayOrigInfo)) {
    for (let i = 0; i < graph.runways.length && i < mm.runwayOrigInfo.length; i++) {
      const orig = mm.runwayOrigInfo[i];
      const cur = graph.runways[i];
      if (!orig || !cur) continue;
      // Skip new runways (orig pk null)
      const isNew = (mm.runwayOrigPk && mm.runwayOrigPk[i] == null);
      if (isNew) continue;
      const origNames = orig.names || [];
      const curNames = Array.isArray(cur.names) ? cur.names : [(cur.name || ''), (cur.physicalName || '').split('/')[1] || ''];
      const origPhys = orig.physicalName;
      const curPhys = cur.physicalName || origPhys;
      const widthChanged = cur.width != null && orig.width != null && Math.abs(cur.width - orig.width) > 1e-9;
      const namesChanged = curNames[0] !== origNames[0] || curNames[1] !== origNames[1] || origPhys !== curPhys;
      if (namesChanged || widthChanged) runwayDirty = true;
      if (origPhys !== curPhys) physPatchMap.set('physical-runway:' + origPhys, 'physical-runway:' + curPhys);
      // Map old PKs to new names
      // orig.pks contains old PK strings like runway:01, runway:19
      for (const oldPk of orig.pks || []) {
        const oldName = oldPk.split(':')[1];
        let newName = null;
        if (oldName === origNames[0]) newName = curNames[0];
        else if (oldName === origNames[1]) newName = curNames[1];
        else {
          // fallback positional
          const idx = (orig.pks || []).indexOf(oldPk);
          newName = curNames[idx] || curNames[0];
        }
        runwayPatchInfo.set(oldPk, { oldName, newName, oldPhys: origPhys, newPhys: curPhys, newWidth: cur.width });
      }
    }
  } else {
    // Fallback when origInfo missing: detect via PK array
    // No patching, just keep as is
  }
  // Build old→new END-name map for the runway-name reference cascade (flight
  // plan `Runway`, aircraft `RelatedRunway`). Also build an old→new PHYSICAL-name
  // map for the taxiway-segment strips that are named after the whole physical
  // runway pair (verified pattern: runway 01/19 ↔ taxiway segments named "01/19").
  // Only end-names / physical-names that actually changed are remapped — every
  // other field (stand ids, dict comparer keys, entity self `Name`/`Identifier`)
  // is deliberately left untouched.
  const oldNameToNewName = new Map();
  const oldPhysToNewPhys = new Map();
  for (const info of runwayPatchInfo.values()) {
    if (info.oldName && info.newName && info.oldName !== info.newName) {
      oldNameToNewName.set(info.oldName, info.newName);
    }
    if (info.oldPhys && info.newPhys && info.oldPhys !== info.newPhys) {
      oldPhysToNewPhys.set(info.oldPhys, info.newPhys);
    }
  }
  // Orphan detection for PK runways not in expected set (excluding patched survivors)
  const orphanRunwayPks = new Set();
  for (const e of pkEntries) {
    if (_entryTypePrefix(e) !== 'runway') continue;
    const pk = _entryPk(e);
    if (!expectedRunwayPks.has(pk) && !runwayPatchInfo.has(pk)) {
      orphanRunwayPks.add(pk);
    }
  }
  // For StaticItems physical-runway orphans (excluding patched)
  const orphanSiPks = new Set();
  const expectedSiPks = new Set([...expectedPhysicalSet].map((p) => 'physical-runway:' + p));
  for (const e of siEntries) {
    const pk = _entryPk(e);
    if (!pk || !pk.startsWith('physical-runway:')) continue;
    if (!expectedSiPks.has(pk) && !physPatchMap.has(pk)) orphanSiPks.add(pk);
  }
  // Consider orphan deletions as dirty
  const hasOrphanRunway = orphanRunwayPks.size > 0;
  const hasOrphanSi = orphanSiPks.size > 0;

  const pkDelete = pkEntries.filter((e) => {
    const prefix = _entryTypePrefix(e);
    if (!MANAGED_PK_TYPES.has(prefix)) return false;
    const pk = _entryPk(e);
    if (deletedPks.has(pk)) return true;
    if (prefix === 'runway' && orphanRunwayPks.has(pk)) {
      // Only delete orphan if it is not a patched survivor (i.e., not in runwayPatchInfo)
      if (!runwayPatchInfo.has(pk)) return true;
    }
    return false;
  });
  const npkDelete = npkEntries.filter((e) => {
    const id = _entryId(e);
    return id != null && deletedAreaIds.has(id);
  });

  // ── Referenced-node rescue (runway thresholds only) ──────────────
  // meta.deletedPks can mark a taxiway-node that a SURVIVING runway's
  // ThresholdPoints still references ($iref) — e.g. co-located sister entries
  // and rename cascades can flag the exact node entry a runway points at.
  // Deleting that node forces the survivor gate to drop the runway
  // (unrepairable threshold) — silently losing the runway and orphaning its
  // pavement strips. Only runway-referenced nodes are rescued here;
  // taxiway/stand refs are handled by _gateSurvivorDanglingRefs (rewire/excise/drop).
  {
    const delSet = new Set(pkDelete);
    for (let pass = 0; pass < 3; pass++) {
      const referenced = new Set();
      for (const e of pkEntries) {
        if (delSet.has(e) || !e.includes('$iref')) continue;
        if (_entryTypePrefix(e) !== 'runway') continue;
        for (const m of e.matchAll(/\$iref:\s*(\d+)/g)) referenced.add(parseInt(m[1], 10));
      }
      let rescued = 0;
      for (let i = pkDelete.length - 1; i >= 0; i--) {
        const idm = pkDelete[i].match(/"\$id"\s*:\s*(\d+)/);
        if (idm && referenced.has(parseInt(idm[1], 10))) {
          delSet.delete(pkDelete[i]);
          pkDelete.splice(i, 1);
          rescued++;
        }
      }
      if (rescued === 0) break;
    }
  }

  // Massive-deletion guard removed per user request (was: abort if
  // pkDelete > 40% of pkEntries to catch cross-level contamination).

  // ── Deletion reference cascade ────────────────────────────────────
  // Every `$id` declared by an entity removed in this patch becomes a dangling
  // reference target. Per §4.1 item 3 a deleted stand/taxiway/runway also drops
  // its `jetway:*` entries, so no jetway outlives the stand it serves. The
  // `taxi-navigation` graph is deliberately left intact (dropping a nav node
  // would also remove the shared sub-objects it declares, nuking the whole
  // graph); remaining nav references to deleted entities are reported by the
  // final validation pass below.
  const deletedIds = new Set();
  for (const e of pkDelete) for (const id of _idsInBlock(e)) deletedIds.add(id);
  for (const e of npkDelete) for (const id of _idsInBlock(e)) deletedIds.add(id);
  // Survivor gate: repair (rewire / excise) or drop every SURVIVOR taxiway
  // segment / stand that still references a deleted node — survivor entries
  // are copied verbatim, so without this the stale $iref reaches the .acl and
  // the game's TaxiwaySegment2DFactory null-derefs it on load. Runs before the
  // jetway cascade so a gate-dropped stand's jetways cascade too.
  const droppedRunwayPhys = new Set();
  const refGateDirty = _gateSurvivorDanglingRefs(pkEntries, pkDelete, deletedIds, warnings, droppedRunwayPhys);
  // A runway the gate dropped (unrepairable threshold) must vanish COMPLETELY:
  // cancel its registry rename and orphan both its old and new registry keys —
  // the name-based orphan scan above ran before the drop, so the keys would
  // otherwise survive and resolve to zero named runways ("must have exactly
  // two named runways, found 0").
  if (droppedRunwayPhys.size > 0) {
    for (const phys of droppedRunwayPhys) {
      const newPk = 'physical-runway:' + phys;
      for (const [oldPk, mappedPk] of [...physPatchMap]) {
        if (mappedPk === newPk) {
          physPatchMap.delete(oldPk);
          orphanSiPks.add(oldPk);
          // The graph-side strips may carry the POST-rename designation
          // (synthesized fillet pieces created after the rename) — suppress
          // both names so no orphan paint survives.
          const mappedPhys = mappedPk.match(/^physical-runway:(.+)$/);
          if (mappedPhys) droppedRunwayPhys.add(mappedPhys[1]);
        }
      }
      orphanSiPks.add(newPk);
    }
  }
  // Run the cascade to fix point, dropping every jetway entry referencing a
  // now-dead id, and use the filtered arrays.
  const cascaded = _cascadeOrphanEntries(pkEntries, siEntries, deletedIds);
  pkEntries = cascaded.pkEntries;
  siEntries = cascaded.siEntries;
  const dropCounts = cascaded.drop;

  // Detect moved survivors (node coordinates changed vs original entry).
  const nodeEntryByPk = new Map();
  for (const e of pkEntries) {
    if (_entryTypePrefix(e) === 'taxiway-node') nodeEntryByPk.set(_entryPk(e), e);
  }
  const movedByPk = new Map();
  // movedByCoord maps a node's ORIGINAL coordinate key -> its new position. The
  // graph DEDUPs nodes by coordinate (scenery_graph.coordKey), so when two ACL
  // entries share a coordinate (a junction where two segments each carry their
  // own node entry), rotating the graph node only moves the representative entry
  // (via movedByPk) and leaves the co-located sister entry stale. Moving a node
  // is a rigid translation of that LOCATION, so every entry at the same
  // original coordinate must move together. movedByCoord lets the rebuild patch
  // all of them.
  const movedByCoord = new Map();
  if (mm.nodeOrigPk && graph.nodes) {
    for (let g = 0; g < graph.nodes.length && g < mm.nodeOrigPk.length; g++) {
      const pk = mm.nodeOrigPk[g];
      if (pk == null) continue;
      const entry = nodeEntryByPk.get(pk);
      if (!entry) continue;
      const orig = extractVector3FromV4(entry);
      if (!orig) continue;
      const cur = graph.nodes[g];
      if (Math.abs(orig.x - cur.x) > 1e-9 || Math.abs(orig.z - cur.z) > 1e-9) {
        movedByPk.set(pk, { x: cur.x, z: cur.z });
        movedByCoord.set(_coordKey(orig.x, orig.z), { x: cur.x, z: cur.z });
      }
    }
  }

  // ── Detect Type/Flags changes for taxiway nodes (entrance/exit holdings) ──
  const typeChangedByPk = new Map();
  const flagsChangedByPk = new Map();
  let hasTypeChanges = false;
  {
    const nodeEntryByPkForType2 = new Map();
    for (const e of pkEntries) if (_entryTypePrefix(e) === 'taxiway-node') nodeEntryByPkForType2.set(_entryPk(e), e);
    if (mm.nodeOrigPk && graph.nodes) {
      for (let g = 0; g < graph.nodes.length && g < mm.nodeOrigPk.length; g++) {
        const pk = mm.nodeOrigPk[g];
        if (pk == null) continue;
        const entry = nodeEntryByPkForType2.get(pk);
        if (!entry) continue;
        let origType = extractIntFromV4(entry, 'Type');
        if (origType == null) {
          const m = entry.match(/"Type"\s*:\s*(\d+)/);
          if (m) origType = parseInt(m[1], 10);
        }
        const curType = graph.nodes[g].type;
        if (curType != null && origType !== curType) { typeChangedByPk.set(pk, curType); hasTypeChanges = true; }
        let origFlags = extractIntFromV4(entry, 'Flags');
        if (origFlags == null) {
          const m2 = entry.match(/"Flags"\s*:\s*(\d+)/);
          if (m2) origFlags = parseInt(m2[1], 10);
        }
        const curFlags = graph.nodes[g].flags;
        if (curFlags != null && origFlags !== curFlags) { flagsChangedByPk.set(pk, curFlags); hasTypeChanges = true; }
      }
    }
  }

  // Detect moved surviving AREAS (NonPK): an area's NodePositions.$rcontent
  // differs from its original entry. Areas are first-class paint targets (drag a
  // vertex / translate the body) but are NOT nodes, so they are invisible to
  // movedByPk and NOT covered by runwayPatchInfo — without this a moved area's
  // entry is kept verbatim and the edit silently drops on save.
  let hasMovedAreas = false;
  const areaPatch = new Map(); // origId -> { entry, points, vecType }
  if (mm.areaOrigId && graph.areas) {
    const areaEntryById = new Map();
    for (const e of npkEntries) {
      const id = _entryId(e);
      if (id != null) areaEntryById.set(id, e);
    }
    for (let i = 0; i < graph.areas.length; i++) {
      const origId = i < mm.areaOrigId.length ? mm.areaOrigId[i] : null;
      if (origId == null) continue; // new area → synthesized later
      const entry = areaEntryById.get(origId);
      if (!entry) continue;
      const origPts = _areaEntryPoints(entry);
      const curPts = (graph.areas[i] && graph.areas[i].points) || [];
      if (!origPts || curPts.length === 0) continue;
      let moved = origPts.length !== curPts.length;
      if (!moved) {
        for (let k = 0; k < curPts.length; k++) {
          if (Math.abs(origPts[k].x - curPts[k].x) > 1e-9 || Math.abs(origPts[k].z - curPts[k].z) > 1e-9) { moved = true; break; }
        }
      }
      if (moved) {
        hasMovedAreas = true;
        areaPatch.set(origId, { entry, points: curPts, vecType: _areaEntryVecType(entry) });
      }
    }
  }

  // Also detect incorrect StaticItems $iref for physical-runway (wrong target) and duplicate $k
  // phys -> inline PhysicalRunwayStaticItem $id (resolved via $iref if needed)
  let siDirty = false;
  let physToIdForSi = new Map();
  {
    for (const e of pkEntries) {
      if (_entryTypePrefix(e) !== 'runway') continue;
      // Inline case: "PhysicalRunwayStaticItem": { "$id": N, ... "PhysicalName": "XX/YY" }
      let m = e.match(/"PhysicalRunwayStaticItem"\s*:\s*\{\s*"\$id"\s*:\s*(\d+)/);
      if (m) {
        const physM = e.match(/"PhysicalName"\s*:\s*"([^"]+)"/);
        if (physM) physToIdForSi.set(physM[1], parseInt(m[1],10));
        continue;
      }
      // $iref case: "PhysicalRunwayStaticItem": $iref:N  -> resolve N to inline's PhysicalName
      const irefM = e.match(/"PhysicalRunwayStaticItem"\s*:\s*\$iref:(\d+)/);
      if (irefM) {
        const targetId = parseInt(irefM[1], 10);
        // Find the inline entry that declares this $id within PK
        for (const cand of pkEntries) {
          if (cand.includes('"$id": ' + targetId) && cand.includes('"PhysicalName"')) {
            const physM2 = cand.match(/"PhysicalName"\s*:\s*"([^"]+)"/);
            if (physM2) { physToIdForSi.set(physM2[1], targetId); break; }
          }
        }
        // Fallback: scan raw snapshotText for "$id": N with PhysicalName nearby
        if (!physToIdForSi.has(targetId) || [...physToIdForSi.values()].includes(targetId) === false) {
          const idStr = '"$id": ' + targetId;
          const idx = snapshotText.indexOf(idStr);
          if (idx >= 0) {
            const snippet = snapshotText.substring(Math.max(0, idx - 500), idx + 800);
            const pm = snippet.match(/"PhysicalName"\s*:\s*"([^"]+)"/);
            if (pm) physToIdForSi.set(pm[1], targetId);
          }
        }
      }
    }
    const seen = new Set();
    for (const e of siEntries) {
      const pk = _entryPk(e);
      if (!pk || !pk.startsWith('physical-runway:')) continue;
      if (seen.has(pk)) { siDirty = true; break; }
      seen.add(pk);
      if (orphanSiPks.has(pk) || physPatchMap.has(pk)) { siDirty = true; break; }
      const physName = pk.replace('physical-runway:','');
      const correctId = physToIdForSi.get(physName);
      if (correctId != null) {
        const m = e.match(/"\$v"\s*:\s*\$iref:(\d+)/);
        if (m && parseInt(m[1],10) !== correctId) { siDirty = true; break; }
        if (!m) { siDirty = true; break; }
      }
    }
  }

  // Detect a runway whose `physical-runway:<phys>` StaticItems registry entry is
  // MISSING (e.g. a runway that predates registry synthesis, like a hand-added
  // 02/20 whose end entities exist but was never registered). This is a dirty
  // condition so the rebuild path below appends the missing entry instead of
  // short-circuiting into the no-op branch. Only runways whose inline
  // PhysicalRunwayStaticItem id is resolvable (physToIdForSi) qualify; a fully
  // synthetic runaway with no static item at all follows the new-runway path.
  {
    const existingSiPhys = new Set();
    for (const e of siEntries) {
      const pk = _entryPk(e);
      if (pk && pk.startsWith('physical-runway:')) existingSiPhys.add(pk);
    }
    for (const rw of graph.runways || []) {
      const phys = rw.physicalName ? String(rw.physicalName) : '';
      if (!phys) continue;
      if (existingSiPhys.has('physical-runway:' + phys)) continue;
      if (physToIdForSi.has(phys)) siDirty = true;
    }
  }

  // ── Name-patch detection for survivor stands + taxiway segments ──
  // A user-entered Name (non-empty) on an EXISTING stand/taxiway must be written
  // back; survivors are otherwise kept verbatim, so without this a rename
  // silently drops on save. Only patch when a non-empty name differs from the
  // entry's current Name (empty input = leave untouched, per "if any name input
  // given, save them").
  const standNamePatch = new Map(); // pk -> newName
  const segNamePatch = new Map();   // pk -> newName
  {
    const entryByPk = new Map();
    for (const e of pkEntries) entryByPk.set(_entryPk(e), e);
    if (mm.standOrigPk && graph.stands) {
      for (let i = 0; i < graph.stands.length && i < mm.standOrigPk.length; i++) {
        const pk = mm.standOrigPk[i];
        if (pk == null) continue; // new stand → synthesized via _synthesizeStand
        const st = graph.stands[i];
        if (!st || !st.nameEdited) continue; // only persist user-entered names
        const cur = String(st.name || '');
        if (cur.length === 0) continue; // empty input → leave ACL untouched
        const entry = entryByPk.get(pk);
        if (!entry) continue;
        const old = _entryNameValue(entry);
        if (cur !== old) standNamePatch.set(pk, cur);
      }
    }
    if (mm.segOrigPk && graph.segments) {
      for (let i = 0; i < graph.segments.length && i < mm.segOrigPk.length; i++) {
        const pk = mm.segOrigPk[i];
        if (pk == null) continue; // new segment → synthesized via _synthesizeSegment
        const sg = graph.segments[i];
        if (!sg || !sg.nameEdited) continue; // only persist user-entered names
        const cur = String(sg.name || '');
        if (cur.length === 0) continue; // empty input → leave ACL untouched
        const entry = entryByPk.get(pk);
        if (!entry) continue;
        const old = _entryNameValue(entry);
        if (cur !== old) segNamePatch.set(pk, cur);
      }
    }
  }
  const namesChanged = standNamePatch.size > 0 || segNamePatch.size > 0;

  // ── Runway Entries/Exits dirty check (checkbox editing) ──
  let runwayEntriesDirty = false;
  if (graph && mm && Array.isArray(graph.runways) && Array.isArray(mm.runwayEntriesOrig)) {
    if (graph.runways.length !== mm.runwayEntriesOrig.length) runwayEntriesDirty = true;
    else {
      for (let _r = 0; _r < graph.runways.length; _r++) {
        const cur = graph.runways[_r];
        const orig = mm.runwayEntriesOrig[_r];
        if (!orig) { runwayEntriesDirty = true; break; }
        const curEn = (cur.entries || []).map((e) => `${e.runwayName}:${e.name}:${e.holdingIdx}:${e.lineUpIdx}:${e.defineIdx}`).sort().join('|');
        const origEn = (orig.entries || []).map((e) => `${e.runwayName}:${e.name}:${e.holdingIdx}:${e.lineUpIdx}:${e.defineIdx}`).sort().join('|');
        if (curEn !== origEn) { runwayEntriesDirty = true; break; }
        const curEx = (cur.exits || []).map((e) => `${e.runwayName}:${e.name}:${e.exitIdx}:${e.holdingIdx}:${e.defineIdx}:${e.isLeft}`).sort().join('|');
        const origEx = (orig.exits || []).map((e) => `${e.runwayName}:${e.name}:${e.exitIdx}:${e.holdingIdx}:${e.defineIdx}:${e.isLeft}`).sort().join('|');
        if (curEx !== origEx) { runwayEntriesDirty = true; break; }
      }
    }
  } else if (graph && Array.isArray(graph.runways) && graph.runways.some((r) => (r.entries && r.entries.length) || (r.exits && r.exits.length))) {
    // No orig but graph has entries (newly parsed after code update) — treat as not dirty unless user edited; initial load will have orig set, so this is fallback
    runwayEntriesDirty = false;
  }

  // Pre-existing corruption check: if the snapshot ALREADY carries crash-class
  // dangling references (e.g. a save produced before the survivor gate
  // existed), skip the lossless no-op so the final validation pass below can
  // drop the offending entries instead of re-committing them verbatim.
  const emittedPk = pkEntries.filter((e) => !pkDelete.includes(e));
  const emittedNpk = npkEntries.filter((e) => !npkDelete.includes(e));
  const restIds = new Set();
  _collectDeclaredIds(_textOutsideListSpans(snapshotText, ranges), restIds);
  for (const arr of [emittedPk, emittedNpk, siEntries]) for (const e of arr) _collectDeclaredIds(e, restIds);
  const crashDangleCount = _countCrashClassDangling(emittedPk, restIds);

  // Corrupt-type check: if any PK/NPK entry already has bare "$type": 0, it
  // must go through the rebuild path so _repairPkEntryTypes can fix it. The
  // early return would otherwise return the corrupt snapshot verbatim.
  const hasCorruptTypes = pkEntries.some((e) => /"\$type":\s*0(?=[,\}\]])/.test(e)) || npkEntries.some((e) => /"\$type":\s*0(?=[,\}\]])/.test(e));

  // Lossless no-op: no removals, no new elements, no moved nodes, no moved areas,
  // no runway dirty, no orphan, no siDirty, no name change, no corrupt types, no
  // dangling-reference gate repairs, no pre-existing crash-class dangling refs →
  // text unchanged (still reconcile the checkpoint frame so any PRE-EXISTING
  // stale physical-runway / jetway RuntimeEntities from an earlier corrupt save
  // are repaired on the next save).
  if (!hasCorruptTypes && !hasNew && pkDelete.length === 0 && npkDelete.length === 0 && movedByPk.size === 0 && movedByCoord.size === 0 && !hasMovedAreas && !runwayDirty && !hasOrphanRunway && !hasOrphanSi && !siDirty && !namesChanged && !refGateDirty && !runwayEntriesDirty && !hasTypeChanges && crashDangleCount === 0) {
    return _reconcileRuntimeFrames(snapshotText, _runtimeReconcilers(siEntries, physPatchMap));
  }

  // Rebuild: keep every surviving entry verbatim (so Routes/etc. survive),
  // drop explicitly-deleted ones, patch moved node coords and runway name/width, splice right-to-left.
  const pkOut = [];
  for (const e of pkEntries) {
    if (pkDelete.includes(e)) continue;
    const pk = _entryPk(e);
    let outEntry = e;
    // Patch runway name / physical / width for survivors where names changed
    if (runwayPatchInfo.has(pk)) {
      const info = runwayPatchInfo.get(pk);
      outEntry = _patchRunwayEntry(outEntry, info.oldName, info.newName, info.oldPhys, info.newPhys, info.newWidth);
    }
    if (movedByPk.has(pk)) {
      const mv = movedByPk.get(pk);
      outEntry = _patchNodePosition(outEntry, mv.x, mv.z);
    }
    // Patch EVERY taxiway-node entry whose ORIGINAL coordinate moved (not just the
    // graph representative). Co-located sister entries at the same coordinate are
    // otherwise left behind, so a segment referencing one stays at its old place.
    if (_entryTypePrefix(e) === 'taxiway-node' && movedByCoord.size) {
      const vpos = extractVector3FromV4(e);
      if (vpos) {
        const mv = movedByCoord.get(_coordKey(vpos.x, vpos.z));
        if (mv) outEntry = _patchNodePosition(outEntry, mv.x, mv.z);
      }
    }
    if (standNamePatch.has(pk)) {
      outEntry = _patchEntryName(outEntry, standNamePatch.get(pk));
    }
    if (segNamePatch.has(pk)) {
      outEntry = _patchEntryName(outEntry, segNamePatch.get(pk));
    }
    if (typeChangedByPk.has(pk)) {
      outEntry = _patchIntField(outEntry, 'Type', typeChangedByPk.get(pk));
    }
    if (flagsChangedByPk.has(pk)) {
      outEntry = _patchIntField(outEntry, 'Flags', flagsChangedByPk.get(pk));
    }
    pkOut.push(outEntry);
  }
  // Handle runway entries that were patched but their $k changed: need to ensure expected PKs are present.
  // The patched entries now have new $k, but the original PK's $k was old; we updated it.

  // StaticItems keep (patched) — reuse physToId built above (or build if not yet)
  let siKeep = [];
  const seenSiPks = new Set();
  for (const e of siEntries) {
    const pk = _entryPk(e);
    if (!pk || !pk.startsWith('physical-runway:')) {
      siKeep.push(e);
      continue;
    }
    if (seenSiPks.has(pk)) { siDirty = true; continue; } // deduplicate
    if (orphanSiPks.has(pk)) { siDirty = true; continue; }
    seenSiPks.add(pk);
    let outE = e;
    if (physPatchMap.has(pk)) {
      const newPk = physPatchMap.get(pk);
      outE = outE.replace(/("\$k"\s*:\s*")[^"]+(")/, '$1' + newPk + '$2');
      siDirty = true;
    }
    // Verify $iref points to correct Physical $id
    const physName2 = pk.replace('physical-runway:','');
    const correctId2 = physToIdForSi.get(physName2);
    if (correctId2 != null) {
      const re2 = /"\$v"\s*:\s*\$iref:(\d+)/;
      const m2 = outE.match(re2);
      if (m2) {
        const curId = parseInt(m2[1],10);
        if (curId !== correctId2) {
          outE = outE.replace(re2, '"$v": $iref:' + correctId2);
          siDirty = true;
        }
      }
    }
    // Also check if $v is $iref but should be correct, if not, mark dirty
    if (outE !== e) siDirty = true;
    siKeep.push(outE);
  }

  const npkKeep = [];
  for (const e of npkEntries) {
    if (npkDelete.includes(e)) continue;
    const id = _entryId(e);
    if (id != null && areaPatch.has(id)) {
      const ap = areaPatch.get(id);
      npkKeep.push(_patchAreaPoints(e, ap.points, ap.vecType));
    } else {
      npkKeep.push(e);
    }
  }

  // New-object synthesis: append synthesized entries for NEW nodes + segments.
  // Pass NPK+SI so allocation starts above the true blobdoc max and never collides
  // with Area ids (previously PK-only max caused 09/01 -> Area 8930).
  const synth = _synthesizeNew(graph, mm, pkEntries, npkEntries, siEntries, warnings);
  // ── Patch runway Entries/Exits for checkbox editing (after nodeIds are known) ──
  if (runwayEntriesDirty || runwayDirty) {
    const sRunway = _sampleRunwayShapes(pkEntries);
    const nextIdRef = { value: synth.nextId };
    const nodeIds = synth.nodeIds;
    const patchArray = (arr) => {
      for (let idx = 0; idx < arr.length; idx++) {
        const block = arr[idx];
        if (_entryTypePrefix(block) !== 'runway') continue;
        const curPk = _entryPk(block);
        const curDirName = curPk ? curPk.split(':')[1] : null;
        if (!curDirName) continue;
        let gIdx = -1;
        let gRw = null;
        for (let gi = 0; gi < graph.runways.length; gi++) {
          const rw = graph.runways[gi];
          if (rw.names && rw.names.includes(curDirName)) { gIdx = gi; gRw = rw; break; }
        }
        if (gIdx < 0 || !gRw) continue;
        // Determine if this physical runway's Entries/Exits changed AT ALL. When it
        // did, rebuild BOTH directional blocks: the inner element type id is declared
        // by one direction's $rcontent and referenced BARE by the sibling, so
        // emptying/changing one direction can orphan the sibling's bare $type ref
        // (→ "unknown type id N" or "Type id N claimed by both ..." on encode).
        // Re-serializing both with full type declarations keeps the document's type
        // registry consistent.
        let dirDirty = true;
        const origForPhys = mm.runwayEntriesOrig ? mm.runwayEntriesOrig[gIdx] : null;
        if (origForPhys && !runwayDirty) {
          const curEntriesAll = gRw.entries || [];
          const curExitsAll = gRw.exits || [];
          const origEntriesAll = origForPhys.entries || [];
          const origExitsAll = origForPhys.exits || [];
          const curEnKey = curEntriesAll.map((e) => `${e.name}:${e.holdingIdx}:${e.lineUpIdx}:${e.defineIdx}:${e.runwayName}`).sort().join('|');
          const origEnKey = origEntriesAll.map((e) => `${e.name}:${e.holdingIdx}:${e.lineUpIdx}:${e.defineIdx}:${e.runwayName}`).sort().join('|');
          const curExKey = curExitsAll.map((e) => `${e.name}:${e.exitIdx}:${e.holdingIdx}:${e.defineIdx}:${e.isLeft}:${e.runwayName}`).sort().join('|');
          const origExKey = origExitsAll.map((e) => `${e.name}:${e.exitIdx}:${e.holdingIdx}:${e.defineIdx}:${e.isLeft}:${e.runwayName}`).sort().join('|');
          dirDirty = (curEnKey !== origEnKey) || (curExKey !== origExKey);
        }
        if (!dirDirty) continue;
        const curEntriesForDir = (gRw.entries || []).filter((e) => e.runwayName === curDirName);
        const curExitsForDir = (gRw.exits || []).filter((e) => e.runwayName === curDirName);
        const origEntriesWrapper = _extractSectionObjectText(block, 'Entries');
        const origExitsWrapper = _extractSectionObjectText(block, 'Exits');
        const newEntriesWrapper = _buildEntriesWrapperForPatch(curEntriesForDir, origEntriesWrapper, nodeIds, sRunway, nextIdRef);
        const newExitsWrapper = _buildExitsWrapperForPatch(curExitsForDir, origExitsWrapper, nodeIds, sRunway, nextIdRef);
        const patched = _patchRunwayBlockWithEntriesExits(block, newEntriesWrapper, newExitsWrapper);
        arr[idx] = patched;
      }
    };
    patchArray(pkOut);
    patchArray(synth.entries);
    synth.nextId = nextIdRef.value;
  }
  // After deleting one segment of a multi-segment taxiway the surviving siblings
  // keep a gap in their ordinal suffix; renumber each per-osm group contiguously
  // from 0 so Unity's contiguity invariant is preserved.
  const pkOutSynth = pkOut.concat(synth.entries);
  // Suppress synthesized pavement strips of runways the gate dropped — their
  // graph segments outlive the runway, but painting them would orphan them
  // (no runway claims the name any more).
  const pkOutFinal = _renumberTaxiwaySegmentOrdinals(droppedRunwayPhys.size === 0 ? pkOutSynth : pkOutSynth.filter((e) => {
    if (_entryTypePrefix(e) !== 'taxiway-segment') return true;
    const nm = e.match(/"Name"\s*:\s*"([^"]*)"/);
    return !(nm && droppedRunwayPhys.has(nm[1]));
  }));
  // Rewrite the `Name` of taxiway-segment pavement strips that are named after a
  // renamed physical runway pair (e.g. "01/19" → "19R/01L") so the strips follow
  // the runway. Matched against the exact Name value only.
  const pkOutFinal2 = pkOutFinal.map((e) => _remapTaxiwaySegmentName(e, oldPhysToNewPhys, oldNameToNewName));
  // Append physical-runway StaticItems entries that are missing from the file.
  // This covers BOTH newly added runways (which get a freshly synthesized inline
  // PhysicalRunwayStaticItem id from `newPhysEntries`) AND pre-existing runways
  // whose registry entry is absent (e.g. a hand-added 02/20 that predates
  // registry synthesis) — for a survivor we reuse its existing inline
  // PhysicalRunwayStaticItem id from `physToIdForSi`.
  let siOutFinal = siKeep;
  const registeredPhys = new Set();
  for (const e of siOutFinal) {
    const pk = _entryPk(e);
    if (pk && pk.startsWith('physical-runway:')) registeredPhys.add(pk.replace('physical-runway:', ''));
  }
  const physEntries = []; // [phys, inlineStaticItemId]
  for (const { phys, itemId } of synth.newPhysEntries || []) physEntries.push([phys, itemId]);
  // For stranded survivors, iterate the GRAPH's current physical names (NOT the
  // source-text `physToIdForSi` keys, which are stale after a rename). A renamed
  // runway already had its registry key rewritten by `physPatchMap`, so it is in
  // `registeredPhys`; only a genuinely unregistered runway whose physical name
  // still resolves in `physToIdForSi` should be appended. This fixes the stale
  // "physical-runway:01/19 → $iref:<23/05 static item>" key a rename used to
  // emit, which Unity rejects as a PhysicalRunwayStaticItem PK mismatch.
  for (const rw of graph.runways || []) {
    const phys = rw.physicalName ? String(rw.physicalName) : '';
    if (!phys) continue;
    if (registeredPhys.has(phys)) continue;
    if (physEntries.some(([p]) => p === phys)) continue;
    const id = physToIdForSi.get(phys);
    if (id == null) continue;
    physEntries.push([phys, id]);
  }
  for (const [phys, id] of physEntries) {
    if (id == null) continue;
    // A stale registry entry with the same key can survive from a DELETED
    // runway when a new runway reuses its designation: the name-based orphan
    // check sees the key as expected (the new runway claims it), but the old
    // entry's $iref still points at the deleted runway's static item while the
    // synthesized named runways reference the new inline item. The game's
    // dictionary resolves the key to one of the two arbitrarily and reports
    // "must have exactly two named runways, found 0" when it picks the stale
    // one. Drop any same-key survivor so the synthesized entry is the sole
    // key holder.
    siOutFinal = siOutFinal.filter((e) => {
      const m = e.match(/"\$k"\s*:\s*"physical-runway:([^"]+)"/);
      return !(m && m[1] === phys);
    });
    siOutFinal = siOutFinal.concat('{ "$k": "physical-runway:' + phys + '", "$v": $iref:' + id + ' }');
  }

  // New-area synthesis: append synthesized NonPK areas. A graph area is new when
  // its parallel meta entry is null OR past the end of meta (appended by the
  // painter, which is not required to extend meta in lockstep).
  // Use the unified nextId from synth (already above overall max) to avoid
  // colliding with PK ids, and advance by 3 per Area (Area, ReactiveProperty, List).
  let npkOutFinal = npkKeep;
  const newAreaIdxs = [];
  if (mm.areaOrigId) {
    for (let i = 0; i < graph.areas.length; i++) {
      const orig = i < mm.areaOrigId.length ? mm.areaOrigId[i] : null;
      if (orig == null) newAreaIdxs.push(i);
    }
  }
  if (newAreaIdxs.length > 0) {
    const s = _sampleAreaShapes(npkEntries);
    let nextId = synth.nextId;
    // Defensive fallback if synth produced no entries (e.g. no new PK objects):
    // recompute overall max from NPK/SI + PK.
    if (nextId == null) {
      let maxAreaId = 0;
      for (const e of npkEntries) { const id = _entryId(e); if (id != null && id > maxAreaId) maxAreaId = id; }
      for (const e of pkEntries) { const id = _entryId(e); if (id != null && id > maxAreaId) maxAreaId = id; }
      for (const e of siEntries) { const id = _entryId(e); if (id != null && id > maxAreaId) maxAreaId = id; }
      nextId = maxAreaId + 1;
      const re = /"\$id"\s*:\s*(\d+)/g;
      for (const set of [pkEntries, npkEntries, siEntries]) for (const e of set) { let m; while((m=re.exec(e))!==null){ const nid=parseInt(m[1],10); if(nid>=nextId) nextId=nid+1; } re.lastIndex=0; }
    }
    const newAreas = [];
    for (const i of newAreaIdxs) {
      const areaId = nextId;
      newAreas.push(_synthesizeArea(graph.areas[i], areaId, s));
      nextId += 3; // Area consumes 3 ids
    }
    npkOutFinal = npkKeep.concat(newAreas);
  }

  // Auto-repair any bare "$type": 0 that was synthesized (e.g. runway on a 404-entry
  // file with 0 runways to sample) or that already existed in a corrupt snapshot.
  // This replaces the old guard that threw — we fix the data so the save succeeds.
  const pkOutRepaired = pkOutFinal2.map(_repairPkEntryTypes);
  const npkOutRepaired = npkOutFinal.map(_repairNpkEntryTypes);
  const siOutRepaired = siOutFinal.map(_repairPkEntryTypes);
  // Log if we repaired anything
  let repairedCount = 0;
  for (let i = 0; i < pkOutFinal2.length; i++) if (pkOutFinal2[i] !== pkOutRepaired[i]) repairedCount++;
  for (let i = 0; i < npkOutFinal.length; i++) if (npkOutFinal[i] !== npkOutRepaired[i]) repairedCount++;
  if (repairedCount > 0) console.log('[GroundPainter] auto-repaired ' + repairedCount + ' entity(ies) with corrupt "$type": 0');
  // Use repaired arrays for serialization
  let finalPkOut = pkOutRepaired;
  let finalNpkOut = npkOutRepaired;
  let finalSiOut = siOutRepaired;

  // ── Final dangling-$iref validation (last line of defence) ────────
  // The survivor gate repaired references to entities deleted in THIS patch;
  // this pass verifies the final arrays against the flat declared-id set of
  // the whole document. Crash-class owners (taxiway-segment / stand) that
  // still dangle are DROPPED to fixpoint — the alternative is a level the
  // game cannot load (TaxiwaySegment2DFactory null-deref). Every other owner
  // (taxi-navigation, airways, runtime, …) is reported so a save is never
  // silently corrupt.
  {
    const restIds = new Set();
    _collectDeclaredIds(_textOutsideListSpans(snapshotText, ranges), restIds);
    let droppedAny = false;
    for (let pass = 0; pass < 16; pass++) {
      const declared = new Set(restIds);
      for (const arr of [finalPkOut, finalNpkOut, finalSiOut]) for (const e of arr) _collectDeclaredIds(e, declared);
      let changed = false;
      const kept = [];
      for (const e of finalPkOut) {
        const dead = new Set();
        for (const m of e.matchAll(/\$iref:\s*(\d+)/g)) {
          const id = parseInt(m[1], 10);
          if (!declared.has(id)) dead.add(id);
        }
        const prefix = _entryTypePrefix(e);
        // Per user request, taxi-navigation dangling is also auto-dropped (except the
        // shared-array declarer which is kept and rewired by the gate).
        const isTaxiNavDeclarer = prefix === 'taxi-navigation' && e.includes('"CrossTaxiwayNames": { "$id":');
        if (dead.size > 0 && (prefix === 'taxiway-segment' || prefix === 'stand' || (prefix === 'taxi-navigation' && !isTaxiNavDeclarer))) {
          const isTaxiNav = prefix === 'taxi-navigation';
          const msg = 'dropped ' + (_entryPk(e) || '(unknown)') + ' — dangling $iref(s) ' + [...dead].join(', ') +
              ' survived all repairs (last-resort removal: the game null-derefs these on load)';
          console.warn('[scenery_write] ' + msg);
          // Taxi-navigation auto-drop is silent per user request "fully clear iref" without popup
          if (warnings && !isTaxiNav) warnings.push({ key: 'ground_painter_writer_last_resort_dropped', params: { pk: _entryPk(e) || '(unknown)', ids: [...dead].join(', ') }, text: msg });
          changed = true;
          droppedAny = true;
          continue;
        }
        kept.push(e);
      }
      finalPkOut = kept;
      if (!changed) break;
    }
    // Report-only pass: every remaining dangling reference, any owner.
    {
      const declared = new Set(restIds);
      for (const arr of [finalPkOut, finalNpkOut, finalSiOut]) for (const e of arr) _collectDeclaredIds(e, declared);
      for (const [arr, label] of [[finalPkOut, 'PK'], [finalNpkOut, 'NonPK'], [finalSiOut, 'StaticItems']]) {
        for (const e of arr) {
          const dead = new Set();
          for (const m of e.matchAll(/\$iref:\s*(\d+)/g)) {
            const id = parseInt(m[1], 10);
            if (!declared.has(id)) dead.add(id);
          }
          if (dead.size > 0) {
            const prefix = _entryTypePrefix(e);
            // Taxi-navigation dangling after gate/cascade is the shared-array declarer
            // case — kept intentionally to preserve the CrossTaxiwayNames array.
            // Do not warn (user requested "fully clear iref" via auto-delete for
            // non-declarer nav points; declarer is kept silently and handled by renumber).
            if (prefix === 'taxi-navigation') continue;
            const w = { key: 'ground_painter_writer_dangling_report', params: { label, pk: _entryPk(e) || '(unknown)', ids: [...dead].join(', ') },
              text: label + ' entity ' + (_entryPk(e) || '(unknown)') +
                ' references missing entity id(s) ' + [...dead].join(', ') +
                ' (owner kept: dropping it would cascade-delete shared data)' };
            console.warn('[scenery_write] ' + w.text);
            if (warnings) warnings.push(w);
          }
        }
      }
    }
    // A dropped entry leaves an ordinal gap inside its per-osm group; renumber
    // contiguously again so Unity's group invariant holds.
    if (droppedAny) finalPkOut = _renumberTaxiwaySegmentOrdinals(finalPkOut);
  }

  // ── Canonical type regroup ─────────────────────────────────────
  // Regroup the surviving + synthesized PK entries into the source file's type
  // order so a newly-drawn taxiway-node joins the taxiway-node block (instead of
  // being appended after every taxi-navigation entry). Stable within a group:
  // the within-group relative order is preserved, so a node's graph index is
  // unchanged across a re-parse.
  finalPkOut = _regroupPkByType(finalPkOut, pkTypeOrder);

  const newNpkValue = _arrayValue(finalNpkOut);
  const newPkValue = _arrayValue(finalPkOut);
  const newSiValue = _arrayValue(finalSiOut);

  let out = snapshotText;
  // Splice right-to-left so earlier offsets stay valid. Order in $blobdoc is PK, NonPK, StaticItems.
  // StaticItems is latest, so splice it first.
  if (ranges.siRc && ranges.siLen) {
    out = out.slice(0, ranges.siRc.start) + newSiValue + out.slice(ranges.siRc.end);
    out = out.slice(0, ranges.siLen.valueStart) + String(finalSiOut.length) + out.slice(ranges.siLen.valueEnd);
  }
  out = out.slice(0, ranges.npkRc.start) + newNpkValue + out.slice(ranges.npkRc.end);
  out = out.slice(0, ranges.npkLen.valueStart) + String(finalNpkOut.length) + out.slice(ranges.npkLen.valueEnd);
  out = out.slice(0, ranges.pkRc.start) + newPkValue + out.slice(ranges.pkRc.end);
  out = out.slice(0, ranges.pkLen.valueStart) + String(finalPkOut.length) + out.slice(ranges.pkLen.valueEnd);
  // Reconcile the checkpoint frame's RuntimeEntities against the FINAL static
  // physical-runway AND jetway key sets (removes stale PhysicalRunway / Jetway
  // runtime entities for deleted runWAYS and stands; renames physical-runway
  // entries to follow a runway rename).
  out = _reconcileRuntimeFrames(out, _runtimeReconcilers(finalSiOut, physPatchMap));
  // Cascade the runway renames to flight-plan / aircraft runway-name references
  // so the game's dynamic-flight engine can resolve them on load.
  out = _remapRunwayNameFields(out, oldNameToNewName);
  if (dropCounts.jetway > 0) {
    console.log(
      '[GroundPainter] cascade: dropped ' + dropCounts.jetway +
      ' jetway entry(ies) referencing deleted ids'
    );
  }
  return out;
}

// ─── saveGroundPainterAcl wrapper ─────────────────────────────────

// Post-write integrity guard. Unity builds a taxiway graph by deduping taxiway
// entities on their `$k` key, so two distinct nodes sharing `taxiway-node:-1`
// collapse into ONE vertex and any segment joining them becomes a self-loop
// ("Graph: edge id=-10 has the same vertex index for both endpoints"). The
// writer's fresh-negative OsmId allocation must never produce such duplicates,
// but guard anyway so a corrupt .acl can never reach disk.
// Returns an array of human-readable issues; empty = file is safe.
function _validateNoDegenerateEdges(newText) {
  const issues = [];
  const ranges = _staticEntitiesRanges(newText);
  if (!ranges) return issues;
  const pkArrayValue = newText.substring(ranges.pkRc.start, ranges.pkRc.end);
  const pkEntries = _splitArrayEntries(pkArrayValue);

  // node `$id` -> its `$k`, plus a count of every taxiway `$k` seen.
  const nodeKById = new Map();
  const kCount = new Map();
  for (const e of pkEntries) {
    const k = _entryPk(e);
    if (!k) continue;
    const type = _entryTypePrefix(e);
    if (type !== 'taxiway-node' && type !== 'taxiway-segment') continue;
    kCount.set(k, (kCount.get(k) || 0) + 1);
    if (type === 'taxiway-node') {
      const id = _entryId(e);
      if (id != null) nodeKById.set(id, k);
    }
  }
  for (const [k, c] of kCount) {
    if (c > 1) issues.push(`Duplicate taxiway key '${k}' (${c}x) — these entities collapse to one vertex in the game graph`);
  }
  // Degenerate edge: a taxiway-segment whose two consecutive nodes resolve to
  // the same `$k` (same vertex) or to the same `$id` (zero-length edge).
  for (const e of pkEntries) {
    if (_entryTypePrefix(e) !== 'taxiway-segment') continue;
    // Entity-shape completeness: the game instantiates a TaxiwaySegment into its
    // ground/route model only when the canonical fields are written. Every
    // original segment carries Head (null for undirected), IsHidden and
    // IsUnselectable; the writer used to omit all three, so editor-created
    // taxiways deserialized as incomplete and never showed up in-game.
    const missingFields = [];
    if (!e.includes('"Head"')) missingFields.push('Head');
    if (!e.includes('"IsHidden"')) missingFields.push('IsHidden');
    if (!e.includes('"IsUnselectable"')) missingFields.push('IsUnselectable');
    if (missingFields.length > 0) {
      issues.push(`taxiway-segment ${_entryPk(e)} missing required field(s): ${missingFields.join(', ')}`);
    }
    const irefs = extractIrefArray(e, 'Nodes');
    const ks = irefs.map((r) => nodeKById.get(r));
    for (let i = 1; i < ks.length; i++) {
      const a = ks[i - 1], b = ks[i];
      if (a != null && b != null && a === b) {
        issues.push(`taxiway-segment ${_entryPk(e)} joins vertex '${a}' to itself (same vertex index for both endpoints)`);
        break;
      }
      if (irefs[i - 1] != null && irefs[i - 1] === irefs[i]) {
        issues.push(`taxiway-segment ${_entryPk(e)} has consecutive duplicate node $iref:${irefs[i]} (zero-length edge)`);
        break;
      }
    }
  }
  return issues;
}

/**
 * Validate + write the painted scenery to disk.
 * @param {string} filePath
 * @param {string} snapshotText
 * @param {Graph} graph
 * @param {{createBak?: boolean, blobTypeMap?: Map}} [opts]
 * @returns {{ success: boolean, error?: string, newText?: string }}
 */
function saveGroundPainterAcl({ filePath, snapshotText, graph, createBak = true, blobTypeMap }) {
  // Validate: at least one runway must remain.
  if (!graph.runways || graph.runways.length === 0) {
    return { success: false, error: 'Cannot save — at least one runway is required.' };
  }
  // Cross-level contamination guard: the snapshot's ArchiveGuid must match the
  // file being written. If GroundPainter loaded graph from a different level's
  // text, its node coordinates / PKs will not align and the patch will truncate
  // the file (ZSJN leisure_1 ← leisure_2 contamination that produced 589/1109
  // instead of 3203/4270 and $type 0 runways).
  try {
    const guidMatch = snapshotText.match(/"ArchiveGuid"\s*:\s*"([^"]+)"/);
    const snapGuid = guidMatch ? guidMatch[1] : null;
    const baseName = filePath ? path.basename(filePath, '.acl') : null;
    if (snapGuid && baseName && snapGuid !== baseName) {
      return { success: false, error: 'Cannot save — snapshot ArchiveGuid "' + snapGuid + '" does not match target file "' + baseName + '.acl" (cross-level contamination). Please close and reopen the Ground Painter.' };
    }
  } catch (_) { /* non-fatal */ }

  let newText;
  try {
    newText = patchSceneryBlob(snapshotText, graph, blobTypeMap);
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }

  // Integrity guard: never write a file the game's graph will reject (duplicate
  // taxiway keys / self-loop edges). Refuse before touching disk or the .bak.
  const integrityIssues = _validateNoDegenerateEdges(newText);
  if (integrityIssues.length > 0) {
    return { success: false, error: 'Cannot save — the edited taxiways produce a broken graph (' + integrityIssues.join('; ') + ')' };
  }
  // Corrupt-type auto-repair: patchSceneryBlob already repaired bare "$type": 0
  // in PK/NPK (see _repairPkEntryTypes). If any remain in scenery, repair
  // in-place so the save succeeds instead of refusing.
  if (/"\$type":\s*0(?=[,\}\]])/.test(newText)) {
    const pkRanges = _staticEntitiesRanges(newText);
    if (pkRanges) {
      const pkText = newText.substring(pkRanges.pkRc.start, pkRanges.pkRc.end);
      const pkCorrupt = (pkText.match(/"\$type":\s*0(?=[,\}\]])/g) || []).length;
      if (pkCorrupt > 0) {
        console.warn('[GroundPainter] saveGroundPainterAcl: repairing ' + pkCorrupt + ' remaining "$type": 0 in PK');
        // Fallback repair — per-entry repair already handled the managed types,
        // this catches any stray bare 0 that slipped through.
        newText = newText.replace(/"\$type":\s*0(?=[,\}\]])/g, '"$type": "99|Repaired.Fallback, GroundATC.Core"');
      }
    }
  }

  const fs = require('fs');
  if (createBak) fs.copyFileSync(filePath, filePath + '.bak');

  const { writeAcl } = require('./gatcarc');
  try {
    // Pass the pre-edit text so the renumberer can recover the id→name of any
    // `$type` registration whose introducing object was deleted (§ type repair in
    // id_renumber.js). Without it a deleted first-of-type object orphans the type
    // id for its survivors and encode fails with "$type references unknown type id N".
    writeAcl(filePath, newText, { format: 'auto', originalText: snapshotText });
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }

  // Push the painted taxiway geometry into the airport's geo_data.osm (the file the
  // game renders the ground from). Non-fatal by design: an OSM sync problem must never
  // undo a successful ACL write, so it is reported on the result object instead.
  let geoResult = { skipped: true };
  try {
    const { syncGeoDataForLevel } = require('./geo_osm');
    geoResult = syncGeoDataForLevel(newText, filePath, { createBackup: false });
  } catch (e) {
    geoResult = { ok: false, error: e.message || String(e) };
  }
  return { success: true, newText, geoResult };
}

module.exports = {
  patchSceneryBlob,
  saveGroundPainterAcl,
  extractTaxiwayOsmPool,
  getTaxiwayOsmPoolInfo,
  // exposed for tests
  _renumberTaxiwaySegmentOrdinals,
  _splitArrayEntries,
  _arrayValue,
  _staticEntitiesRanges,
  _patchNodePosition,
  _setVec3XZ,
  _areaEntryPoints,
  _patchAreaPoints,
  _areaVec3,
  _reconcilePhysicalRunwayFrames,
  _reconcileJetwayFrames,
  _reconcileRuntimeFrames,
  _runtimeReconcilers,
  _physKeysFromEntries,
  _jetwayKeysFromEntries,
  _entryPk,
  _entryId,
  _entryTypePrefix,
  _remapRunwayNameFields,
  _remapTaxiwaySegmentName,
  _patchEntryName,
  _entryNameValue,
  _typeId,
  _sampleRunwayInnerType,
  _sampleRunwayShapes,
  _validateNoDegenerateEdges,
  _pkTypeOrder,
  _regroupPkByType,
};
