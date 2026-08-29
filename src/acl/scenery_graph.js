/**
 * SceneryGraph — the Ground Painter's id-free working model.
 *
 * `buildSceneryGraph(text)` parses the decoded ACL text into a Graph that the
 * painter mutates (add/edit/delete taxiways, runways, areas, stands). The Graph
 * is intentionally id-free: no `$id`/`$iref`/OsmId are primary keys. Instead:
 *   - nodes are shared by coordinate (canonical `coordKey`); segments/runways/
 *     stands reference them by array index into `nodes`.
 *   - a `meta` side-table (parallel to the Graph arrays) carries each object's
 *     original `$k`/OsmId/`$id` so survivors reuse their original id at write.
 *
 * Persistence lives in `scenery_write.js`; this module only reads.
 *
 * The `$type` numbers are per-blob-section (they restart at 0 for each
 * `$blobdoc`), so this module never hard-codes 30/31/32 etc. Entity kind is
 * determined by the deterministic `$k` prefix (taxiway-node:/taxiway-segment:/
 * runway:/stand:) and, for NonPK areas, by the `ContextCross.Models.Area` name
 * (or numeric 30|31 fallback, the v4→v5 bump).
 */

const { createTokenizer } = require('./tokenizer');

// ─── Type table ───────────────────────────────────────────────────

/**
 * Scan StaticData.$blobdoc (the whole static section) for the `$type` table:
 * every `"$type": "<N>|<Name>"` declaration, building Map<number, string>.
 *
 * The type numbers restart per blob-section, so we scope the scan to the
 * StaticData.$blobdoc region only. This is a best-effort table used by the
 * writer to resolve canonical names → ambient numbers; reading never depends
 * on it (it uses `$k` prefixes / the Area name).
 *
 * @param {string} text - decoded ACL text
 * @returns {Map<number, string>} typeId → canonical name (may be partial)
 */
function getBlobTypeMap(text) {
  const map = new Map();
  if (!text) return map;

  const t = createTokenizer(text);
  const sdSec = t.findSection('StaticData');
  if (!sdSec) return map;
  const sdText = t.substring(sdSec.valueStart, sdSec.valueEnd);
  const sdT = createTokenizer(sdText);
  const bdSec = sdT.findSection('$blobdoc');
  if (!bdSec) return map;
  const bdText = sdT.substring(bdSec.valueStart, bdSec.valueEnd);

  // Regex is acceptable here: it is a one-shot table scan over the static
  // section, not a structural parse. `$type` values look like "3|Name, Asm".
  let m;
  const re = /"\$type":\s*"(\d+)\|([^"]+)"/g;
  while ((m = re.exec(bdText)) !== null) {
    const id = parseInt(m[1], 10);
    const name = m[2].split(',')[0].trim();
    if (!map.has(id)) map.set(id, name);
  }
  return map;
}

// ─── Node coordinate identity ─────────────────────────────────────

/**
 * Canonical coordinate key. Two points within 1e-6 of each other are one node.
 */
function coordKey(x, z) {
  return x.toFixed(6) + ',' + z.toFixed(6);
}

/**
 * Find an existing node index by coordinate key, or -1.
 */
function findNodeIndex(graph, x, z) {
  if (!graph._coordIndex) return -1;
  const idx = graph._coordIndex.get(coordKey(x, z));
  return idx == null ? -1 : idx;
}

// ─── Read path ────────────────────────────────────────────────────

/**
 * Parse decoded ACL text → id-free Graph + meta.
 *
 * @param {string} text - decoded ACL text
 * @returns {{ graph: Graph, meta: Meta }}
 */
