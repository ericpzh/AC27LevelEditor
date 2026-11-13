'use strict';

/**
 * GATCARC4 v3 Scenery & Ground/Air Painter Writer (`src/acl/v3/writers_scenery.js`).
 *
 * Applies semantic `sceneryGraph` + `sceneryMeta` edits to a v3 container:
 *   - Preserves untouched surviving entities and exact raw Q32.32 `Position3` tuples
 *   - Updates moved `TaxiwayNode`, `AirwayNode`, `Area`, and companion `FixedTaxiNavigationPoint` coords
 *   - Synthesizes newly drawn `TaxiwayNode`, `TaxiwaySegment`, `Stand` (+ `taxi-navigation` & `jetway`),
 *     `Runway` pairs (+ derived edge/touchdown nodes, holding areas, shared `PhysicalRunwayStaticItem`),
 *     `AirwayNode`, `AirwaySegment`, and `Area` entities
 *   - Repairs or drops dangling survivor references when nodes/stands/runways are deleted
 *   - Enforces linear chain decomposition, contiguous `0..N-1` segment ordinals, and visual consistency per `OsmId`
 *   - Cascades runway/stand renames & deletions across `MetaData.RunwayTimeline`, `StaticData.StaticItems`,
 *     and every checkpoint frame's `RuntimeData` (`PhysicalRunway`, `Jetway`, `FlightPlan`, `Aircraft`, events, scoring)
 */

const { getSchemaForHash } = require('./schema_registry');
const {
  dictEntries,
  dictGet,
  dictSet,
  dictDelete,
  isRefObject,
  isPkRefString,
  parsePkRef,
  makePkRef,
  makeReactive,
  makeTypedArray,
  indexDocumentGraph,
  indexStaticAuthorities,
  resolveGraphNode,
  unwrapReactive,
  unwrapTypedArray,
  normalizeDocumentGraph,
} = require('./graph');
const {
  GU_TO_METERS,
  encodeQ32,
  decodePosition3ToGu,
  encodeGuToPosition3,
} = require('./q32');
const readers = require('./readers');

const MANAGED_PK_TYPES = new Set([
  'taxiway-node',
  'taxiway-segment',
  'airway-node',
  'airway-segment',
  'runway',
  'stand',
  'taxi-navigation',
]);

const PK_TYPE_ORDER = [
  'taxiway-node',
  'taxiway-segment',
  'airway-node',
  'airway-segment',
  'runway',
  'stand',
  'taxi-navigation',
];

const RW_EDGE_OFFSET = 0.58;
const RW_TD_OFFSET = 4.80;
const RW_HOLD_W = 0.037;
const RW_HOLD_L = 0.314;
const COORD_EPS_GU = 1e-7;

function pkPrefix(pk) {
  if (typeof pk !== 'string') return '';
  const idx = pk.indexOf(':');
  return idx >= 0 ? pk.slice(0, idx) : pk;
}

function coordKey(x, z) {
  return `${Number(x).toFixed(6)},${Number(z).toFixed(6)}`;
}

function hasNull(arr) {
  return Array.isArray(arr) && arr.some((v) => v == null);
}

function arrayLongerThan(metaArr, graphArr) {
  return Array.isArray(metaArr) && Array.isArray(graphArr) && graphArr.length > metaArr.length;
}

function encodeUpdatedPosition3(origTuple, nxGu, nzGu) {
  const encoded = encodeGuToPosition3({ x: nxGu, y: 0, z: nzGu });
  if (Array.isArray(origTuple) && origTuple.length >= 3) {
    return [encoded[0], origTuple[1], encoded[2]];
  }
  return encoded;
}

function getTaxiwayNodeGu(nodeObj, g) {
  if (!nodeObj) return null;
  const tuple = unwrapReactive(nodeObj.ReactivePosition, g);
  if (!Array.isArray(tuple) || tuple.length < 3) return null;
  return decodePosition3ToGu(tuple);
}

function getTaxiwayNodeRawTuple(nodeObj, g) {
  if (!nodeObj) return null;
  const tuple = unwrapReactive(nodeObj.ReactivePosition, g);
  return Array.isArray(tuple) && tuple.length >= 3 ? tuple : null;
}

function holdingRectAround(center, ux, uz, w, l) {
  const hw = w / 2;
  const hl = l / 2;
  const px = -uz;
  const pz = ux;
  return [
    { x: center.x + px * hw + ux * hl, z: center.z + pz * hw + uz * hl },
    { x: center.x - px * hw + ux * hl, z: center.z - pz * hw + uz * hl },
    { x: center.x - px * hw - ux * hl, z: center.z - pz * hw - uz * hl },
    { x: center.x + px * hw - ux * hl, z: center.z + pz * hw - uz * hl },
  ];
}

function inferHoldingsForRunway(graph, rw, ux, uz) {
  const holdings = [];
  const seenHoldingIdx = new Set();
  const pushFromIdx = (hIdx, entryName) => {
    if (hIdx == null || seenHoldingIdx.has(hIdx)) return;
    const node = graph.nodes[hIdx];
    if (!node) return;
    seenHoldingIdx.add(hIdx);
    const verts = holdingRectAround(node, ux, uz, RW_HOLD_W, RW_HOLD_L);
    holdings.push({ vertices: verts, entryName: entryName || `H${holdings.length + 1}` });
  };
  for (const en of rw.entries || []) pushFromIdx(en.holdingIdx, en.name);
  for (const ex of rw.exits || []) pushFromIdx(ex.holdingIdx, ex.name);

  if (holdings.length === 0 && Array.isArray(graph.segments) && Array.isArray(graph.nodes)) {
    const phys = rw.physicalName || (Array.isArray(rw.names) ? rw.names.join('/') : '');
    const a = graph.nodes[rw.thAIdx];
    const b = graph.nodes[rw.thBIdx];
    if (!a || !b) return holdings;
    const halfW = ((rw.width != null && Number(rw.width) !== 0 ? Number(rw.width) : 0.50) / 2) + 0.2;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const inside = (pt) => {
      const apx = pt.x - a.x;
      const apz = pt.z - a.z;
      const proj = apx * ux + apz * uz;
      if (proj < -0.5 || proj > len + 0.5) return false;
      const perp = Math.abs(apx * (-uz) + apz * ux);
      return perp <= halfW;
    };
    const candidateIdxs = new Map();
    for (const seg of graph.segments) {
      if (!seg || seg.name === phys) continue;
      const idxs = seg.nodeIdxs && seg.nodeIdxs.length >= 2 ? seg.nodeIdxs : [seg.aIdx, seg.bIdx];
      if (!idxs || idxs.length < 2) continue;
      for (let k = 0; k < idxs.length - 1; k++) {
        const iA = idxs[k];
        const iB = idxs[k + 1];
        const nA = graph.nodes[iA];
        const nB = graph.nodes[iB];
        if (!nA || !nB) continue;
        const inA = inside(nA);
        const inB = inside(nB);
        if (inA === inB) continue;
        const outIdx = inA ? iB : iA;
        if (!candidateIdxs.has(outIdx)) candidateIdxs.set(outIdx, seg.name || '');
      }
    }
    for (const [outIdx, segName] of candidateIdxs) {
      pushFromIdx(outIdx, segName || `H${holdings.length + 1}`);
    }
  }
  return holdings;
}

function modeValue(values, preferNonEmpty) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = values.length ? values[0] : undefined;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (preferNonEmpty && v === '') continue;
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return bestCount === -1 && values.length ? values[0] : best;
}

function segVisualOfObj(segObj) {
  return {
    name: segObj.Name != null ? String(segObj.Name) : '',
    flags: segObj.Flags != null ? Number(segObj.Flags) : 0,
    directed: Boolean(segObj.Directed),
    isHidden: Boolean(segObj.IsHidden),
    isUnselectable: Boolean(segObj.IsUnselectable),
  };
}

function canonicalSegVisual(segObjs) {
  const vis = segObjs.map(segVisualOfObj);
  return {
    name: modeValue(vis.map((v) => v.name), true) ?? '',
    flags: modeValue(vis.map((v) => v.flags), false) ?? 0,
    directed: Boolean(modeValue(vis.map((v) => v.directed), false)),
    isHidden: Boolean(modeValue(vis.map((v) => v.isHidden), false)),
    isUnselectable: Boolean(modeValue(vis.map((v) => v.isUnselectable), false)),
  };
}

function splitGroupIntoLinearChains(list, endpoints) {
  const n = list.length;
  const nodePieces = new Map();
  const deg = new Map();
  for (let i = 0; i < n; i++) {
    for (const nd of [endpoints[i][0], endpoints[i][1]]) {
      if (nd == null) continue;
      deg.set(nd, (deg.get(nd) || 0) + 1);
      if (!nodePieces.has(nd)) nodePieces.set(nd, []);
      nodePieces.get(nd).push(i);
    }
  }
  const remaining = new Set([...Array(n).keys()]);
  const chains = [];
  const walk = (startNode) => {
    const chain = [];
    let cur = startNode;
    while (true) {
      const next = (nodePieces.get(cur) || []).find((i) => remaining.has(i));
      if (next == null) break;
      remaining.delete(next);
      const [a, b] = endpoints[next];
      const reversed = a !== cur;
      chain.push({ i: next, reversed });
      cur = reversed ? a : b;
    }
    return chain;
  };
  for (const [node, d] of deg) {
    if (d !== 1) continue;
    if (!(nodePieces.get(node) || []).some((i) => remaining.has(i))) continue;
    const chain = walk(node);
    if (chain.length) chains.push(chain);
  }
  while (remaining.size) {
    const i0 = remaining.values().next().value;
    const chain = walk(endpoints[i0][0]);
    if (!chain.length) {
      remaining.delete(i0);
      chains.push([{ i: i0, reversed: false }]);
    } else {
      chains.push(chain);
    }
  }
  return chains;
}

function computePkTypeOrder(entries) {
  const seen = [];
  for (const [pk] of entries) {
    const p = pkPrefix(pk);
    if (p && !seen.includes(p)) seen.push(p);
  }
  for (const c of PK_TYPE_ORDER) {
    if (!seen.includes(c)) seen.push(c);
  }
  return seen;
}

function regroupPkEntries(entries, typeOrder) {
  const buckets = new Map();
  const known = new Set(typeOrder);
  const tail = [];
  for (const item of entries) {
    const p = pkPrefix(item[0]);
    if (!buckets.has(p)) {
      buckets.set(p, []);
      if (!known.has(p)) tail.push(p);
    }
    buckets.get(p).push(item);
  }
  const out = [];
  for (const p of typeOrder) {
    const b = buckets.get(p);
    if (b) out.push(...b);
  }
  for (const p of tail) {
    const b = buckets.get(p);
    if (b) out.push(...b);
  }
  return out;
}

function liveRunwayEndsFromGraph(graph) {
  const set = new Set();
  for (const rw of graph?.runways || []) {
    if (Array.isArray(rw.names) && rw.names.length >= 2) {
      if (rw.names[0]) set.add(String(rw.names[0]).trim());
      if (rw.names[1]) set.add(String(rw.names[1]).trim());
    } else if (rw.physicalName) {
      for (const p of String(rw.physicalName).split('/')) {
        if (p.trim()) set.add(p.trim());
      }
    } else if (rw.name) {
      set.add(String(rw.name).trim());
    }
  }
  return set;
}

function newRunwayPrimaryEnds(graph, mm) {
  const ends = [];
  const orig = mm?.runwayOrigPk;
  const runways = graph?.runways || [];
  for (let i = 0; i < runways.length; i++) {
    const origPk = Array.isArray(orig) && i < orig.length ? orig[i] : null;
    if (origPk != null) continue;
    const rw = runways[i];
    if (!rw) continue;
    const names = Array.isArray(rw.names) && rw.names.length
      ? rw.names
      : [rw.name, ...String(rw.physicalName || '').split('/')];
    const first = names.map((n) => String(n || '').trim()).filter(Boolean)[0];
    if (first) ends.push(first);
  }
  return ends;
}