function buildSceneryGraph(text) {
  const {
    buildPkIndex, getPkEntriesByType, extractVector3FromV4,
    extractStringFromV4, extractIrefArray, extractIntFromV4, extractSingleIref,
  } = require('./v4_pk_index');

  const pkIndex = buildPkIndex(text);

  const graph = {
    nodes: [],
    segments: [],
    runways: [],
    areas: [],
    stands: [],
  };
  // Internal node-coordinate index (kept live in the Graph but not serialized).
  graph._coordIndex = new Map();

  const meta = {
    nodeOrigPk: [],       // parallel to nodes: original "taxiway-node:<OsmId>" or null
    segOrigPk: [],        // parallel to segments
    runwayOrigPk: [],     // parallel to runways (representative "$k", e.g. "runway:01")
    areaOrigId: [],       // parallel to areas: original "$id" (integer) or null
    standOrigPk: [],      // parallel to stands
  };

  const idToNodeIdx = new Map(); // node $id → graph node index (shared-node dedup)

  // ── taxiway-node: canonical, shared nodes ─────────────────────
  const nodeEntries = getPkEntriesByType(pkIndex, 'taxiway-node');
  for (const e of nodeEntries) {
    const pos = extractVector3FromV4(e.block);
    if (!pos) continue; // orphan node with no position cannot be a vertex
    const key = coordKey(pos.x, pos.z);
    let idx = graph._coordIndex.get(key);
    if (idx == null) {
      idx = graph.nodes.length;
      graph.nodes.push({
        x: pos.x,
        z: pos.z,
        type: extractIntFromV4(e.block, 'Type'),
        flags: extractIntFromV4(e.block, 'Flags'),
      });
      graph._coordIndex.set(key, idx);
      meta.nodeOrigPk.push(e.pk);
    }
    // Map this node's $id → the (deduped) node index for $iref resolution.
    if (e.id != null) idToNodeIdx.set(e.id, idx);
  }

  // ── taxiway-segment: one logical polyline per entry ─────────────
  // `Nodes.$rcontent` is a FULL curve polyline (up to dozens of $irefs), NOT a
  // 2-point edge. We capture every node so curved taxiways render (and edit) as
  // their true shape — the Ground Map's taxis come from the same field.
  const segEntries = getPkEntriesByType(pkIndex, 'taxiway-segment');
  for (const e of segEntries) {
    const irefs = extractIrefArray(e.block, 'Nodes');
    if (irefs.length < 2) continue;
    const nodeIdxs = [];
    for (const iref of irefs) {
      const idx = idToNodeIdx.get(iref);
      if (idx == null) continue;
      // Drop consecutive duplicate node (closure / self-loop) so a closed loop
      // with a repeated start node does not emit a zero-length tail.
      if (nodeIdxs.length === 0 || nodeIdxs[nodeIdxs.length - 1] !== idx) nodeIdxs.push(idx);
    }
    if (nodeIdxs.length < 2) continue;
    graph.segments.push({
      nodeIdxs,
      aIdx: nodeIdxs[0],
      bIdx: nodeIdxs[nodeIdxs.length - 1],
      name: extractStringFromV4(e.block, 'Name') || undefined,
      flags: extractIntFromV4(e.block, 'Flags'),
      directed: _extractBool(e.block, 'Directed'),
    });
    meta.segOrigPk.push(e.pk);
  }

  // ── runway: collapse the physical pair to ONE graph runway ─────
  // runway:01 + runway:19 share PhysicalName "01/19" = one strip.
  // We keep both directional names: names[0] ↔ thA, names[1] ↔ thB, physicalName = join.
  const runwayEntries = getPkEntriesByType(pkIndex, 'runway');
  const runwayByPhys = new Map(); // physicalName → { entries:[], th:[], width }
  for (const e of runwayEntries) {
    const physName = _extractRunwayPhysicalName(text, pkIndex, e.block);
    if (!physName) continue;
    const irefs = extractIrefArray(e.block, 'ThresholdPoints');
    if (irefs.length < 2) continue;
    const aIdx = idToNodeIdx.get(irefs[0]);
    const bIdx = idToNodeIdx.get(irefs[1]);
    if (aIdx == null || bIdx == null) continue;
    let rec = runwayByPhys.get(physName);
    if (!rec) {
      rec = { entries: [], th: [aIdx, bIdx], width: _extractFloat(e.block, 'Width') };
      runwayByPhys.set(physName, rec);
    }
    rec.entries.push(e);
  }
  // Also need to capture width from first entry if not yet
  for (const [physName, rec] of runwayByPhys) {
    const first = rec.entries[0];
    // Determine names for both ends in th order: which entry's thresholds match th order
    let nameA = null; let nameB = null;
    // Find entry where thresholds are [thA, thB] and other where [thB, thA]
    for (const en of rec.entries) {
      const irefs = extractIrefArray(en.block, 'ThresholdPoints');
      if (irefs.length < 2) continue;
      const ai = idToNodeIdx.get(irefs[0]);
      const bi = idToNodeIdx.get(irefs[1]);
      const n = extractStringFromV4(en.block, 'Name');
      if (ai === rec.th[0] && bi === rec.th[1]) nameA = n;
      else if (ai === rec.th[1] && bi === rec.th[0]) nameB = n;
    }
    // Fallback to split physicalName if not found
    const split = physName.split('/');
    if (!nameA) nameA = split[0] || extractStringFromV4(first.block, 'Name') || '01';
    if (!nameB) nameB = split[1] || (nameA === '01' ? '19' : '01');
    graph.runways.push({
      thAIdx: rec.th[0],
      thBIdx: rec.th[1],
      names: [nameA, nameB],
      name: nameA,
      physicalName: physName,
      width: rec.width,
    });
    // Keep representative PK for backward compat (first entry's PK)
    meta.runwayOrigPk.push(first.pk);
    // Store full orig info for patch diff
    if (!meta.runwayOrigInfo) meta.runwayOrigInfo = [];
    meta.runwayOrigInfo.push({
      pks: rec.entries.map((en) => en.pk),
      physicalName: physName,
      names: [nameA, nameB],
      width: rec.width,
    });
  }
  // Ensure runwayOrigInfo exists even if no runways
  if (!meta.runwayOrigInfo) meta.runwayOrigInfo = [];

  // ── Runway ↔ pavetment-strip coupling (parallel to runways) ─────
  // A physical runway's pavement is drawn as `taxiway-segment` entries whose
  // Name === the runway's physical name (ZSJN: runway 01/19 ↔ 9 strips named
  // "01/19" forming one collinear chain). Record the strip chain's graph node
  // indices per runway so the painter can move the pavement with the runway.
  meta.runwayPavement = [];
  for (let r = 0; r < graph.runways.length; r++) {
    const physName = graph.runways[r].physicalName;
    const chainNodes = [];
    const seen = new Set();
    for (const s of graph.segments) {
      if (s.name !== physName) continue;
      for (const ni of (s.nodeIdxs || [s.aIdx, s.bIdx])) {
        if (seen.has(ni)) continue;
        seen.add(ni);
        chainNodes.push(ni);
      }
    }
    meta.runwayPavement.push(chainNodes);
  }

  // ── stand: NosePosition-anchored, tail + pushback derived as nodes ──
  const standEntries = getPkEntriesByType(pkIndex, 'stand');
  for (const e of standEntries) {
    const noseIref = extractSingleIref(e.block, 'NosePosition');
    const tailIref = extractSingleIref(e.block, 'TailPosition');
    let noseIdx = null;
    let tailIdx = null;

    if (noseIref != null) noseIdx = idToNodeIdx.get(noseIref);
    if (tailIref != null) tailIdx = idToNodeIdx.get(tailIref);
    if (noseIdx == null) {
      // Materialize nose node from the referenced taxiway-node position.
      const resolved = _resolveAndAddNode(text, pkIndex, noseIref, graph, meta, idToNodeIdx);
      noseIdx = resolved;
    }
    if (tailIdx == null) {
      const resolved = _resolveAndAddNode(text, pkIndex, tailIref, graph, meta, idToNodeIdx);
      tailIdx = resolved;
    }
    if (noseIdx == null || tailIdx == null) continue;

    // PushbackLimitPositions nodes (optional).
    const pushbackIdxs = [];
    for (const pIref of extractIrefArray(e.block, 'PushbackLimitPositions')) {
      let pIdx = idToNodeIdx.get(pIref);
      if (pIdx == null) {
        pIdx = _resolveAndAddNode(text, pkIndex, pIref, graph, meta, idToNodeIdx);
      }
      if (pIdx != null) pushbackIdxs.push(pIdx);
    }

    const heading = _headingDeg(graph.nodes[noseIdx], graph.nodes[tailIdx]);
    const standName = extractStringFromV4(e.block, 'Name');
    const standIdent = extractStringFromV4(e.block, 'Identifier');
    graph.stands.push({
      noseIdx,
      tailIdx,
      heading,
      pushbackIdxs,
      parkingType: extractIntFromV4(e.block, 'ParkingType'),
      egressType: extractIntFromV4(e.block, 'EgressType'),
      name: standName || standIdent || '',
      identifier: standIdent || standName || '',
    });
    meta.standOrigPk.push(e.pk);
  }

  // ── NonPK areas (Area 0/1/2) ──────────────────────────────────
  graph.areas = _parseAreasIntoGraph(text);
  for (let i = 0; i < graph.areas.length; i++) {
    meta.areaOrigId.push(graph.areas[i]._origId ?? null);
  }

  // Drop the internal helper (kept off the serialized shape).
  delete graph._coordIndex;

  return { graph, meta };
}

// ─── Small helpers ────────────────────────────────────────────────

/**
 * Resolve an $iref to a taxiway-node position and add it as a (deduped) node.
 * Returns the node index or null. Used by stands when a referenced node was not
 * itself a `taxiway-node` entry (defensive), and by pushback positions.
 */
function _resolveAndAddNode(text, pkIndex, iref, graph, meta, idToNodeIdx) {
  if (iref == null) return null;
  // Avoid re-entering buildPkIndex: use the byId map if present.
  const resolved = (pkIndex && pkIndex.byId) ? (pkIndex.byId.get(iref) || null) : null;
  if (!resolved) return null;
  const { extractVector3FromV4 } = require('./v4_pk_index');
  const pos = extractVector3FromV4(resolved.block);
  if (!pos) return null;
  const key = coordKey(pos.x, pos.z);
  let idx = graph._coordIndex.get(key);
  if (idx == null) {
    idx = graph.nodes.length;
    graph.nodes.push({ x: pos.x, z: pos.z, type: null, flags: null });
    graph._coordIndex.set(key, idx);
    meta.nodeOrigPk.push(null);
  }
  idToNodeIdx.set(iref, idx);
  return idx;
}

/**
 * Extract PhysicalName for a runway entry: nested PhysicalRunwayStaticItem
 * (v5 — inline object or $iref to inline/shared) with top-level fallback (v4).
 */