function reconcileMetaDataRunwayTimeline(container, oldNameToNewName, liveEnds, newEnds) {
  const md = container.metaData;
  if (!md || !md.RunwayTimeline) return false;
  const rt = md.RunwayTimeline;
  let changed = false;

  const remapEnd = (n) => {
    const s = String(n ?? '').trim();
    return oldNameToNewName.get(s) || s;
  };
  const firstLive = liveEnds.size > 0 ? liveEnds.values().next().value : null;

  if (Array.isArray(rt.initialRunways)) {
    const prev = rt.initialRunways;
    let next = prev.map(remapEnd).filter((n) => liveEnds.has(n));
    // Deduplicate preserving order
    next = [...new Set(next)];
    if (next.length === 0 && prev.length > 0 && firstLive != null) {
      next = [firstLive];
    }
    for (const req of newEnds) {
      if (liveEnds.has(req) && !next.includes(req)) {
        next.push(req);
      }
    }
    if (next.length !== prev.length || next.some((v, idx) => v !== prev[idx])) {
      rt.initialRunways = next;
      changed = true;
    }
  }

  if (Array.isArray(rt.timeline)) {
    const nextFrames = [];
    let tlChanged = false;
    for (const frame of rt.timeline) {
      if (!frame || !Array.isArray(frame.changes)) continue;
      const keptChanges = [];
      for (const ch of frame.changes) {
        if (!ch) {
          tlChanged = true;
          continue;
        }
        const nextSrc = remapEnd(ch.source);
        const nextDst = remapEnd(ch.dest);
        if (!liveEnds.has(nextSrc) || !liveEnds.has(nextDst)) {
          tlChanged = true;
          continue;
        }
        if (nextSrc !== ch.source || nextDst !== ch.dest) {
          tlChanged = true;
        }
        keptChanges.push({ dest: nextDst, source: nextSrc });
      }
      if (keptChanges.length === 0 && frame.changes.length > 0) {
        tlChanged = true;
        continue;
      }
      nextFrames.push({ changes: keptChanges, time: frame.time });
    }
    if (tlChanged || nextFrames.length !== rt.timeline.length) {
      rt.timeline = nextFrames;
      changed = true;
    }
  }

  if (changed) {
    container.dirtyMetaData = true;
  }
  return changed;
}

function reconcileRuntimeFramesForScenery(
  container,
  schema,
  staticAuth,
  validPhysKeys,
  physPatchMap,
  validJetwayKeys,
  oldNameToNewName,
  oldPhysToNewPhys,
  liveEnds,
  livePhysNames,
) {
  if (!Array.isArray(container.frames) || container.frames.length === 0) return;

  const remapEndOrKeep = (s) => (typeof s === 'string' && oldNameToNewName.has(s) ? oldNameToNewName.get(s) : s);
  const remapPhysOrKeep = (s) => (typeof s === 'string' && oldPhysToNewPhys.has(s) ? oldPhysToNewPhys.get(s) : s);

  for (const frame of container.frames) {
    if (!frame?.runtimeData) continue;
    const preRtIdx = indexDocumentGraph(frame.runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(frame.runtimeData.RuntimeEntities, preRtIdx);
    if (!reDict) continue;

    let rtChanged = false;

    // 1. Reconcile `physical-runway:*` and `jetway:*` entries in RuntimeEntities
    const entriesSnapshot = dictEntries(reDict);
    const presentPhysKeys = new Set();
    const presentJetwayKeys = new Set();

    for (const [k, rawV] of entriesSnapshot) {
      if (k.startsWith('physical-runway:')) {
        if (physPatchMap.has(k)) {
          const newKey = physPatchMap.get(k);
          const obj = resolveGraphNode(rawV, preRtIdx);
          dictDelete(reDict, k);
          if (validPhysKeys.has(newKey) && obj) {
            obj.$type = 'ContextCross.Models.PhysicalRunway';
            dictSet(reDict, newKey, obj);
            presentPhysKeys.add(newKey);
          }
          rtChanged = true;
        } else if (!validPhysKeys.has(k)) {
          dictDelete(reDict, k);
          rtChanged = true;
        } else {
          presentPhysKeys.add(k);
        }
      } else if (k.startsWith('jetway:')) {
        if (!validJetwayKeys.has(k)) {
          dictDelete(reDict, k);
          rtChanged = true;
        } else {
          presentJetwayKeys.add(k);
        }
      }
    }

    for (const reqPhysKey of validPhysKeys) {
      if (!presentPhysKeys.has(reqPhysKey)) {
        dictSet(reDict, reqPhysKey, {
          $type: 'ContextCross.Models.PhysicalRunway',
          _latestDepartureRoll: null,
        });
        rtChanged = true;
      }
    }

    for (const reqJwKey of validJetwayKeys) {
      if (!presentJetwayKeys.has(reqJwKey)) {
        dictSet(reDict, reqJwKey, {
          $type: 'ContextCross.Models.Jetway',
          AutoUndockFinished: false,
          DockingAircraft: makeReactive(null),
          DockingDoorIndex: makeReactive(-1),
          Progress: makeReactive(0),
          Status: 0,
          TrigEvent: false,
        });
        rtChanged = true;
      }
    }

    // 2. Cascade runway renames/deletions & deleted taxi-nav `pk:` refs across runtime entities
    for (const [k, rawV] of dictEntries(reDict)) {
      const ent = resolveGraphNode(rawV, preRtIdx);
      if (!ent || typeof ent !== 'object') continue;

      if (k.startsWith('flight-plan:')) {
        if (typeof ent._arrivalRunway === 'string' && oldNameToNewName.has(ent._arrivalRunway)) {
          ent._arrivalRunway = oldNameToNewName.get(ent._arrivalRunway);
          rtChanged = true;
        }
        if (typeof ent._departureRunway === 'string' && oldNameToNewName.has(ent._departureRunway)) {
          ent._departureRunway = oldNameToNewName.get(ent._departureRunway);
          rtChanged = true;
        }
      } else if (k.startsWith('aircraft:')) {
        // `_selectedRunwayEntryRunway`: nullable pk:ContextCross.Models.Runway:runway:<end>
        if (ent._selectedRunwayEntryRunway && isRefObject(ent._selectedRunwayEntryRunway)) {
          const parsed = parsePkRef(ent._selectedRunwayEntryRunway.$ref);
          if (parsed && parsed.pk.startsWith('runway:')) {
            const oldEnd = parsed.pk.slice('runway:'.length);
            if (oldNameToNewName.has(oldEnd)) {
              const newPk = `runway:${oldNameToNewName.get(oldEnd)}`;
              if (staticAuth.authorities.has(newPk)) {
                ent._selectedRunwayEntryRunway = makePkRef('ContextCross.Models.Runway', newPk);
              } else {
                ent._selectedRunwayEntryRunway = null;
                ent.SelectedRunwayEntryIndex = -1;
              }
              rtChanged = true;
            } else if (!staticAuth.authorities.has(parsed.pk)) {
              ent._selectedRunwayEntryRunway = null;
              ent.SelectedRunwayEntryIndex = -1;
              rtChanged = true;
            }
          }
        }

        // `SelectedPushbackLimitPosition` & `SelectedTowPosition`: nullable FixedTaxiNavigationPoint pk refs
        for (const navField of ['SelectedPushbackLimitPosition', 'SelectedTowPosition']) {
          const refVal = ent[navField];
          if (refVal && isRefObject(refVal) && isPkRefString(refVal.$ref)) {
            const parsed = parsePkRef(refVal.$ref);
            if (!parsed || !staticAuth.authorities.has(parsed.pk)) {
              ent[navField] = null;
              rtChanged = true;
            }
          }
        }

        // `AircraftRunwayCoordinator` string arrays
        const coord = resolveGraphNode(ent.AircraftRunwayCoordinator, preRtIdx);
        if (coord && typeof coord === 'object') {
          const coordFields = [
            'CrossRunwayPermissions',
            'HoldShortAcknowledgedRunwayNames',
            'RunwayFenceCurrentEnterRunways',
            'RunwayGuardCurrentEnterRunway',
            'TaxiBlockingRunwayNames',
            'TaxiPathUnPassedIntersectionRunwayNames',
          ];
          for (const cf of coordFields) {
            const rWrap = resolveGraphNode(coord[cf], preRtIdx);
            if (!rWrap) continue;
            const aWrap = resolveGraphNode(rWrap.value, preRtIdx);
            if (!aWrap || !Array.isArray(aWrap.values) || aWrap.values.length === 0) continue;
            const prevArr = aWrap.values;
            const nextArr = prevArr
              .map((nm) => remapPhysOrKeep(remapEndOrKeep(nm)))
              .filter((nm) => liveEnds.has(nm) || livePhysNames.has(nm));
            if (nextArr.length !== prevArr.length || nextArr.some((v, idx) => v !== prevArr[idx])) {
              coord[cf] = makeReactive(makeTypedArray('System.String[]', nextArr));
              rtChanged = true;
            }
          }
        }
      } else if (k === 'singleton:game-event-schedule') {
        if (Array.isArray(ent.EventQueue) && ent.EventQueue.length > 0) {
          const prevLen = ent.EventQueue.length;
          ent.EventQueue = ent.EventQueue.filter((rawEv) => {
            const ev = resolveGraphNode(rawEv, preRtIdx);
            if (!ev || typeof ev !== 'object') return false;
            if (typeof ev.PhysicalRunwayName === 'string') {
              const mapped = remapPhysOrKeep(ev.PhysicalRunwayName);
              if (mapped !== ev.PhysicalRunwayName) {
                ev.PhysicalRunwayName = mapped;
                rtChanged = true;
              }
              if (!livePhysNames.has(ev.PhysicalRunwayName)) return false;
            }
            if (typeof ev.newRunwayPk === 'string' && ev.newRunwayPk.startsWith('runway:')) {
              const oldEnd = ev.newRunwayPk.slice('runway:'.length);
              const nextEnd = remapEndOrKeep(oldEnd);
              const nextPk = `runway:${nextEnd}`;
              if (nextPk !== ev.newRunwayPk) {
                ev.newRunwayPk = nextPk;
                rtChanged = true;
              }
              if (!staticAuth.authorities.has(ev.newRunwayPk)) return false;
            }
            return true;
          });
          if (ent.EventQueue.length !== prevLen) rtChanged = true;
        }
      } else if (k === 'singleton:scoring-state') {
        for (const rwyListKey of ['ActiveIncursions', 'IncursionMessageCooldowns', 'Incursions']) {
          if (Array.isArray(ent[rwyListKey]) && ent[rwyListKey].length > 0) {
            const prevLen = ent[rwyListKey].length;
            ent[rwyListKey] = ent[rwyListKey].filter((rawRec) => {
              const rec = resolveGraphNode(rawRec, preRtIdx);
              if (!rec) return false;
              if (typeof rec.Runway === 'string') {
                const mapped = remapPhysOrKeep(remapEndOrKeep(rec.Runway));
                if (mapped !== rec.Runway) {
                  rec.Runway = mapped;
                  rtChanged = true;
                }
                if (!liveEnds.has(rec.Runway) && !livePhysNames.has(rec.Runway)) return false;
              }
              return true;
            });
            if (ent[rwyListKey].length !== prevLen) rtChanged = true;
          }
        }
        if (Array.isArray(ent.WakeChecks) && ent.WakeChecks.length > 0) {
          const prevLen = ent.WakeChecks.length;
          ent.WakeChecks = ent.WakeChecks.filter((rawRec) => {
            const rec = resolveGraphNode(rawRec, preRtIdx);
            if (!rec) return false;
            if (typeof rec.PhysicalRunwayName === 'string') {
              const mapped = remapPhysOrKeep(rec.PhysicalRunwayName);
              if (mapped !== rec.PhysicalRunwayName) {
                rec.PhysicalRunwayName = mapped;
                rtChanged = true;
              }
              if (!livePhysNames.has(rec.PhysicalRunwayName)) return false;
            }
            if (typeof rec.PhysicalRunwayPk === 'string') {
              const mappedPk = physPatchMap.get(rec.PhysicalRunwayPk) || rec.PhysicalRunwayPk;
              if (mappedPk !== rec.PhysicalRunwayPk) {
                rec.PhysicalRunwayPk = mappedPk;
                rtChanged = true;
              }
              if (!validPhysKeys.has(rec.PhysicalRunwayPk)) return false;
            }
            return true;
          });
          if (ent.WakeChecks.length !== prevLen) rtChanged = true;
        }
      }
    }

    if (rtChanged) {
      frame.runtimeData = normalizeDocumentGraph(
        frame.runtimeData,
        schema.roots.runtime,
        schema,
        preRtIdx,
      );
      frame.dirtyRuntimeData = true;
    }
  }
}

function applySceneryGraphEdits(container, editIntent) {
  const graph = editIntent.sceneryGraph;
  const mm = editIntent.sceneryMeta || {};
  if (!graph || typeof graph !== 'object') {
    throw new Error('applySceneryGraphEdits: editIntent.sceneryGraph is required');
  }

  const warnings = [];
  const warn = (w) => {
    warnings.push(w);
  };

  const schema = getSchemaForHash(container.header.schemaHash);
  const preStaticIdx = indexDocumentGraph(container.staticData, schema.roots.static, schema);
  const pkDict = resolveGraphNode(container.staticData.PKStaticEntities, preStaticIdx);
  const siDict = resolveGraphNode(container.staticData.StaticItems, preStaticIdx);
  const npkList = Array.isArray(container.staticData.NonPKStaticEntities)
    ? container.staticData.NonPKStaticEntities
    : [];
  if (!pkDict || !siDict) {
    throw new Error('applySceneryGraphEdits: StaticData PKStaticEntities / StaticItems missing');
  }

  // Materialize top-level entries with their resolved JS objects
  const origPkEntries = dictEntries(pkDict).map(([pk, rawVal]) => [pk, resolveGraphNode(rawVal, preStaticIdx)]);
  const pkTypeOrder = computePkTypeOrder(origPkEntries);
  const origPkMap = new Map(origPkEntries);

  const origNpkItems = npkList.map((rawVal, idx) => {
    const obj = resolveGraphNode(rawVal, preStaticIdx);
    const origId = obj && obj.$id != null ? parseInt(String(obj.$id), 10) : (idx + 1);
    return { obj, origId, idx };
  });

  // Shared `System.String[]` empty array for FixedTaxiNavigationPoint.CrossTaxiwayNames
  let sharedCrossTaxiwayArr = null;
  for (const [pk, obj] of origPkEntries) {
    if (pk.startsWith('taxi-navigation:') && obj?.CrossTaxiwayNames) {
      const arrWrap = resolveGraphNode(obj.CrossTaxiwayNames, preStaticIdx);
      if (arrWrap && Array.isArray(arrWrap.values) && arrWrap.values.length === 0) {
        sharedCrossTaxiwayArr = arrWrap;
        break;
      }
    }
  }
  if (!sharedCrossTaxiwayArr) {
    sharedCrossTaxiwayArr = makeTypedArray('System.String[]', []);
  }

  const deletedPks = new Set([...(mm.deletedPks || []), ...(mm.deletedAirwayPks || [])]);
  const deletedAreaIds = new Set(mm.deletedAreaIds || []);

  const hasNew = hasNull(mm.nodeOrigPk) || hasNull(mm.segOrigPk)
    || hasNull(mm.runwayOrigPk) || hasNull(mm.standOrigPk)
    || hasNull(mm.areaOrigId) || hasNull(mm.airwayNodeOrigPk) || hasNull(mm.airwaySegOrigPk)
    || arrayLongerThan(mm.nodeOrigPk, graph.nodes)
    || arrayLongerThan(mm.segOrigPk, graph.segments)
    || arrayLongerThan(mm.runwayOrigPk, graph.runways)
    || arrayLongerThan(mm.standOrigPk, graph.stands)
    || arrayLongerThan(mm.areaOrigId, graph.areas)
    || arrayLongerThan(mm.airwayNodeOrigPk, graph.airwayNodes)
    || arrayLongerThan(mm.airwaySegOrigPk, graph.procedures);

  // ─── 1. Runway survival, rename, width, and orphan analysis ──────
  const expectedRunwayPks = new Set();
  const expectedPhysicalSet = new Set();
  for (const rw of graph.runways || []) {
    let names;
    let phys;
    if (Array.isArray(rw.names) && rw.names.length >= 2) {
      names = [String(rw.names[0]), String(rw.names[1])];
      phys = rw.physicalName || names.join('/');
    } else {
      const parts = String(rw.physicalName || '').split('/');
      const n1 = rw.name || parts[0] || '01';
      const n2 = parts[1] || (n1 === '01' ? '19' : '01');
      names = [n1, n2];
      phys = rw.physicalName || `${n1}/${n2}`;
    }
    expectedRunwayPks.add(`runway:${names[0]}`);
    expectedRunwayPks.add(`runway:${names[1]}`);
    expectedPhysicalSet.add(phys);
  }

  let runwayDirty = false;
  const runwayPatchInfo = new Map(); // oldPk -> { oldName, newName, oldPhys, newPhys, newWidth, widthChanged }
  const physPatchMap = new Map(); // 'physical-runway:old' -> 'physical-runway:new'

  if (Array.isArray(mm.runwayOrigInfo)) {
    for (let i = 0; i < (graph.runways || []).length && i < mm.runwayOrigInfo.length; i++) {
      const orig = mm.runwayOrigInfo[i];
      const cur = graph.runways[i];
      if (!orig || !cur) continue;
      if (mm.runwayOrigPk && mm.runwayOrigPk[i] == null) continue;
      const origNames = orig.names || [];
      const curNames = Array.isArray(cur.names) && cur.names.length >= 2
        ? [String(cur.names[0]), String(cur.names[1])]
        : [String(cur.name || ''), String(cur.physicalName || '').split('/')[1] || ''];
      const origPhys = orig.physicalName;
      const endNamesChanged = curNames[0] !== origNames[0] || curNames[1] !== origNames[1];
      let curPhys = cur.physicalName || origPhys;
      if (endNamesChanged && curPhys === origPhys) {
        curPhys = `${curNames[0]}/${curNames[1]}`;
        cur.physicalName = curPhys;
      }
      const widthChanged = cur.width != null && orig.width != null && Math.abs(cur.width - orig.width) > 1e-9;
      const namesChanged = endNamesChanged || origPhys !== curPhys;
      if (namesChanged || widthChanged) runwayDirty = true;
      if (origPhys !== curPhys) {
        physPatchMap.set(`physical-runway:${origPhys}`, `physical-runway:${curPhys}`);
      }
      for (const oldPk of orig.pks || []) {
        const oldName = oldPk.split(':')[1];
        let newName;
        if (oldName === origNames[0]) newName = curNames[0];
        else if (oldName === origNames[1]) newName = curNames[1];
        else {
          const idx = (orig.pks || []).indexOf(oldPk);
          newName = curNames[idx] || curNames[0];
        }
        runwayPatchInfo.set(oldPk, {
          oldName,
          newName,
          oldPhys: origPhys,
          newPhys: curPhys,
          newWidth: cur.width,
          widthChanged,
        });
      }
    }
  }

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

  const orphanRunwayPks = new Set();
  for (const [pk] of origPkEntries) {
    if (pkPrefix(pk) !== 'runway') continue;
    if (!expectedRunwayPks.has(pk) && !runwayPatchInfo.has(pk)) {
      orphanRunwayPks.add(pk);
    }
  }

  const orphanSiPks = new Set();
  const expectedSiPhysPks = new Set([...expectedPhysicalSet].map((p) => `physical-runway:${p}`));
  for (const [pk] of dictEntries(siDict)) {
    if (!pk.startsWith('physical-runway:')) continue;
    if (!expectedSiPhysPks.has(pk) && !physPatchMap.has(pk)) {
      orphanSiPks.add(pk);
    }
  }

  // Initial deletion sets
  const pkToDelete = new Set();
  for (const [pk] of origPkEntries) {
    const pref = pkPrefix(pk);
    if (!MANAGED_PK_TYPES.has(pref)) continue;
    if (deletedPks.has(pk)) pkToDelete.add(pk);
    else if (pref === 'runway' && orphanRunwayPks.has(pk) && !runwayPatchInfo.has(pk)) {
      pkToDelete.add(pk);
    }
  }

  // ─── 2. Rescue runway structural TaxiwayNodes from accidental deletion ───
  {
    const objToPk = new Map();
    for (const [pk, obj] of origPkEntries) {
      if (obj && pkPrefix(pk) === 'taxiway-node') objToPk.set(obj, pk);
    }
    for (let pass = 0; pass < 3; pass++) {
      const referencedNodePks = new Set();
      for (const [pk, rwObj] of origPkEntries) {
        if (pkToDelete.has(pk) || pkPrefix(pk) !== 'runway' || !rwObj) continue;
        for (const ref of unwrapTypedArray(rwObj.ThresholdPoints, preStaticIdx)) {
          const nObj = resolveGraphNode(ref, preStaticIdx);
          const nPk = objToPk.get(nObj);
          if (nPk) referencedNodePks.add(nPk);
        }
        for (const ref of unwrapTypedArray(rwObj.EdgePoints, preStaticIdx)) {
          const nObj = resolveGraphNode(ref, preStaticIdx);
          const nPk = objToPk.get(nObj);
          if (nPk) referencedNodePks.add(nPk);
        }
        for (const singleRef of [rwObj.TouchDownPoint, rwObj.LabelPositionNode]) {
          const nObj = resolveGraphNode(singleRef, preStaticIdx);
          const nPk = objToPk.get(nObj);
          if (nPk) referencedNodePks.add(nPk);
        }
      }
      let rescued = 0;
      for (const nPk of referencedNodePks) {
        if (pkToDelete.has(nPk)) {
          pkToDelete.delete(nPk);
          deletedPks.delete(nPk);
          rescued++;
        }
      }
      if (rescued === 0) break;
    }
  }

  // ─── 3. Survivor Dangling-Reference Gate ─────────────────────────
  let refGateDirty = false;
  const droppedRunwayPhys = new Set();

  const deadTaxiNodeCoords = new Map(); // nodeObj -> { x, z }
  const liveTaxiNodeByCoord = new Map(); // coordKey -> nodeObj
  const deadAirwayNodeCoords = new Map(); // anodeObj -> { x, z }
  const liveAirwayNodeByCoord = new Map(); // coordKey -> anodeObj
  const deadStandObjs = new Set();

  for (const [pk, obj] of origPkEntries) {
    if (!obj) continue;
    const pref = pkPrefix(pk);
    if (pref === 'taxiway-node') {
      const pos = getTaxiwayNodeGu(obj, preStaticIdx);
      if (!pos) continue;
      if (pkToDelete.has(pk)) {
        deadTaxiNodeCoords.set(obj, pos);
      } else {
        const ck = coordKey(pos.x, pos.z);
        if (!liveTaxiNodeByCoord.has(ck)) liveTaxiNodeByCoord.set(ck, obj);
      }
    } else if (pref === 'airway-node') {
      if (!Array.isArray(obj.Position) || obj.Position.length < 3) continue;
      const pos = decodePosition3ToGu(obj.Position);
      if (pkToDelete.has(pk)) {
        deadAirwayNodeCoords.set(obj, pos);
      } else {
        const ck = coordKey(pos.x, pos.z);
        if (!liveAirwayNodeByCoord.has(ck)) liveAirwayNodeByCoord.set(ck, obj);
      }
    } else if (pref === 'stand' && pkToDelete.has(pk)) {
      deadStandObjs.add(obj);
    }
  }

  const resolveReplacementTaxiNode = (nObj) => {
    if (!nObj) return null;
    if (!deadTaxiNodeCoords.has(nObj)) return nObj;
    const pos = deadTaxiNodeCoords.get(nObj);
    return liveTaxiNodeByCoord.get(coordKey(pos.x, pos.z)) || null;
  };

  if (deadTaxiNodeCoords.size > 0) {
    for (const [pk, obj] of origPkEntries) {
      if (!obj || pkToDelete.has(pk)) continue;
      const pref = pkPrefix(pk);

      if (pref === 'taxiway-segment') {
        const rawNodes = unwrapReactive(obj.Nodes, preStaticIdx) || [];
        const resolvedNodes = rawNodes.map((r) => resolveGraphNode(r, preStaticIdx)).filter(Boolean);
        let touched = false;
        const nextNodes = [];
        for (const nObj of resolvedNodes) {
          if (deadTaxiNodeCoords.has(nObj)) {
            touched = true;
            const twin = resolveReplacementTaxiNode(nObj);
            if (twin && (nextNodes.length === 0 || nextNodes[nextNodes.length - 1] !== twin)) {
              nextNodes.push(twin);
            }
          } else if (nextNodes.length === 0 || nextNodes[nextNodes.length - 1] !== nObj) {
            nextNodes.push(nObj);
          }
        }
        if (touched) {
          if (new Set(nextNodes).size < 2) {
            pkToDelete.add(pk);
            warn({
              key: 'ground_painter_writer_gate_dropped_unrepairable',
              params: { pk },
              text: `dropped ${pk} — referenced deleted taxiway node(s) with fewer than 2 surviving distinct nodes`,
            });
          } else {
            obj.Nodes = makeReactive(nextNodes);
            const headObj = resolveGraphNode(obj.Head, preStaticIdx);
            if (headObj && deadTaxiNodeCoords.has(headObj)) {
              obj.Head = resolveReplacementTaxiNode(headObj) || (obj.Directed ? nextNodes[0] : null);
            }
            warn({
              key: 'ground_painter_writer_gate_rewired',
              params: { pk, count: 1 },
              text: `repaired ${pk} — updated deleted-node reference(s)`,
            });
          }
          refGateDirty = true;
        }
      } else if (pref === 'stand') {
        const noseObj = resolveGraphNode(obj.NosePosition, preStaticIdx);
        const tailObj = resolveGraphNode(obj.TailPosition, preStaticIdx);
        const pbObjs = (unwrapTypedArray(obj.PushbackLimitPositions, preStaticIdx) || [])
          .map((r) => resolveGraphNode(r, preStaticIdx))
          .filter(Boolean);
        const noseDead = noseObj && deadTaxiNodeCoords.has(noseObj);
        const tailDead = tailObj && deadTaxiNodeCoords.has(tailObj);
        const pbDead = pbObjs.some((p) => deadTaxiNodeCoords.has(p));

        if (noseDead || tailDead || pbDead) {
          const nextNose = resolveReplacementTaxiNode(noseObj);
          const nextTail = resolveReplacementTaxiNode(tailObj);
          if (!nextNose || !nextTail) {
            pkToDelete.add(pk);
            deadStandObjs.add(obj);
            warn({
              key: 'ground_painter_writer_gate_dropped_unrepairable',
              params: { pk },
              text: `dropped ${pk} — nose/tail node was deleted with no replacement`,
            });
          } else {
            obj.NosePosition = nextNose;
            obj.TailPosition = nextTail;
            const nextPbs = pbObjs.map(resolveReplacementTaxiNode).filter(Boolean);
            obj.PushbackLimitPositions = makeTypedArray('ContextCross.Models.TaxiwayNode[]', nextPbs);
          }
          refGateDirty = true;
        }
      } else if (pref === 'runway') {
        const thObjs = (unwrapTypedArray(obj.ThresholdPoints, preStaticIdx) || []).map((r) => resolveGraphNode(r, preStaticIdx));
        const edgeObjs = (unwrapTypedArray(obj.EdgePoints, preStaticIdx) || []).map((r) => resolveGraphNode(r, preStaticIdx));
        const tdObj = resolveGraphNode(obj.TouchDownPoint, preStaticIdx);
        const lpObj = resolveGraphNode(obj.LabelPositionNode, preStaticIdx);

        const nextTh = thObjs.map(resolveReplacementTaxiNode);
        const nextEdge = edgeObjs.map(resolveReplacementTaxiNode);
        const nextTd = resolveReplacementTaxiNode(tdObj);
        const nextLp = resolveReplacementTaxiNode(lpObj);

        if (nextTh.length < 2 || nextTh.some((x) => !x) || nextEdge.length < 2 || nextEdge.some((x) => !x) || !nextTd || !nextLp) {
          pkToDelete.add(pk);
          const physObj = resolveGraphNode(obj.PhysicalRunwayStaticItem, preStaticIdx);
          if (physObj?.PhysicalName) droppedRunwayPhys.add(physObj.PhysicalName);
          refGateDirty = true;
          warn({
            key: 'ground_painter_writer_gate_dropped_unrepairable',
            params: { pk },
            text: `dropped ${pk} — structural runway node was deleted with no replacement`,
          });
          continue;
        }

        if (thObjs.some((x, i) => x !== nextTh[i])) {
          obj.ThresholdPoints = makeTypedArray('ContextCross.Models.TaxiwayNode[]', nextTh);
          refGateDirty = true;
        }
        if (edgeObjs.some((x, i) => x !== nextEdge[i])) {
          obj.EdgePoints = makeTypedArray('ContextCross.Models.TaxiwayNode[]', nextEdge);
          refGateDirty = true;
        }
        if (tdObj !== nextTd) { obj.TouchDownPoint = nextTd; refGateDirty = true; }
        if (lpObj !== nextLp) { obj.LabelPositionNode = nextLp; refGateDirty = true; }

        // Prune Entries / Exits touching unrepairable deleted taxiway nodes
        const rawEntries = unwrapTypedArray(obj.Entries, preStaticIdx) || [];
        let entriesTouched = false;
        const keptEntries = [];
        for (const rawEn of rawEntries) {
          const en = resolveGraphNode(rawEn, preStaticIdx);
          if (!en) continue;
          const h = resolveReplacementTaxiNode(resolveGraphNode(en.HoldingPosition, preStaticIdx));
          const l = resolveReplacementTaxiNode(resolveGraphNode(en.LineUpPosition, preStaticIdx));
          const d = resolveReplacementTaxiNode(resolveGraphNode(en.DefinePoint, preStaticIdx));
          if (!h || !l || !d) {
            entriesTouched = true;
            continue;
          }
          if (
            h !== resolveGraphNode(en.HoldingPosition, preStaticIdx) ||
            l !== resolveGraphNode(en.LineUpPosition, preStaticIdx) ||
            d !== resolveGraphNode(en.DefinePoint, preStaticIdx)
          ) {
            entriesTouched = true;
          }
          keptEntries.push({
            DefinePoint: d,
            HoldingPosition: h,
            LineUpPosition: l,
            Name: en.Name || '',
          });
        }
        if (entriesTouched) {
          obj.Entries = makeTypedArray('ContextCross.Models.Runway+Entry[]', keptEntries);
          refGateDirty = true;
        }

        const rawExits = unwrapTypedArray(obj.Exits, preStaticIdx) || [];
        let exitsTouched = false;
        const keptExits = [];
        for (const rawEx of rawExits) {
          const ex = resolveGraphNode(rawEx, preStaticIdx);
          if (!ex) continue;
          const ePos = resolveReplacementTaxiNode(resolveGraphNode(ex.ExitPosition, preStaticIdx));
          const h = resolveReplacementTaxiNode(resolveGraphNode(ex.HoldingPosition, preStaticIdx));
          const d = resolveReplacementTaxiNode(resolveGraphNode(ex.DefinePoint, preStaticIdx));
          if (!ePos || !h || !d) {
            exitsTouched = true;
            continue;
          }
          if (
            ePos !== resolveGraphNode(ex.ExitPosition, preStaticIdx) ||
            h !== resolveGraphNode(ex.HoldingPosition, preStaticIdx) ||
            d !== resolveGraphNode(ex.DefinePoint, preStaticIdx)
          ) {
            exitsTouched = true;
          }
          keptExits.push({
            DefinePoint: d,
            ExitPosition: ePos,
            HoldingPosition: h,
            IsLeft: Boolean(ex.IsLeft),
            Name: ex.Name || '',
          });
        }
        if (exitsTouched) {
          obj.Exits = makeTypedArray('ContextCross.Models.Runway+Exit[]', keptExits);
          refGateDirty = true;
        }
      }
    }
  }

  // Airway-segment dangling gate
  if (deadAirwayNodeCoords.size > 0) {
    const resolveReplacementAirwayNode = (aObj) => {
      if (!aObj) return null;
      if (!deadAirwayNodeCoords.has(aObj)) return aObj;
      const pos = deadAirwayNodeCoords.get(aObj);
      return liveAirwayNodeByCoord.get(coordKey(pos.x, pos.z)) || null;
    };

    for (const [pk, obj] of origPkEntries) {
      if (!obj || pkToDelete.has(pk) || pkPrefix(pk) !== 'airway-segment') continue;
      const rawNodes = unwrapReactive(obj.Nodes, preStaticIdx) || [];
      const resolvedNodes = rawNodes.map((r) => resolveGraphNode(r, preStaticIdx)).filter(Boolean);
      let touched = false;
      const nextNodes = [];
      for (const aObj of resolvedNodes) {
        if (deadAirwayNodeCoords.has(aObj)) {
          touched = true;
          const twin = resolveReplacementAirwayNode(aObj);
          if (twin && (nextNodes.length === 0 || nextNodes[nextNodes.length - 1] !== twin)) {
            nextNodes.push(twin);
          }
        } else if (nextNodes.length === 0 || nextNodes[nextNodes.length - 1] !== aObj) {
          nextNodes.push(aObj);
        }
      }
      if (touched) {
        if (new Set(nextNodes).size < 2) {
          pkToDelete.add(pk);
          warn({
            key: 'ground_painter_writer_gate_dropped_unrepairable',
            params: { pk },
            text: `dropped ${pk} — referenced deleted airway node(s) with fewer than 2 surviving nodes`,
          });
        } else {
          obj.Nodes = makeReactive(nextNodes);
        }
        refGateDirty = true;
      }
    }
  }

  // Cancel registry renames and drop coupled pavement strips for dropped runways
  if (droppedRunwayPhys.size > 0) {
    const work = [...droppedRunwayPhys];
    for (let wi = 0; wi < work.length; wi++) {
      const phys = work[wi];
      const oldPk = `physical-runway:${phys}`;
      const mappedPk = physPatchMap.get(oldPk);
      if (mappedPk) {
        physPatchMap.delete(oldPk);
        orphanSiPks.add(oldPk);
        orphanSiPks.add(mappedPk);
        const mappedPhys = mappedPk.slice('physical-runway:'.length);
        if (!droppedRunwayPhys.has(mappedPhys)) {
          droppedRunwayPhys.add(mappedPhys);
          work.push(mappedPhys);
        }
      } else {
        orphanSiPks.add(oldPk);
        for (const [k, v] of [...physPatchMap]) {
          if (v === oldPk) {
            physPatchMap.delete(k);
            orphanSiPks.add(k);
          }
        }
      }
    }
    for (const [pk, obj] of origPkEntries) {
      if (pkPrefix(pk) === 'taxiway-segment' && obj && droppedRunwayPhys.has(obj.Name)) {
        pkToDelete.add(pk);
      }
    }
  }

  // Cascade stand deletions to `taxi-navigation` and `jetway:*`
  const liveStandIdents = new Set();
  for (let i = 0; i < (graph.stands || []).length; i++) {
    const origPk = mm.standOrigPk && i < mm.standOrigPk.length ? mm.standOrigPk[i] : null;
    if (origPk != null && pkToDelete.has(origPk)) continue;
    const st = graph.stands[i];
    if (!st) continue;
    for (const v of [st.identifier, st.name]) {
      const s = String(v || '').trim();
      if (s) liveStandIdents.add(s);
    }
  }

  let droppedTaxiNavCount = 0;
  for (const [pk, obj] of origPkEntries) {
    if (!obj || pkToDelete.has(pk) || pkPrefix(pk) !== 'taxi-navigation') continue;
    if (obj.RelatedStand && !liveStandIdents.has(String(obj.RelatedStand).trim())) {
      pkToDelete.add(pk);
      droppedTaxiNavCount++;
      continue;
    }
    const refTarget = resolveGraphNode(obj.Reference, preStaticIdx);
    if (refTarget) {
      if (deadStandObjs.has(refTarget)) {
        pkToDelete.add(pk);
        droppedTaxiNavCount++;
        continue;
      }
      if (deadTaxiNodeCoords.has(refTarget)) {
        const twin = resolveReplacementTaxiNode(refTarget);
        if (twin) {
          obj.Reference = twin;
          refGateDirty = true;
        } else {
          pkToDelete.add(pk);
          droppedTaxiNavCount++;
        }
      }
    }
  }

  let droppedJetwayCount = 0;
  const jetwaysToDelete = new Set();
  for (const [siPk, rawVal] of dictEntries(siDict)) {
    if (!siPk.startsWith('jetway:')) continue;
    const jw = resolveGraphNode(rawVal, preStaticIdx);
    if (!jw) continue;
    const stands = (unwrapTypedArray(jw.Stands, preStaticIdx) || [])
      .map((r) => resolveGraphNode(r, preStaticIdx))
      .filter((stObj) => stObj && !deadStandObjs.has(stObj) && !pkToDelete.has(`stand:${stObj.Identifier || stObj.Name || ''}`));
    if (stands.length === 0) {
      jetwaysToDelete.add(siPk);
      droppedJetwayCount++;
    } else {
      const origLen = (unwrapTypedArray(jw.Stands, preStaticIdx) || []).length;
      if (stands.length !== origLen) {
        jw.Stands = makeTypedArray('ContextCross.Models.Stand[]', stands);
        refGateDirty = true;
      }
    }
  }

  // ─── 4. Detect survivor moves & property edits ────────────────────
  const movedByPk = new Map(); // nodePk -> { x, z }
  const movedByCoord = new Map(); // origCoordKey -> { x, z }
  const movedNodeObjs = new Map(); // nodeObj -> { x, z }
  const typeChangedByPk = new Map();
  const flagsChangedByPk = new Map();

  if (Array.isArray(mm.nodeOrigPk) && Array.isArray(graph.nodes)) {
    for (let g = 0; g < graph.nodes.length && g < mm.nodeOrigPk.length; g++) {
      const pk = mm.nodeOrigPk[g];
      if (pk == null || pkToDelete.has(pk)) continue;
      const obj = origPkMap.get(pk);
      if (!obj) continue;
      const origPos = getTaxiwayNodeGu(obj, preStaticIdx);
      const cur = graph.nodes[g];
      if (origPos && cur) {
        if (Math.abs(origPos.x - cur.x) > COORD_EPS_GU || Math.abs(origPos.z - cur.z) > COORD_EPS_GU) {
          movedByPk.set(pk, { x: cur.x, z: cur.z });
          movedByCoord.set(coordKey(origPos.x, origPos.z), { x: cur.x, z: cur.z });
          movedNodeObjs.set(obj, { x: cur.x, z: cur.z });
        }
      }
      if (cur && cur.type != null && Number(obj.Type) !== Number(cur.type)) {
        typeChangedByPk.set(pk, Number(cur.type));
      }
      if (cur && cur.flags != null && Number(obj.Flags) !== Number(cur.flags)) {
        flagsChangedByPk.set(pk, Number(cur.flags));
      }
    }
  }

  // Co-located sister TaxiwayNodes also move together
  if (movedByCoord.size > 0) {
    for (const [pk, obj] of origPkEntries) {
      if (!obj || pkToDelete.has(pk) || pkPrefix(pk) !== 'taxiway-node') continue;
      const origPos = getTaxiwayNodeGu(obj, preStaticIdx);
      if (!origPos) continue;
      const mv = movedByCoord.get(coordKey(origPos.x, origPos.z));
      if (mv) movedNodeObjs.set(obj, mv);
    }
  }

  const airwayMovedByPk = new Map();
  const airwayNodeNamePatch = new Map();
  if (Array.isArray(mm.airwayNodeOrigPk) && Array.isArray(graph.airwayNodes)) {
    for (let i = 0; i < graph.airwayNodes.length && i < mm.airwayNodeOrigPk.length; i++) {
      const pk = mm.airwayNodeOrigPk[i];
      if (pk == null || pkToDelete.has(pk)) continue;
      const obj = origPkMap.get(pk);
      const cur = graph.airwayNodes[i];
      if (!obj || !cur || !Array.isArray(obj.Position)) continue;
      const origPos = decodePosition3ToGu(obj.Position);
      if (Math.abs(origPos.x - cur.x) > COORD_EPS_GU || Math.abs(origPos.z - cur.z) > COORD_EPS_GU) {
        airwayMovedByPk.set(pk, { x: cur.x, z: cur.z });
      }
      const curName = String(cur.name || '');
      const oldName = String(obj.Name || '');
      if (curName !== oldName) {
        airwayNodeNamePatch.set(pk, curName);
      }
    }
  }

  const standNamePatch = new Map();
  const standPropsPatch = new Map();
  if (Array.isArray(mm.standOrigPk) && Array.isArray(graph.stands)) {
    for (let i = 0; i < graph.stands.length && i < mm.standOrigPk.length; i++) {
      const pk = mm.standOrigPk[i];
      if (pk == null || pkToDelete.has(pk)) continue;
      const obj = origPkMap.get(pk);
      const st = graph.stands[i];
      if (!obj || !st) continue;
      if (st.nameEdited && st.name && String(st.name) !== String(obj.Name || '')) {
        standNamePatch.set(pk, String(st.name));
      }
      const nextPark = st.parkingType != null ? Number(st.parkingType) : Number(obj.ParkingType);
      const nextEgr = st.egressType != null ? Number(st.egressType) : Number(obj.EgressType);
      if (nextPark !== Number(obj.ParkingType) || nextEgr !== Number(obj.EgressType)) {
        standPropsPatch.set(pk, { parkingType: nextPark, egressType: nextEgr });
      }
    }
  }

  const segNamePatch = new Map();
  const segDirectedPatch = new Map();
  if (Array.isArray(mm.segOrigPk) && Array.isArray(graph.segments)) {
    const editedOsmNames = new Map();
    for (let i = 0; i < graph.segments.length && i < mm.segOrigPk.length; i++) {
      const pk = mm.segOrigPk[i];
      if (pk == null || pkToDelete.has(pk)) continue;
      const obj = origPkMap.get(pk);
      const sg = graph.segments[i];
      if (!obj || !sg) continue;
      if (sg.nameEdited && sg.name && String(sg.name) !== String(obj.Name || '')) {
        segNamePatch.set(pk, String(sg.name));
        if (obj.OsmId != null) editedOsmNames.set(String(obj.OsmId), String(sg.name));
      }
      if (typeof sg.directed === 'boolean' && sg.directed !== Boolean(obj.Directed)) {
        segDirectedPatch.set(pk, sg.directed);
      }
    }
    if (editedOsmNames.size > 0) {
      for (const [pk, obj] of origPkEntries) {
        if (!obj || pkToDelete.has(pk) || pkPrefix(pk) !== 'taxiway-segment') continue;
        const nm = editedOsmNames.get(String(obj.OsmId));
        if (nm != null && String(obj.Name || '') !== nm) {
          segNamePatch.set(pk, nm);
        }
      }
    }
  }

  // Area patches & deletions
  const npkDeleteOrigIds = new Set();
  for (const item of origNpkItems) {
    if (item.obj?.$type === 'ContextCross.Models.Area' && deletedAreaIds.has(item.origId)) {
      npkDeleteOrigIds.add(item.origId);
    }
  }

  const areaPatchByOrigId = new Map();
  if (Array.isArray(graph.areas)) {
    const origAreaByOrigId = new Map();
    for (const item of origNpkItems) {
      if (item.obj?.$type === 'ContextCross.Models.Area') {
        origAreaByOrigId.set(item.origId, item.obj);
      }
    }
    for (let i = 0; i < graph.areas.length; i++) {
      const origId = Array.isArray(mm.areaOrigId) && i < mm.areaOrigId.length
        ? mm.areaOrigId[i]
        : graph.areas[i]?._origId ?? null;
      if (origId == null || npkDeleteOrigIds.has(origId)) continue;
      const areaObj = origAreaByOrigId.get(origId);
      const curArea = graph.areas[i];
      if (!areaObj || !curArea || !Array.isArray(curArea.points) || curArea.points.length < 3) continue;
      const rawPts = unwrapReactive(areaObj.NodePositions, preStaticIdx) || [];
      const curPts = curArea.points;
      let changed = rawPts.length !== curPts.length
        || (curArea.areaType != null && Number(curArea.areaType) !== Number(areaObj.AreaType));
      if (!changed) {
        for (let k = 0; k < curPts.length; k++) {
          const op = decodePosition3ToGu(rawPts[k]);
          if (Math.abs(op.x - curPts[k].x) > COORD_EPS_GU || Math.abs(op.z - curPts[k].z) > COORD_EPS_GU) {
            changed = true;
            break;
          }
        }
      }
      if (changed) {
        areaPatchByOrigId.set(origId, { curArea, rawPts });
      }
    }
  }

  // Runway Entries/Exits dirty check
  let runwayEntriesDirty = false;
  if (Array.isArray(graph.runways) && Array.isArray(mm.runwayEntriesOrig)) {
    if (graph.runways.length !== mm.runwayEntriesOrig.length) {
      runwayEntriesDirty = true;
    } else {
      for (let r = 0; r < graph.runways.length; r++) {
        const cur = graph.runways[r];
        const orig = mm.runwayEntriesOrig[r];
        if (!orig) { runwayEntriesDirty = true; break; }
        const curEn = (cur.entries || []).map((e) => `${e.runwayName}:${e.name}:${e.holdingIdx}:${e.lineUpIdx}:${e.defineIdx}`).sort().join('|');
        const origEn = (orig.entries || []).map((e) => `${e.runwayName}:${e.name}:${e.holdingIdx}:${e.lineUpIdx}:${e.defineIdx}`).sort().join('|');
        if (curEn !== origEn) { runwayEntriesDirty = true; break; }
        const curEx = (cur.exits || []).map((e) => `${e.runwayName}:${e.name}:${e.exitIdx}:${e.holdingIdx}:${e.defineIdx}:${e.isLeft}`).sort().join('|');
        const origEx = (orig.exits || []).map((e) => `${e.runwayName}:${e.name}:${e.exitIdx}:${e.holdingIdx}:${e.defineIdx}:${e.isLeft}`).sort().join('|');
        if (curEx !== origEx) { runwayEntriesDirty = true; break; }
      }
    }
  }

  // Airway Routes dirty check
  let airwayRoutesDirty = false;
  {
    const origSnap = readers.readSceneryGraph(container);
    const origProcs = origSnap.graph.procedures || [];
    const curProcs = graph.procedures || [];
    const origSegPks = mm.airwaySegOrigPk || [];
    if (curProcs.length !== origProcs.length || hasNull(origSegPks) || curProcs.length !== origSegPks.length) {
      airwayRoutesDirty = true;
    } else {
      for (let i = 0; i < curProcs.length; i++) {
        const c = curProcs[i];
        const o = origProcs[i];
        if (!o || c.name !== o.name || Number(c.routeType) !== Number(o.routeType) || c.runwayName !== o.runwayName) {
          airwayRoutesDirty = true;
          break;
        }
        const cIdxs = c.airwayNodeIdxs || [];
        const oIdxs = o.airwayNodeIdxs || [];
        if (cIdxs.length !== oIdxs.length || cIdxs.some((v, k) => v !== oIdxs[k])) {
          airwayRoutesDirty = true;
          break;
        }
      }
    }
    if (!airwayRoutesDirty && (mm.deletedAirwayPks || []).length > 0) {
      airwayRoutesDirty = true;
    }
  }

  const liveRunwayEnds = liveRunwayEndsFromGraph(graph);
  const newRunwayEnds = newRunwayPrimaryEnds(graph, mm);

  const staticDirty = hasNew
    || pkToDelete.size > 0
    || npkDeleteOrigIds.size > 0
    || orphanRunwayPks.size > 0
    || orphanSiPks.size > 0
    || droppedTaxiNavCount > 0
    || droppedJetwayCount > 0
    || refGateDirty
    || movedByPk.size > 0
    || movedByCoord.size > 0
    || typeChangedByPk.size > 0
    || flagsChangedByPk.size > 0
    || airwayMovedByPk.size > 0
    || airwayNodeNamePatch.size > 0
    || standNamePatch.size > 0
    || standPropsPatch.size > 0
    || segNamePatch.size > 0
    || segDirectedPatch.size > 0
    || areaPatchByOrigId.size > 0
    || runwayDirty
    || runwayEntriesDirty
    || airwayRoutesDirty;

  if (!staticDirty) {
    const metaChanged = reconcileMetaDataRunwayTimeline(container, oldNameToNewName, liveRunwayEnds, newRunwayEnds);
    const staticAuth = indexStaticAuthorities(container.staticData, schema, preStaticIdx);
    const validPhysKeys = new Set(
      dictEntries(siDict).map(([k]) => k).filter((k) => k.startsWith('physical-runway:')),
    );
    const validJetwayKeys = new Set(
      dictEntries(siDict).map(([k]) => k).filter((k) => k.startsWith('jetway:')),
    );
    reconcileRuntimeFramesForScenery(
      container,
      schema,
      staticAuth,
      validPhysKeys,
      physPatchMap,
      validJetwayKeys,
      oldNameToNewName,
      oldPhysToNewPhys,
      liveRunwayEnds,
      expectedPhysicalSet,
    );
    return { sceneryUpdated: metaChanged, warnings };
  }

  // ─── 5. Apply in-place patches to surviving objects ──────────────
  // Capture canonical visual signatures by OsmId BEFORE splitting/synthesizing
  const segVisualByOsm = new Map();
  {
    const groups = new Map();
    for (const [pk, obj] of origPkEntries) {
      if (!obj || pkToDelete.has(pk) || pkPrefix(pk) !== 'taxiway-segment') continue;
      const k = String(obj.OsmId);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(obj);
    }
    for (const [k, list] of groups) {
      segVisualByOsm.set(k, canonicalSegVisual(list));
    }
  }

  const workingPkEntries = [];
  for (const [origPk, obj] of origPkEntries) {
    if (!obj || pkToDelete.has(origPk)) continue;
    let curPk = origPk;
    const pref = pkPrefix(origPk);

    if (pref === 'taxiway-node') {
      const mv = movedByPk.get(origPk) || movedNodeObjs.get(obj);
      if (mv) {
        const origTuple = getTaxiwayNodeRawTuple(obj, preStaticIdx);
        obj.ReactivePosition = makeReactive(encodeUpdatedPosition3(origTuple, mv.x, mv.z));
      }
      if (typeChangedByPk.has(origPk)) obj.Type = typeChangedByPk.get(origPk);
      if (flagsChangedByPk.has(origPk)) obj.Flags = flagsChangedByPk.get(origPk);
    } else if (pref === 'airway-node') {
      const mv = airwayMovedByPk.get(origPk);
      if (mv) {
        obj.Position = encodeUpdatedPosition3(obj.Position, mv.x, mv.z);
      }
      if (airwayNodeNamePatch.has(origPk)) {
        obj.Name = airwayNodeNamePatch.get(origPk);
      }
    } else if (pref === 'stand') {
      if (standNamePatch.has(origPk)) obj.Name = standNamePatch.get(origPk);
      if (standPropsPatch.has(origPk)) {
        const p = standPropsPatch.get(origPk);
        obj.ParkingType = p.parkingType;
        obj.EgressType = p.egressType;
      }
    } else if (pref === 'taxiway-segment') {
      if (segNamePatch.has(origPk)) {
        obj.Name = segNamePatch.get(origPk);
      } else if (obj.Name && oldPhysToNewPhys.has(obj.Name)) {
        obj.Name = oldPhysToNewPhys.get(obj.Name);
      } else if (obj.Name && oldNameToNewName.has(obj.Name)) {
        obj.Name = oldNameToNewName.get(obj.Name);
      }
      if (segDirectedPatch.has(origPk)) {
        const dir = segDirectedPatch.get(origPk);
        obj.Directed = dir;
        const nodes = unwrapReactive(obj.Nodes, preStaticIdx) || [];
        const firstNode = nodes.length ? resolveGraphNode(nodes[0], preStaticIdx) : null;
        obj.Head = dir ? (resolveGraphNode(obj.Head, preStaticIdx) || firstNode) : null;
      }
    } else if (pref === 'runway') {
      if (runwayPatchInfo.has(origPk)) {
        const info = runwayPatchInfo.get(origPk);
        if (info.newName && info.newName !== info.oldName) {
          curPk = `runway:${info.newName}`;
          obj.Name = info.newName;
        }
        const physObj = resolveGraphNode(obj.PhysicalRunwayStaticItem, preStaticIdx);
        if (physObj && info.newPhys && info.newPhys !== info.oldPhys) {
          physObj.PhysicalName = info.newPhys;
          obj.PhysicalRunwayStaticItem = physObj;
        }
        if (info.widthChanged && info.newWidth != null) {
          obj.Width = encodeQ32(Number(info.newWidth) * GU_TO_METERS, 'Runway.Width');
        }
      }
    } else if (pref === 'taxi-navigation') {
      if (obj.RelatedRunway && oldNameToNewName.has(obj.RelatedRunway)) {
        obj.RelatedRunway = oldNameToNewName.get(obj.RelatedRunway);
      }
      const refTarget = resolveGraphNode(obj.Reference, preStaticIdx);
      if (Number(obj.Type) === 4 && refTarget && refTarget.$type === 'ContextCross.Models.Stand') {
        const tailNode = resolveGraphNode(refTarget.TailPosition, preStaticIdx);
        const mv = movedNodeObjs.get(tailNode);
        if (mv) {
          obj.Position = encodeUpdatedPosition3(obj.Position, mv.x, mv.z);
        }
      } else if (Number(obj.Type) === 3 && refTarget) {
        const mv = movedNodeObjs.get(refTarget);
        if (mv) {
          obj.Position = encodeUpdatedPosition3(obj.Position, mv.x, mv.z);
        }
      }
    }

    workingPkEntries.push([curPk, obj]);
  }

  // ─── 6. Synthesize newly added entities ──────────────────────────
  let minTaxiOsm = 0;
  let minAirOsm = 0;
  let maxStandNum = 0;
  const allocatedStandIdents = new Set();

  for (const [pk, obj] of origPkEntries) {
    if (!obj) continue;
    const pref = pkPrefix(pk);
    if ((pref === 'taxiway-node' || pref === 'taxiway-segment') && obj.OsmId != null) {
      const osm = Number(obj.OsmId);
      if (Number.isFinite(osm) && osm < minTaxiOsm) minTaxiOsm = osm;
    } else if ((pref === 'airway-node' || pref === 'airway-segment') && obj.OsmId != null) {
      const osm = Number(obj.OsmId);
      if (Number.isFinite(osm) && osm < minAirOsm) minAirOsm = osm;
    } else if (pref === 'stand' && !pkToDelete.has(pk)) {
      const ident = String(obj.Identifier || pk.slice(6));
      allocatedStandIdents.add(ident);
      if (/^\d+$/.test(ident)) {
        const n = parseInt(ident, 10);
        if (n > maxStandNum) maxStandNum = n;
      }
    }
  }

  let nextTaxiOsm = minTaxiOsm <= -1 ? minTaxiOsm - 1 : -1;
  let nextAirOsm = minAirOsm <= -1 ? minAirOsm - 1 : -1;
  const allocTaxiOsm = () => nextTaxiOsm--;
  const allocAirOsm = () => nextAirOsm--;

  // Map every `graph.nodes[g]` index -> `TaxiwayNode` JS object
  const nodeObjByGraphIdx = new Array((graph.nodes || []).length).fill(null);
  const currentLiveNodeByCoord = new Map();
  for (const [pk, obj] of workingPkEntries) {
    if (pkPrefix(pk) === 'taxiway-node') {
      const pos = getTaxiwayNodeGu(obj, preStaticIdx);
      if (pos) currentLiveNodeByCoord.set(coordKey(pos.x, pos.z), obj);
    }
  }

  for (let g = 0; g < (graph.nodes || []).length; g++) {
    const origPk = Array.isArray(mm.nodeOrigPk) && g < mm.nodeOrigPk.length ? mm.nodeOrigPk[g] : null;
    if (origPk != null && deletedPks.has(origPk) && pkToDelete.has(origPk)) {
      nodeObjByGraphIdx[g] = null;
      continue;
    }
    if (origPk != null && origPkMap.has(origPk) && !pkToDelete.has(origPk)) {
      nodeObjByGraphIdx[g] = origPkMap.get(origPk);
      continue;
    }
    const n = graph.nodes[g];
    if (!n) continue;
    const osm = allocTaxiOsm();
    const pk = `taxiway-node:${osm}`;
    const nodeObj = {
      $type: 'ContextCross.Models.TaxiwayNode',
      Flags: n.flags != null ? Number(n.flags) : 0,
      Name: n.name != null ? String(n.name) : null,
      OsmId: osm,
      PK: pk,
      ReactivePosition: makeReactive(encodeGuToPosition3({ x: n.x, y: 0, z: n.z })),
      Type: n.type != null ? Number(n.type) : 0,
    };
    nodeObjByGraphIdx[g] = nodeObj;
    workingPkEntries.push([pk, nodeObj]);
  }

  // New `TaxiwaySegment`s
  let tempOrdSeed = 100000;
  for (let j = 0; j < (graph.segments || []).length; j++) {
    const origPk = Array.isArray(mm.segOrigPk) && j < mm.segOrigPk.length ? mm.segOrigPk[j] : null;
    if (origPk != null) continue;
    const seg = graph.segments[j];
    if (!seg) continue;
    const nodeIdxs = seg.nodeIdxs && seg.nodeIdxs.length >= 2 ? seg.nodeIdxs : [seg.aIdx, seg.bIdx];
    const segNodeObjs = nodeIdxs.map((ni) => nodeObjByGraphIdx[ni]).filter(Boolean);
    if (segNodeObjs.length < 2) {
      warn({
        key: 'ground_painter_writer_new_segment_dropped',
        params: { indices: JSON.stringify(nodeIdxs) },
        text: `dropped a new taxiway segment: endpoint node(s) no longer exist (${JSON.stringify(nodeIdxs)})`,
      });
      continue;
    }
    let selfLoop = false;
    for (let i = 1; i < segNodeObjs.length; i++) {
      if (segNodeObjs[i - 1] === segNodeObjs[i]) {
        selfLoop = true;
        break;
      }
    }
    if (selfLoop) {
      warn({
        key: 'ground_painter_writer_new_segment_dropped',
        params: { indices: JSON.stringify(nodeIdxs) },
        text: `dropped a new taxiway segment: consecutive endpoints resolve to same node (${JSON.stringify(nodeIdxs)})`,
      });
      continue;
    }

    const segOsm = seg.parentOsm != null ? Number(seg.parentOsm) : allocTaxiOsm();
    const parentVis = seg.parentOsm != null ? segVisualByOsm.get(String(seg.parentOsm)) : null;
    const directed = parentVis ? parentVis.directed : Boolean(seg.directed);
    const flags = parentVis ? parentVis.flags : (seg.flags != null ? Number(seg.flags) : 0);
    const isHidden = parentVis ? parentVis.isHidden : Boolean(seg.isHidden);
    const isUnselectable = parentVis ? parentVis.isUnselectable : Boolean(seg.isUnselectable);
    const segName = parentVis ? parentVis.name : String(seg.name ?? '');

    if (droppedRunwayPhys.has(segName)) continue;

    const tempPk = `taxiway-segment:${segOsm}:${tempOrdSeed++}`;
    const segObj = {
      $type: 'ContextCross.Models.TaxiwaySegment',
      Directed: directed,
      Flags: flags,
      Head: directed ? segNodeObjs[0] : null,
      IsHidden: isHidden,
      IsUnselectable: isUnselectable,
      Name: oldPhysToNewPhys.get(segName) || oldNameToNewName.get(segName) || segName,
      Nodes: makeReactive(segNodeObjs),
      OsmId: segOsm,
      PK: tempPk,
    };
    workingPkEntries.push([tempPk, segObj]);
  }

  // New `Stand`s (+ `taxi-navigation` + `jetway:*`)
  const newJetwayEntries = [];
  let nextStandNum = maxStandNum + 1;
  for (let stIdx = 0; stIdx < (graph.stands || []).length; stIdx++) {
    const origPk = Array.isArray(mm.standOrigPk) && stIdx < mm.standOrigPk.length ? mm.standOrigPk[stIdx] : null;
    if (origPk != null) continue;
    const stand = graph.stands[stIdx];
    if (!stand) continue;

    let ident;
    const desired = stand.identifier != null ? String(stand.identifier).trim() : '';
    if (desired && !desired.includes(':') && !desired.includes('"') && !allocatedStandIdents.has(desired)) {
      ident = desired;
      allocatedStandIdents.add(ident);
      const asNum = parseInt(desired, 10);
      if (!Number.isNaN(asNum) && String(asNum) === desired && asNum >= nextStandNum) {
        nextStandNum = asNum + 1;
      }
    } else {
      ident = String(nextStandNum++);
      while (allocatedStandIdents.has(ident)) ident = String(nextStandNum++);
      allocatedStandIdents.add(ident);
    }

    const noseObj = nodeObjByGraphIdx[stand.noseIdx];
    const tailObj = nodeObjByGraphIdx[stand.tailIdx];
    const pbObjs = (stand.pushbackIdxs || []).map((i) => nodeObjByGraphIdx[i]).filter(Boolean);
    if (!noseObj || !tailObj) {
      warn({
        key: 'ground_painter_writer_new_stand_dropped',
        params: { ident, index: !noseObj ? stand.noseIdx : stand.tailIdx },
        text: `dropped a new stand (${ident}): nose/tail node missing`,
      });
      continue;
    }

    const standPk = `stand:${ident}`;
    const standObj = {
      $type: 'ContextCross.Models.Stand',
      EgressType: stand.egressType != null ? Number(stand.egressType) : 0,
      Identifier: ident,
      Name: stand.name ? String(stand.name) : ident,
      NosePosition: noseObj,
      ParkingType: stand.parkingType != null ? Number(stand.parkingType) : 1,
      PushbackLimitPositions: makeTypedArray('ContextCross.Models.TaxiwayNode[]', pbObjs),
      TailPosition: tailObj,
    };
    workingPkEntries.push([standPk, standObj]);

    const tailCoord = graph.nodes[stand.tailIdx];
    const standNavPk = `taxi-navigation:stand:${ident}`;
    const standNavPos = tailCoord
      ? encodeGuToPosition3({ x: tailCoord.x, y: 0, z: tailCoord.z })
      : [...(getTaxiwayNodeRawTuple(tailObj, preStaticIdx) || [0, 0, 0])];
    workingPkEntries.push([standNavPk, {
      $type: 'ContextCross.Models.FixedTaxiNavigationPoint',
      CrossTaxiwayNames: sharedCrossTaxiwayArr,
      Direction: null,
      PK: standNavPk,
      Position: standNavPos,
      Reference: standObj,
      RelatedRunway: '',
      RelatedStand: ident,
      TaxiwayName: '',
      Type: 4,
    }]);

    for (let p = 0; p < (stand.pushbackIdxs || []).length; p++) {
      const pbIdx = stand.pushbackIdxs[p];
      const pbNodeObj = nodeObjByGraphIdx[pbIdx];
      const pbCoord = graph.nodes[pbIdx];
      if (!pbNodeObj || !pbCoord || pbNodeObj.OsmId == null) continue;
      const pbNavPk = `taxi-navigation:pushback:${ident}:${pbNodeObj.OsmId}`;
      workingPkEntries.push([pbNavPk, {
        $type: 'ContextCross.Models.FixedTaxiNavigationPoint',
        CrossTaxiwayNames: sharedCrossTaxiwayArr,
        Direction: null,
        PK: pbNavPk,
        Position: encodeGuToPosition3({ x: pbCoord.x, y: 0, z: pbCoord.z }),
        Reference: pbNodeObj,
        RelatedRunway: '',
        RelatedStand: ident,
        TaxiwayName: '',
        Type: 3,
      }]);
    }

    const pType = stand.parkingType != null ? Number(stand.parkingType) : 1;
    if (pType === 1) {
      const jwPk = `jetway:${ident}`;
      newJetwayEntries.push([jwPk, {
        $type: 'ContextCross.Models.JetwayStaticItem',
        InitialAutoUndockFinished: false,
        InitialProgress: 0,
        InitialStatus: 0,
        Name: ident,
        Stands: makeTypedArray('ContextCross.Models.Stand[]', [standObj]),
      }]);
    }
  }

  // New `Runway` pairs (+ 4 derived edge/touchdown TaxiwayNodes + shared PhysicalRunwayStaticItem)
  const newPhysItemsByName = new Map();
  for (let k = 0; k < (graph.runways || []).length; k++) {
    const origPk = Array.isArray(mm.runwayOrigPk) && k < mm.runwayOrigPk.length ? mm.runwayOrigPk[k] : null;
    if (origPk != null) continue;
    const rw = graph.runways[k];
    if (!rw) continue;

    const thAObj = nodeObjByGraphIdx[rw.thAIdx];
    const thBObj = nodeObjByGraphIdx[rw.thBIdx];
    const aCoord = graph.nodes[rw.thAIdx];
    const bCoord = graph.nodes[rw.thBIdx];
    if (!thAObj || !thBObj || !aCoord || !bCoord) {
      const rwLabel = Array.isArray(rw.names) && rw.names.length >= 2
        ? rw.names.join('/')
        : (rw.physicalName || rw.name || `index ${k}`);
      warn({
        key: 'ground_painter_writer_new_runway_dropped',
        params: { phys: String(rwLabel), index: !thAObj ? rw.thAIdx : rw.thBIdx },
        text: `dropped a new runway (${rwLabel}): threshold node missing`,
      });
      continue;
    }

    let nameA;
    let nameB;
    if (Array.isArray(rw.names) && rw.names.length >= 2) {
      nameA = String(rw.names[0] || '01');
      nameB = String(rw.names[1] || '19');
    } else {
      const parts = String(rw.physicalName || '').split('/');
      nameA = String(rw.name || parts[0] || '01');
      nameB = String(parts[1] || (nameA === '01' ? '19' : '01'));
    }
    const phys = `${nameA}/${nameB}`;
    const widthGu = rw.width != null && Number(rw.width) !== 0 ? Number(rw.width) : 0.50;

    const dx = bCoord.x - aCoord.x;
    const dz = bCoord.z - aCoord.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;

    const makeDerivedTaxiNode = (cx, cz) => {
      const osm = allocTaxiOsm();
      const pk = `taxiway-node:${osm}`;
      const nObj = {
        $type: 'ContextCross.Models.TaxiwayNode',
        Flags: 0,
        Name: null,
        OsmId: osm,
        PK: pk,
        ReactivePosition: makeReactive(encodeGuToPosition3({ x: cx, y: 0, z: cz })),
        Type: 1,
      };
      workingPkEntries.push([pk, nObj]);
      return nObj;
    };

    const edgeAObj = makeDerivedTaxiNode(aCoord.x - ux * RW_EDGE_OFFSET, aCoord.z - uz * RW_EDGE_OFFSET);
    const edgeBObj = makeDerivedTaxiNode(bCoord.x + ux * RW_EDGE_OFFSET, bCoord.z + uz * RW_EDGE_OFFSET);
    const tdAObj = makeDerivedTaxiNode(aCoord.x + ux * RW_TD_OFFSET, aCoord.z + uz * RW_TD_OFFSET);
    const tdBObj = makeDerivedTaxiNode(bCoord.x - ux * RW_TD_OFFSET, bCoord.z - uz * RW_TD_OFFSET);

    const halfW = widthGu / 2;
    const px = (-uz) * halfW;
    const pz = ux * halfW;
    const aE = { x: aCoord.x - ux * RW_EDGE_OFFSET, z: aCoord.z - uz * RW_EDGE_OFFSET };
    const bE = { x: bCoord.x + ux * RW_EDGE_OFFSET, z: bCoord.z + uz * RW_EDGE_OFFSET };
    const makeAreaVerts = () => makeTypedArray('GroundAtc.Numerics.Position3[]', [
      encodeGuToPosition3({ x: aE.x - px, y: 0, z: aE.z - pz }),
      encodeGuToPosition3({ x: bE.x - px, y: 0, z: bE.z - pz }),
      encodeGuToPosition3({ x: bE.x + px, y: 0, z: bE.z + pz }),
      encodeGuToPosition3({ x: aE.x + px, y: 0, z: aE.z + pz }),
    ]);

    const inferredHoldings = inferHoldingsForRunway(graph, rw, ux, uz);
    const makeHoldingsArr = () => makeTypedArray(
      'ContextCross.Models.Runway+HoldingAreaData[]',
      inferredHoldings.map((h) => ({
        EntryName: String(h.entryName || ''),
        Vertices: makeTypedArray(
          'GroundAtc.Numerics.Position3[]',
          h.vertices.map((p) => encodeGuToPosition3({ x: p.x, y: 0, z: p.z })),
        ),
      })),
    );

    const physItemObj = {
      $type: 'ContextCross.Models.PhysicalRunwayStaticItem',
      PhysicalName: phys,
    };
    newPhysItemsByName.set(phys, physItemObj);

    const widthRaw = encodeQ32(widthGu * GU_TO_METERS, 'Runway.Width');

    const buildRunwayDirObj = (dirName, edgeFirst, edgeSecond, thFirst, thSecond, tdNodeObj) => ({
      $type: 'ContextCross.Models.Runway',
      AreaVertices: makeAreaVerts(),
      EdgePoints: makeTypedArray('ContextCross.Models.TaxiwayNode[]', [edgeFirst, edgeSecond]),
      Entries: makeTypedArray('ContextCross.Models.Runway+Entry[]', []),
      Exits: makeTypedArray('ContextCross.Models.Runway+Exit[]', []),
      HoldingAreas: makeHoldingsArr(),
      LabelPositionNode: edgeFirst,
      Name: dirName,
      PhysicalRunwayStaticItem: physItemObj,
      Routes: makeTypedArray('ContextCross.Models.Runway+Route[]', []),
      ThresholdPoints: makeTypedArray('ContextCross.Models.TaxiwayNode[]', [thFirst, thSecond]),
      TouchDownPoint: tdNodeObj,
      Width: widthRaw,
    });

    workingPkEntries.push([`runway:${nameA}`, buildRunwayDirObj(nameA, edgeAObj, edgeBObj, thAObj, thBObj, tdAObj)]);
    workingPkEntries.push([`runway:${nameB}`, buildRunwayDirObj(nameB, edgeBObj, edgeAObj, thBObj, thAObj, tdBObj)]);
  }

  // Airway nodes & segments
  const airwayNodeObjByGraphIdx = new Array((graph.airwayNodes || []).length).fill(null);
  for (let i = 0; i < (graph.airwayNodes || []).length; i++) {
    const origPk = Array.isArray(mm.airwayNodeOrigPk) && i < mm.airwayNodeOrigPk.length ? mm.airwayNodeOrigPk[i] : null;
    if (origPk != null && deletedPks.has(origPk) && pkToDelete.has(origPk)) {
      airwayNodeObjByGraphIdx[i] = null;
      continue;
    }
    if (origPk != null && origPkMap.has(origPk) && !pkToDelete.has(origPk)) {
      airwayNodeObjByGraphIdx[i] = origPkMap.get(origPk);
      continue;
    }
    const an = graph.airwayNodes[i];
    if (!an) continue;
    const osm = allocAirOsm();
    const pk = `airway-node:${osm}`;
    const aObj = {
      $type: 'ContextCross.Models.AirwayNode',
      Name: an.name != null ? String(an.name) : '',
      OsmId: osm,
      PK: pk,
      Position: encodeGuToPosition3({ x: an.x, y: 0, z: an.z }),
    };
    airwayNodeObjByGraphIdx[i] = aObj;
    workingPkEntries.push([pk, aObj]);
  }

  for (let j = 0; j < (graph.procedures || []).length; j++) {
    const origPk = Array.isArray(mm.airwaySegOrigPk) && j < mm.airwaySegOrigPk.length ? mm.airwaySegOrigPk[j] : null;
    if (origPk != null) continue;
    const proc = graph.procedures[j];
    if (!proc) continue;
    const nodeIdxs = proc.airwayNodeIdxs || [];
    const segAirwayObjs = nodeIdxs.map((ni) => airwayNodeObjByGraphIdx[ni]).filter(Boolean);
    if (segAirwayObjs.length < 2) {
      warn({
        key: 'ground_painter_writer_new_segment_dropped',
        params: { indices: JSON.stringify(nodeIdxs) },
        text: `dropped a new airway segment: endpoint node(s) missing (${JSON.stringify(nodeIdxs)})`,
      });
      continue;
    }
    const segOsm = proc._parentOsm != null ? Number(proc._parentOsm) : allocAirOsm();
    const pk = `airway-segment:${segOsm}`;
    workingPkEntries.push([pk, {
      $type: 'ContextCross.Models.AirwaySegment',
      Name: String(proc.name || ''),
      Nodes: makeReactive(segAirwayObjs),
      OsmId: segOsm,
      PK: pk,
    }]);
  }

  // ─── 7. Patch Runway `Entries`/`Exits` & `Routes` ────────────────
  if (runwayEntriesDirty || runwayDirty || hasNew) {
    for (const [pk, obj] of workingPkEntries) {
      if (pkPrefix(pk) !== 'runway' || !obj) continue;
      const curDirName = pk.slice('runway:'.length);
      let gIdx = -1;
      let gRw = null;
      for (let gi = 0; gi < (graph.runways || []).length; gi++) {
        const rw = graph.runways[gi];
        if (rw && Array.isArray(rw.names) && rw.names.includes(curDirName)) {
          gIdx = gi;
          gRw = rw;
          break;
        }
      }
      if (gIdx < 0 || !gRw) continue;

      const isNewlyCreated = !(Array.isArray(mm.runwayOrigPk) && mm.runwayOrigPk[gIdx] != null);
      let dirDirty = isNewlyCreated || runwayDirty;
      const origForPhys = Array.isArray(mm.runwayEntriesOrig) ? mm.runwayEntriesOrig[gIdx] : null;
      if (!dirDirty && origForPhys) {
        const curEnKey = (gRw.entries || []).map((e) => `${e.name}:${e.holdingIdx}:${e.lineUpIdx}:${e.defineIdx}:${e.runwayName}`).sort().join('|');
        const origEnKey = (origForPhys.entries || []).map((e) => `${e.name}:${e.holdingIdx}:${e.lineUpIdx}:${e.defineIdx}:${e.runwayName}`).sort().join('|');
        const curExKey = (gRw.exits || []).map((e) => `${e.name}:${e.exitIdx}:${e.holdingIdx}:${e.defineIdx}:${e.isLeft}:${e.runwayName}`).sort().join('|');
        const origExKey = (origForPhys.exits || []).map((e) => `${e.name}:${e.exitIdx}:${e.holdingIdx}:${e.defineIdx}:${e.isLeft}:${e.runwayName}`).sort().join('|');
        dirDirty = curEnKey !== origEnKey || curExKey !== origExKey;
      }
      if (!dirDirty) continue;

      const nextEntries = [];
      for (const en of (gRw.entries || []).filter((e) => e.runwayName === curDirName)) {
        const h = en.holdingIdx != null ? nodeObjByGraphIdx[en.holdingIdx] : null;
        const l = en.lineUpIdx != null ? nodeObjByGraphIdx[en.lineUpIdx] : null;
        const d = en.defineIdx != null ? nodeObjByGraphIdx[en.defineIdx] : null;
        if (!h || !l || !d) continue;
        nextEntries.push({
          DefinePoint: d,
          HoldingPosition: h,
          LineUpPosition: l,
          Name: String(en.name || ''),
        });
      }
      const nextExits = [];
      for (const ex of (gRw.exits || []).filter((e) => e.runwayName === curDirName)) {
        const ePos = ex.exitIdx != null ? nodeObjByGraphIdx[ex.exitIdx] : null;
        const h = ex.holdingIdx != null ? nodeObjByGraphIdx[ex.holdingIdx] : null;
        const d = ex.defineIdx != null ? nodeObjByGraphIdx[ex.defineIdx] : null;
        if (!ePos || !h || !d) continue;
        nextExits.push({
          DefinePoint: d,
          ExitPosition: ePos,
          HoldingPosition: h,
          IsLeft: Boolean(ex.isLeft),
          Name: String(ex.name || ''),
        });
      }

      obj.Entries = makeTypedArray('ContextCross.Models.Runway+Entry[]', nextEntries);
      obj.Exits = makeTypedArray('ContextCross.Models.Runway+Exit[]', nextExits);
    }
  }

  if (airwayRoutesDirty || oldNameToNewName.size > 0) {
    for (const [pk, obj] of workingPkEntries) {
      if (pkPrefix(pk) !== 'runway' || !obj) continue;
      const curDirName = pk.slice('runway:'.length);
      if (!airwayRoutesDirty) {
        // If only runway renamed and procedures still carried old runwayName, check if remap needed
        const matchingOld = [...oldNameToNewName.entries()].find(([, nw]) => nw === curDirName)?.[0];
        if (!matchingOld) continue;
      }
      const procsForDir = (graph.procedures || []).filter((p) => {
        const mappedRw = oldNameToNewName.get(p.runwayName) || p.runwayName;
        return mappedRw === curDirName;
      });
      const nextRoutes = [];
      for (const p of procsForDir) {
        const aObjs = (p.airwayNodeIdxs || []).map((ni) => airwayNodeObjByGraphIdx[ni]).filter(Boolean);
        if (aObjs.length < 2) continue;
        nextRoutes.push({
          AirwayNodes: makeTypedArray('ContextCross.Models.AirwayNode[]', aObjs),
          Name: String(p.name || ''),
          RouteType: Number(p.routeType ?? 0),
        });
      }
      obj.Routes = makeTypedArray('ContextCross.Models.Runway+Route[]', nextRoutes);
    }
  }

  // ─── 8. Linear chain split, contiguous ordinal renumbering & visual consistency ───
  {
    const segGroups = new Map(); // osmStr -> [{ entryIdx, pk, obj, oldOrd, nodes }]
    for (let idx = 0; idx < workingPkEntries.length; idx++) {
      const [pk, obj] = workingPkEntries[idx];
      const m = /^taxiway-segment:(-?\d+):(\d+)$/.exec(pk);
      if (!m || !obj) continue;
      const osmStr = m[1];
      const oldOrd = parseInt(m[2], 10);
      const rawNodes = unwrapReactive(obj.Nodes, preStaticIdx) || [];
      const resolvedNodes = rawNodes.map((r) => resolveGraphNode(r, preStaticIdx)).filter(Boolean);
      const nodes = [];
      for (const nd of resolvedNodes) {
        if (nodes.length > 0) {
          const prevNd = nodes[nodes.length - 1];
          if (prevNd === nd) continue;
          const pPrev = unwrapReactive(prevNd.ReactivePosition, preStaticIdx);
          const pCur = unwrapReactive(nd.ReactivePosition, preStaticIdx);
          if (
            Array.isArray(pPrev) &&
            Array.isArray(pCur) &&
            String(pPrev[0]) === String(pCur[0]) &&
            String(pPrev[1]) === String(pCur[1]) &&
            String(pPrev[2]) === String(pCur[2])
          ) {
            continue;
          }
        }
        nodes.push(nd);
      }
      if (nodes.length < 2) {
        workingPkEntries[idx] = null;
        warn({
          key: 'ground_painter_writer_degenerate_segment_dropped',
          params: { pk },
          text: `dropped ${pk} — fewer than 2 distinct-position taxiway nodes`,
        });
        continue;
      }
      if (!segGroups.has(osmStr)) segGroups.set(osmStr, []);
      segGroups.get(osmStr).push({ entryIdx: idx, pk, obj, oldOrd, nodes });
    }

    for (const [osmStr, list] of segGroups) {
      list.sort((a, b) => a.oldOrd - b.oldOrd);
      const endpoints = list.map((it) => (
        it.nodes.length >= 2 ? [it.nodes[0], it.nodes[it.nodes.length - 1]] : [it.nodes[0] || null, it.nodes[0] || null]
      ));
      const vis = canonicalSegVisual(list.map((it) => it.obj));
      let chains;
      if (list.length <= 1) {
        chains = [list.map((_, i) => ({ i, reversed: false }))];
      } else {
        chains = splitGroupIntoLinearChains(list, endpoints);
        chains.sort((a, b) => b.length - a.length);
      }

      for (let c = 0; c < chains.length; c++) {
        const chain = chains[c];
        const chainOsm = c === 0 ? Number(osmStr) : allocTaxiOsm();
        for (let ord = 0; ord < chain.length; ord++) {
          const step = chain[ord];
          const item = list[step.i];
          const segObj = item.obj;
          const orientedNodes = step.reversed ? [...item.nodes].reverse() : item.nodes;
          const newPk = `taxiway-segment:${chainOsm}:${ord}`;
          segObj.PK = newPk;
          segObj.OsmId = chainOsm;
          segObj.Name = vis.name;
          segObj.Flags = vis.flags;
          segObj.Directed = vis.directed;
          segObj.IsHidden = vis.isHidden;
          segObj.IsUnselectable = vis.isUnselectable;
          segObj.Nodes = makeReactive(orientedNodes);
          if (!vis.directed) {
            segObj.Head = null;
          } else if (!segObj.Head) {
            segObj.Head = orientedNodes[0] || null;
          } else {
            segObj.Head = resolveGraphNode(segObj.Head, preStaticIdx);
          }
          workingPkEntries[item.entryIdx] = [newPk, segObj];
        }
      }
    }
  }

  // Regroup `PKStaticEntities` by canonical type order & rewrite `pkDict`
  const regroupedPkEntries = regroupPkEntries(workingPkEntries.filter(Boolean), pkTypeOrder);
  for (const [k] of dictEntries(pkDict)) {
    dictDelete(pkDict, k);
  }
  for (const [pk, obj] of regroupedPkEntries) {
    dictSet(pkDict, pk, obj);
  }

  // ─── 9. Rebuild `NonPKStaticEntities` (`Area`s) ──────────────────
  const nextNpkList = [];
  for (const item of origNpkItems) {
    if (!item.obj) continue;
    if (item.obj.$type === 'ContextCross.Models.Area') {
      if (npkDeleteOrigIds.has(item.origId)) continue;
      if (areaPatchByOrigId.has(item.origId)) {
        const { curArea, rawPts } = areaPatchByOrigId.get(item.origId);
        const nextPts = curArea.points.map((pt, idx) => {
          if (idx < rawPts.length && Array.isArray(rawPts[idx]) && rawPts[idx].length >= 3) {
            const origGu = decodePosition3ToGu(rawPts[idx]);
            if (Math.abs(origGu.x - pt.x) <= COORD_EPS_GU && Math.abs(origGu.z - pt.z) <= COORD_EPS_GU) {
              return rawPts[idx];
            }
            return encodeUpdatedPosition3(rawPts[idx], pt.x, pt.z);
          }
          return encodeGuToPosition3({ x: pt.x, y: 0, z: pt.z });
        });
        item.obj.AreaType = curArea.areaType != null ? Number(curArea.areaType) : Number(item.obj.AreaType ?? 1);
        item.obj.NodePositions = makeReactive(nextPts);
      }
    }
    nextNpkList.push(item.obj);
  }

  for (let i = 0; i < (graph.areas || []).length; i++) {
    const origId = Array.isArray(mm.areaOrigId) && i < mm.areaOrigId.length
      ? mm.areaOrigId[i]
      : graph.areas[i]?._origId ?? null;
    if (origId != null) continue;
    const area = graph.areas[i];
    if (!area || !Array.isArray(area.points) || area.points.length < 3) continue;
    nextNpkList.push({
      $type: 'ContextCross.Models.Area',
      AreaType: area.areaType != null ? Number(area.areaType) : 1,
      NodePositions: makeReactive(area.points.map((p) => encodeGuToPosition3({ x: p.x, y: 0, z: p.z }))),
    });
  }
  container.staticData.NonPKStaticEntities = nextNpkList;

  // ─── 10. Reconcile `StaticData.StaticItems` (`physical-runway:*`, `jetway:*`, `flight-plan:*`) ───
  // Map every live physical runway name -> exact shared `PhysicalRunwayStaticItem` JS object
  const livePhysItemByName = new Map(newPhysItemsByName);
  for (const [pk, obj] of regroupedPkEntries) {
    if (pkPrefix(pk) !== 'runway' || !obj) continue;
    const physObj = resolveGraphNode(obj.PhysicalRunwayStaticItem, preStaticIdx);
    if (physObj && physObj.PhysicalName) {
      obj.PhysicalRunwayStaticItem = physObj;
      livePhysItemByName.set(physObj.PhysicalName, physObj);
    }
  }

  for (const [siPk, rawVal] of dictEntries(siDict)) {
    if (siPk.startsWith('physical-runway:')) {
      dictDelete(siDict, siPk);
    } else if (siPk.startsWith('jetway:')) {
      if (jetwaysToDelete.has(siPk)) {
        dictDelete(siDict, siPk);
      }
    } else if (siPk.startsWith('flight-plan:') && oldNameToNewName.size > 0) {
      const fpItem = resolveGraphNode(rawVal, preStaticIdx);
      if (fpItem) {
        const arrLeg = resolveGraphNode(fpItem.InitialArrival, preStaticIdx);
        if (arrLeg && typeof arrLeg.Runway === 'string' && oldNameToNewName.has(arrLeg.Runway)) {
          arrLeg.Runway = oldNameToNewName.get(arrLeg.Runway);
        }
        const depLeg = resolveGraphNode(fpItem.InitialDeparture, preStaticIdx);
        if (depLeg && typeof depLeg.Runway === 'string' && oldNameToNewName.has(depLeg.Runway)) {
          depLeg.Runway = oldNameToNewName.get(depLeg.Runway);
        }
      }
    }
  }

  for (const [physName, physItemObj] of livePhysItemByName) {
    physItemObj.$type = 'ContextCross.Models.PhysicalRunwayStaticItem';
    dictSet(siDict, `physical-runway:${physName}`, physItemObj);
  }

  for (const [jwPk, jwObj] of newJetwayEntries) {
    if (!dictGet(siDict, jwPk)) {
      dictSet(siDict, jwPk, jwObj);
    }
  }

  // Normalize `StaticData` graph so every `$id`/`id`/`$ref` is clean & collision-free
  container.staticData = normalizeDocumentGraph(
    container.staticData,
    schema.roots.static,
    schema,
    preStaticIdx,
  );
  container.dirtyStaticData = true;

  // ─── 11. Cascade into `MetaData.RunwayTimeline` & `RuntimeData` frames ───
  reconcileMetaDataRunwayTimeline(container, oldNameToNewName, liveRunwayEnds, newRunwayEnds);

  const postStaticAuth = indexStaticAuthorities(container.staticData, schema);
  const postSiDict = resolveGraphNode(container.staticData.StaticItems, postStaticAuth.staticGraph);
  const validPhysKeys = new Set(
    dictEntries(postSiDict).map(([k]) => k).filter((k) => k.startsWith('physical-runway:')),
  );
  const validJetwayKeys = new Set(
    dictEntries(postSiDict).map(([k]) => k).filter((k) => k.startsWith('jetway:')),
  );
  const livePhysNames = new Set([...validPhysKeys].map((k) => k.slice('physical-runway:'.length)));

  reconcileRuntimeFramesForScenery(
    container,
    schema,
    postStaticAuth,
    validPhysKeys,
    physPatchMap,
    validJetwayKeys,
    oldNameToNewName,
    oldPhysToNewPhys,
    liveRunwayEnds,
    livePhysNames,
  );

  return {
    sceneryUpdated: true,
    warnings,
  };
}

module.exports = {
  applySceneryGraphEdits,
};