function _extractRunwayPhysicalName(text, pkIndex, block) {
  const v4 = require('./v4_pk_index');
  // Traverse the '$type' numeric table is not needed; we match by key.
  const nested = _extractNestedObject(block, 'PhysicalRunwayStaticItem');
  if (nested) {
    const trimmed = nested.trim();
    if (trimmed.startsWith('$iref:')) {
      const iref = parseInt(trimmed.slice(6).trim(), 10);
      const name = _findPhysicalNameByIref(text, pkIndex, iref);
      if (name) return name;
    } else {
      const n = v4.extractStringFromV4(nested, 'PhysicalName');
      if (n) return n;
    }
  }
  // v4 fallback: top-level PhysicalName.
  return v4.extractStringFromV4(block, 'PhysicalName');
}

function _findPhysicalNameByIref(text, pkIndex, iref) {
  const v4 = require('./v4_pk_index');
  const resolved = pkIndex ? v4.resolveIref(pkIndex, iref) : null;
  if (resolved) {
    const n = v4.extractStringFromV4(resolved.block, 'PhysicalName');
    if (n) return n;
    // double indirection via `physical-runway:` alias
    const trimmed = resolved.block.trim();
    if (trimmed.startsWith('$iref:')) {
      const iref2 = parseInt(trimmed.slice(6).trim(), 10);
      const resolved2 = v4.resolveIref(pkIndex, iref2);
      if (resolved2) {
        const n2 = v4.extractStringFromV4(resolved2.block, 'PhysicalName');
        if (n2) return n2;
      }
    }
  }
  // raw-text fallback for inline shared objects (e.g. ZSJN $iref:8541)
  if (text) {
    const idStr = '"$id": ' + iref;
    const idx = text.indexOf(idStr);
    if (idx >= 0) {
      const snippet = text.substring(Math.max(0, idx - 500), idx + 2000);
      const m = snippet.match(/"PhysicalName":\s*"([^"]+)"/);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Extract a nested object's raw text for a named key (e.g. PhysicalRunwayStaticItem).
 */
function _extractNestedObject(block, key) {
  const t = createTokenizer(block);
  const sec = t.findSection(key);
  if (!sec) return null;
  return t.substring(sec.valueStart, sec.valueEnd);
}

function _extractBool(block, key) {
  const t = createTokenizer(block);
  const sec = t.findSection(key);
  if (!sec) return undefined;
  const val = t.substring(sec.valueStart, sec.valueEnd).trim();
  if (val === 'true') return true;
  if (val === 'false') return false;
  return undefined;
}

function _extractFloat(block, key) {
  const t = createTokenizer(block);
  const sec = t.findSection(key);
  if (!sec) return null;
  const val = t.substring(sec.valueStart, sec.valueEnd);
  const f = parseFloat(val);
  return isNaN(f) ? null : f;
}

function _headingDeg(nose, tail) {
  const dx = nose.x - tail.x;
  const dz = nose.z - tail.z;
  let deg = Math.atan2(-dz, dx) * (180 / Math.PI);
  deg = ((deg % 360) + 360) % 360;
  return Math.round(deg);
}

// ─── NonPK areas → graph ──────────────────────────────────────────

function _parseAreasIntoGraph(text) {
  const t = createTokenizer(text);
  const sdSec = t.findSection('StaticData');
  if (!sdSec) return [];
  const sdText = t.substring(sdSec.valueStart, sdSec.valueEnd);
  const sdT = createTokenizer(sdText);
  const bdSec = sdT.findSection('$blobdoc');
  if (!bdSec) return [];
  const bdText = sdT.substring(bdSec.valueStart, bdSec.valueEnd);
  const bdT = createTokenizer(bdText);
  const npkSec = bdT.findSection('NonPKStaticEntities');
  if (!npkSec) return [];
  const npkText = bdT.substring(npkSec.valueStart, npkSec.valueEnd);
  const npkT = createTokenizer(npkText);
  const rcSec = npkT.findSection('$rcontent');
  if (!rcSec) return [];
  const rcStart = rcSec.valueStart;
  if (npkText[rcStart] !== '[') return [];
  const rcEnd = npkT.findArrayEnd(rcStart);
  if (!rcEnd) return [];
  const contentText = npkText.substring(rcStart + 1, rcEnd);

  const areas = [];
  const contentT = createTokenizer(contentText);
  let pos = 0;
  while (pos < contentText.length) {
    while (pos < contentText.length && ' \t\n\r,'.includes(contentText[pos])) pos++;
    if (pos >= contentText.length) break;
    if (contentText[pos] !== '{') { pos++; continue; }
    const entryEnd = contentT.findObjectEnd(pos);
    if (!entryEnd) break;
    const entryBlock = contentText.substring(pos, entryEnd);

    if (!_isAreaEntity(entryBlock)) { pos = entryEnd; continue; }

    const origId = _extractRawInt(entryBlock, '$id');
    const areaType = _extractRawInt(entryBlock, 'AreaType');
    const points = _extractAreaPoints(entryBlock);
    if (areaType != null && points.length >= 3) {
      areas.push({ areaType, points, owner: null, ...(origId != null && { _origId: origId }) });
    }
    pos = entryEnd;
  }
  return areas;
}

function _isAreaEntity(block) {
  if (block.includes('ContextCross.Models.Area')) return true;
  const t = createTokenizer(block);
  const sec = t.findSection('$type');
  if (!sec) return false;
  const val = t.substring(sec.valueStart, sec.valueEnd).replace(/\s/g, '');
  if (val.startsWith('"30|') || val.startsWith('"31|')) return true;
  if (val === '30' || val === '31') return true;
  return false;
}

function _extractRawInt(block, key) {
  const t = createTokenizer(block);
  const sec = t.findSection(key);
  if (!sec) return null;
  const val = t.substring(sec.valueStart, sec.valueEnd);
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function _extractAreaPoints(entryBlock) {
  const t = createTokenizer(entryBlock);
  const npSec = t.findSection('NodePositions');
  if (!npSec) return [];
  const npText = t.substring(npSec.valueStart, npSec.valueEnd);
  // npText is the ReactiveProperty<Vector3> object: find the inner List<Vector3> $rcontent.
  const npT = createTokenizer(npText);
  const rcSec = npT.findSection('$rcontent');
  if (!rcSec) return [];
  const rcStart = rcSec.valueStart;
  if (npText[rcStart] !== '[') return [];
  const rcEnd = npT.findArrayEnd(rcStart);
  if (!rcEnd) return [];
  const arrText = npText.substring(rcStart + 1, rcEnd);

  const points = [];
  let i = 0;
  while (i < arrText.length) {
    while (i < arrText.length && arrText[i] !== '{') i++;
    if (i >= arrText.length) break;
    const objStart = i;
    let depth = 1;
    i++;
    while (i < arrText.length && depth > 0) {
      if (arrText[i] === '{') depth++;
      else if (arrText[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) break;
    const vecBlock = arrText.substring(objStart, i);

    // Strip "$type" then read x, _, z.
    const vals = _stripTypeAndNumbers(vecBlock);
    if (vals && vals.length >= 3) {
      points.push({ x: vals[0], z: vals[2] });
    }
  }
  return points;
}

// Parse "x, y, z" (plus optional leading "$type": N,) → numeric array, no regex for numbers.
function _stripTypeAndNumbers(vecBlock) {
  let numText = vecBlock;
  const typeIdx = numText.indexOf('"$type"');
  if (typeIdx >= 0) {
    const colon = numText.indexOf(':', typeIdx);
    if (colon >= 0) {
      let after = colon + 1;
      while (after < numText.length && ' \t\n\r'.includes(numText[after])) after++;
      // skip quoted "N|Name" or bare N
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
  const clean = numText.substring(s, e);
  const parts = clean.split(',').map(p => parseFloat(p.trim()));
  return (parts.length >= 3 && parts.slice(0, 3).every(p => !isNaN(p))) ? parts : null;
}

// ─── Graph lifecycle helpers ──────────────────────────────────────

function emptyGraph() {
  return { nodes: [], segments: [], runways: [], areas: [], stands: [] };
}

function cloneGraph(g) {
  return structuredClone(g);
}

/**
 * Recompute auto-pavement areas for the current geometry (post-mutation).
 * For each taxiway/runway/stand this computes its swept pavement rectangle and
 * ensures a matching `areas` entry carrying `owner`. Best-effort; mutation-time
 * only (buildSceneryGraph reads existing areas as-is, owner=null).
 * @param {Graph} graph
 * @returns {Graph} the same graph, mutated in place
 */
function rebuildOwners(graph) {
  const FROZEN = _frozenDims();
  // Drop stale pavement entries, rebuild from current geometry.
  graph.areas = graph.areas.filter(a => a.owner == null);
  const next = graph.areas.slice();

  for (let s = 0; s < graph.segments.length; s++) {
    const seg = graph.segments[s];
    const a = graph.nodes[seg.aIdx], b = graph.nodes[seg.bIdx];
    if (!a || !b) continue;
    const rect = _rectAroundSegment(a, b, FROZEN.TAXIWAY_HALF_WIDTH, FROZEN.TAXIWAY_ENDCAP);
    next.push({ areaType: 1, points: rect, owner: { kind: 'taxiway', segIdx: s } });
  }
  for (let r = 0; r < graph.runways.length; r++) {
    const rw = graph.runways[r];
    const a = graph.nodes[rw.thAIdx], b = graph.nodes[rw.thBIdx];
    if (!a || !b) continue;
    const rect = _rectAroundSegment(a, b, (rw.width || FROZEN.RUNWAY_WIDTH) / 2, 0);
    next.push({ areaType: 1, points: rect, owner: { kind: 'runway', rwIdx: r } });
  }
  for (let st = 0; st < graph.stands.length; st++) {
    const stand = graph.stands[st];
    const nose = graph.nodes[stand.noseIdx], tail = graph.nodes[stand.tailIdx];
    if (!nose || !tail) continue;
    const mid = { x: (nose.x + tail.x) / 2, z: (nose.z + tail.z) / 2 };
    const rect = _rectAroundSegment(
      { x: mid.x, z: mid.z },
      { x: mid.x, z: mid.z },
      FROZEN.STAND_RECT_HALF_WID,
      FROZEN.STAND_RECT_HALF_LEN,
    );
    next.push({ areaType: 1, points: rect, owner: { kind: 'stand', standIdx: st } });
  }
  graph.areas = next;
  return graph;
}

// Axis-aligned rectangle swept around segment (a→b) with half-width `hw` along
// the perpendicular and `endcap` extension beyond each endpoint.
function _rectAroundSegment(a, b, hw, endcap) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const px = -dz / len, pz = dx / len; // unit perpendicular
  const A = { x: a.x - px * hw, z: a.z - pz * hw };
  const B = { x: b.x - px * hw, z: b.z - pz * hw };
  const C = { x: b.x + px * hw, z: b.z + pz * hw };
  const D = { x: a.x + px * hw, z: a.z + pz * hw };
  if (!endcap) return [A, B, C, D];
  // Extend the capped ends outward along the segment axis.
  const ux = dx / len, uz = dz / len;
  const A2 = { x: A.x - ux * endcap, z: A.z - uz * endcap };
  const D2 = { x: D.x - ux * endcap, z: D.z - uz * endcap };
  const B2 = { x: B.x + ux * endcap, z: B.z + uz * endcap };
  const C2 = { x: C.x + ux * endcap, z: C.z + uz * endcap };
  return [A2, B2, C2, D2];
}

function _frozenDims() {
  // CommonJS access to the frozen constants (single source in map-config.js).
  let c = {};
  try {
    c = require('./constants');
  } catch (_) { /* fall back to hard defaults if not present */ }
  return {
    TAXIWAY_HALF_WIDTH: c.TAXIWAY_HALF_WIDTH ?? 0.15,
    TAXIWAY_ENDCAP: c.TAXIWAY_ENDCAP ?? 0.10,
    RUNWAY_WIDTH: c.RUNWAY_WIDTH ?? 0.50,
    STAND_RECT_HALF_LEN: c.STAND_RECT_HALF_LEN ?? 1.2,
    STAND_RECT_HALF_WID: c.STAND_RECT_HALF_WID ?? 0.9,
  };
}

module.exports = {
  buildSceneryGraph,
  getBlobTypeMap,
  coordKey,
  findNodeIndex,
  emptyGraph,
  cloneGraph,
  rebuildOwners,
  // exposed for tests
  _extractRunwayPhysicalName,
  _headingDeg,
};
