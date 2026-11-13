'use strict';

/**
 * GATCARC4 v3 Pushback Path & Stand Navigation Validator (`src/acl/v3/pushback_validation.js`).
 *
 * Mirrors the exact runtime graph construction and pushback pathfinding rules used by
 * Airport Control 27 (`NavigationService.Initialize`, `NavigationService.TryProject`,
 * `TaxiTimeEstimator.GetDepartureStartOptions`, `TaxiTimeEstimator.ResolvePushbackNavigationPoint`,
 * `PushbackPathBuilder.Build`, and `GroundAtc.Navigation.Pathfinder`):
 *
 *   1. Open `TaxiwaySegment`s (`(Flags & 16) === 0`) ordered by `PK` (`Ordinal`), with `Directed`
 *      segments oriented from `Head` (`segNodes[0].PK === Head.PK`, else reversed).
 *   2. Effective projection flags: `Flags | (((Flags & 2) !== 0 && !Directed) ? 8 : 0)`.
 *      `EdgeKind`: `(Flags & 1) ? 4 (StandInternal) : (Flags & 4) ? 2 (Runway) : (Flags & 2) ? 1 (Taxiway) : 0`.
 *   3. Undirected `StandInternal` connected components (`kind === 4`) enforce `StandPhase` transitions
 *      so a pushback path cannot cut through an unrelated stand's internal lane.
 *   4. Start pose: `standDir = Normalize(Nose - Tail)`, `fromFacing = -standDir`,
 *      `aircraftPos = Nose - standDir * WheelBase` (SI meters), projected onto `mask = 1` (`StandInternal`)
 *      with `EndpointSnapTolerance = 0.01 m` and smallest-`Edge.Id` tie-breaking.
 *   5. End target: `FixedTaxiNavigationPoint` (`Type = 3`, `RelatedStand = stand.Identifier`,
 *      `Reference -> pbNode`) projected onto `mask = 3` (`StandInternal | Taxiway`).
 *   6. Dijkstra search over `(arc, standPhase)` with `MaximumTurnAngle = 120 deg` (`2*pi/3` rad),
 *      one-way arc enforcement, `EndpointTolerance = 2.0 m`, and non-zero 2D displacement.
 */

const fs = require('fs');
const path = require('path');
const {
  dictEntries,
  indexDocumentGraph,
  resolveGraphNode,
  unwrapReactive,
  unwrapTypedArray,
} = require('./graph');
const { decodeQ32 } = require('./q32');

// Exact SI meter wheelbases from GroundATC_Data/StreamingAssets/aircraft_profiles.csv (GU * 100)
const STANDARD_WHEELBASES_M = new Map([
  ['AIRBUS A-319ceo', 11.1],
  ['A319', 11.1],
  ['AIRBUS A-319neo', 11.08],
  ['A19N', 11.08],
  ['AIRBUS A-320ceo', 12.32],
  ['AIRBUS A-320P2F', 12.32],
  ['A320', 12.32],
  ['AIRBUS A-320neo', 12.3],
  ['A20N', 12.3],
  ['AIRBUS A-321neo', 16.49],
  ['A21N', 16.49],
  ['AIRBUS A-330-300', 24.98],
  ['A333', 24.98],
  ['AIRBUS A-350-900', 28.73],
  ['A359', 28.73],
  ['AIRBUS A-380-800', 29.73],
  ['A388', 29.73],
  ['BOMBARDIER CRJ700', 14.88],
  ['CRJ7', 14.88],
  ['BOMBARDIER CRJ900', 17.27],
  ['CRJ9', 17.27],
  ['BOEING 737 MAX 8', 15.6],
  ['B38M', 15.6],
  ['BOEING 737-800', 15.66],
  ['BOEING 737-800BCF', 15.66],
  ['B738', 15.66],
  ['BOEING 747-8I', 29.71],
  ['B748', 29.71],
  ['BOEING 777-300ER', 31.23],
  ['B77W', 31.23],
  ['BOEING 787-9', 25.52],
  ['B789', 25.52],
  ['COMAC C-919', 12.5],
  ['C919', 12.5],
  ['EMBRAER E-JET 170', 10.45],
  ['E170', 10.45],
  ['EMBRAER E-JET 190', 14.49],
  ['E190', 14.49],
  ['GULFSTREAM 650', 13.31],
  ['GLF6', 13.31],
]);

const DEFAULT_WHEELBASE_M = 12.32; // A320 narrowbody baseline
const ENDPOINT_SNAP_TOLERANCE_M = 0.01;
const ENDPOINT_SNAP_SQ = ENDPOINT_SNAP_TOLERANCE_M * ENDPOINT_SNAP_TOLERANCE_M;
const EXIT_TOLERANCE_M = 2.0;
const NAV_COORD_SYNC_TOLERANCE_M = 0.05;
const MAX_TURN_RAD = (2 * Math.PI) / 3; // 120 degrees
const ALLOWED_PUSHBACK_KINDS = 7; // StandInternal(4) | Runway(2) | Taxiway(1)

const _profilesCache = new Map(); // csvPath -> { mtimeMs, map }

/**
 * Resolve aircraft WheelBase map (SI meters), merging any `StreamingAssets/aircraft_profiles.csv`
 * ancestor of `filePath` onto `STANDARD_WHEELBASES_M`.
 */
function loadWheelBasesNearLevel(filePath) {
  if (!filePath || typeof filePath !== 'string') return STANDARD_WHEELBASES_M;
  const candidate = path.resolve(path.dirname(filePath), '..', '..', '..', 'aircraft_profiles.csv');
  try {
    if (!fs.existsSync(candidate)) return STANDARD_WHEELBASES_M;
    const stat = fs.statSync(candidate);
    const cached = _profilesCache.get(candidate);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.map;

    const merged = new Map(STANDARD_WHEELBASES_M);
    const lines = fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (lines.length >= 2) {
      const headers = lines[0].split(',').map((h) => h.trim());
      const typeIdx = headers.indexOf('AircraftType');
      const desigIdx = headers.indexOf('Designator');
      const wbIdx = headers.indexOf('WheelBase');
      if (typeIdx >= 0 && wbIdx >= 0) {
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols.length <= Math.max(typeIdx, wbIdx)) continue;
          const wbMeters = parseFloat(cols[wbIdx]) * 100;
          if (!Number.isFinite(wbMeters) || wbMeters <= 0) continue;
          const t = cols[typeIdx].trim();
          const d = desigIdx >= 0 && cols[desigIdx] ? cols[desigIdx].trim() : '';
          if (t) merged.set(t, wbMeters);
          if (d && !merged.has(d)) merged.set(d, wbMeters);
        }
      }
    }
    _profilesCache.set(candidate, { mtimeMs: stat.mtimeMs, map: merged });
    return merged;
  } catch (_) {
    return STANDARD_WHEELBASES_M;
  }
}

class PushbackValidationError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) && issues.length > 0
      ? issues
      : [{ standIdentifier: '?', standName: '?', pushbackPk: '(unknown)', reason: 'Unknown pushback validation error' }];
    const first = list[0];
    const formatOne = (it) => {
      const label = it.standName && it.standName !== it.standIdentifier
        ? `${it.standIdentifier} (${it.standName})`
        : `${it.standIdentifier}`;
      return `stand "${label}" [${it.pushbackPk}]: ${it.reason}`;
    };
    const preview = list.slice(0, 5).map(formatOne).join('; ');
    const suffix = list.length > 5 ? `; +${list.length - 5} more` : '';
    const message = list.length === 1
      ? `GroundPainter refusal: invalid v3 pushback path on ${preview}`
      : `GroundPainter refusal: ${list.length} invalid v3 pushback paths — ${preview}${suffix}`;
    super(message);
    this.name = 'PushbackValidationError';
    this.code = 'INVALID_PUSHBACK_PATH';
    this.standIdentifier = first.standIdentifier;
    this.standName = first.standName || first.standIdentifier;
    this.pushbackPk = first.pushbackPk;
    this.reason = first.reason;
    this.issues = list;
  }
}

class MinHeap {
  constructor() {
    this._items = [];
  }

  get size() {
    return this._items.length;
  }

  push(item) {
    const a = this._items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].dist <= a[i].dist) break;
      const tmp = a[p];
      a[p] = a[i];
      a[i] = tmp;
      i = p;
    }
  }

  pop() {
    const a = this._items;
    if (a.length === 0) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      while (true) {
        const l = (i << 1) + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && a[l].dist < a[smallest].dist) smallest = l;
        if (r < n && a[r].dist < a[smallest].dist) smallest = r;
        if (smallest === i) break;
        const tmp = a[i];
        a[i] = a[smallest];
        a[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  }
}

function comparePkOrdinal(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function rawTupleKey(tuple) {
  if (!Array.isArray(tuple) || tuple.length < 3) return '';
  const k0 = tuple[0] && typeof tuple[0] === 'object' && tuple[0].raw != null ? tuple[0].raw : String(tuple[0]);
  const k2 = tuple[2] && typeof tuple[2] === 'object' && tuple[2].raw != null ? tuple[2].raw : String(tuple[2]);
  return `${k0}:${k2}`;
}

function standPhaseTransition(phase, nextComp, startStandComp, endStandComp) {
  if (phase === 0) {
    if (nextComp === startStandComp) return 0;
    if (nextComp < 0) return 1;
    if (nextComp === endStandComp) return 2;
    return -1;
  }
  if (phase === 1) {
    if (nextComp < 0) return 1;
    if (nextComp >= 0 && nextComp === endStandComp) return 2;
    return -1;
  }
  if (phase === 2) {
    if (nextComp === endStandComp) return 2;
    return -1;
  }
  return -1;
}

/**
 * Build the in-memory `NavigationGraph` + stand/navigation lookup tables from a v3 `StaticData` root.
 */
function buildNavigationFromStaticData(staticData, schema, options = {}) {
  const profilesMap = options.wheelBaseByAircraft || STANDARD_WHEELBASES_M;
  const stIdx = indexDocumentGraph(staticData, schema.roots.static, schema);
  const pkDict = resolveGraphNode(staticData.PKStaticEntities, stIdx);
  const siDict = resolveGraphNode(staticData.StaticItems, stIdx);

  const rawTaxiNodes = [];
  const rawTaxiSegments = [];
  const standsByIdent = new Map();
  const standsList = [];
  const taxiNavPoints = [];

  for (const [pk, rawVal] of dictEntries(pkDict)) {
    const obj = resolveGraphNode(rawVal, stIdx);
    if (!obj) continue;
    if (pk.startsWith('taxiway-node:')) {
      rawTaxiNodes.push({ pk: String(obj.PK ?? pk), obj });
    } else if (pk.startsWith('taxiway-segment:')) {
      rawTaxiSegments.push({ pk: String(obj.PK ?? pk), obj });
    } else if (pk.startsWith('stand:')) {
      const ident = String(obj.Identifier ?? pk.slice(6)).trim();
      const entry = { pk, ident, obj };
      standsList.push(entry);
      if (ident) standsByIdent.set(ident, entry);
    } else if (pk.startsWith('taxi-navigation:')) {
      taxiNavPoints.push({ pk: String(obj.PK ?? pk), obj });
    }
  }

  rawTaxiNodes.sort((a, b) => comparePkOrdinal(a.pk, b.pk));
  const nodes = [];
  const nodeIndexByObj = new Map();
  const nodeIndexByPk = new Map();
  const nodeCoordKeyByPk = new Map();

  for (let i = 0; i < rawTaxiNodes.length; i++) {
    const { pk, obj } = rawTaxiNodes[i];
    const tuple = unwrapReactive(obj.ReactivePosition, stIdx);
    const x = Array.isArray(tuple) && tuple.length >= 3 ? decodeQ32(tuple[0]) : 0;
    const z = Array.isArray(tuple) && tuple.length >= 3 ? decodeQ32(tuple[2]) : 0;
    nodes.push({ id: i, pk, x, z, obj });
    nodeIndexByObj.set(obj, i);
    nodeIndexByPk.set(pk, i);
    nodeCoordKeyByPk.set(pk, rawTupleKey(tuple));
  }

  const openSegments = rawTaxiSegments.filter(({ obj }) => ((Number(obj.Flags ?? 0) & 16) === 0));
  openSegments.sort((a, b) => comparePkOrdinal(a.pk, b.pk));

  const edges = [];
  const edgeMetadata = [];
  const directedHeadErrors = new Map(); // segPk -> reason
  const segmentSignatures = new Map(); // segPk -> string
  const nodeIncidentSigs = new Map(); // nodePk -> string[]

  for (const { pk, obj } of openSegments) {
    const flags = Number(obj.Flags ?? 0);
    const directed = Boolean(obj.Directed);
    const rawList = unwrapReactive(obj.Nodes, stIdx) || [];
    const segNodes = [];
    for (const r of rawList) {
      const nObj = resolveGraphNode(r, stIdx);
      if (nObj) segNodes.push(nObj);
    }
    if (segNodes.length === 0) continue;

    const headObj = directed ? resolveGraphNode(obj.Head, stIdx) : null;
    const headPk = headObj ? String(headObj.PK ?? '') : '';
    const nodeSigPart = segNodes
      .map((n) => {
        const npk = String(n.PK ?? '');
        return `${npk}@${nodeCoordKeyByPk.get(npk) || ''}`;
      })
      .join(',');
    segmentSignatures.set(pk, `${flags}|${directed ? 1 : 0}|${headPk}|${nodeSigPart}`);

    for (const n of segNodes) {
      const npk = String(n.PK ?? '');
      if (!nodeIncidentSigs.has(npk)) nodeIncidentSigs.set(npk, []);
      nodeIncidentSigs.get(npk).push(`${pk}:${flags}:${directed ? 1 : 0}:${headPk}`);
    }

    if (directed) {
      if (!headObj) {
        directedHeadErrors.set(pk, `Directed taxiway segment "${pk}" has null Head`);
        continue;
      }
      if (String(segNodes[0].PK ?? '') !== headPk) {
        segNodes.reverse();
      }
    }

    const isTaxiway = (flags & 2) !== 0;
    const effectiveFlags = flags | ((isTaxiway && !directed) ? 8 : 0);
    const kind = (flags & 1) !== 0 ? 4 : ((flags & 4) !== 0 ? 2 : ((flags & 2) !== 0 ? 1 : 0));
    const segName = String(obj.Name ?? '');

    for (let i = 0; i < segNodes.length - 1; i++) {
      const fromIdx = nodeIndexByObj.get(segNodes[i]);
      const toIdx = nodeIndexByObj.get(segNodes[i + 1]);
      if (fromIdx == null || toIdx == null) continue;
      const a = nodes[fromIdx];
      const b = nodes[toIdx];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      if (dx === 0 && dz === 0) continue;
      const len = Math.hypot(dx, dz);
      const edgeId = edges.length;
      edges.push({
        id: edgeId,
        from: fromIdx,
        to: toIdx,
        kind,
        oneWay: directed,
        length: len,
        dirX: dx / len,
        dirZ: dz / len,
        ax: a.x,
        az: a.z,
        bx: b.x,
        bz: b.z,
      });
      edgeMetadata.push({
        segmentPk: pk,
        segmentObj: obj,
        flags: effectiveFlags,
        rawFlags: flags,
        name: segName,
      });
    }
  }

  const outgoingArcs = Array.from({ length: nodes.length }, () => []);
  const standIncidentEdges = Array.from({ length: nodes.length }, () => []);
  for (const e of edges) {
    outgoingArcs[e.from].push(2 * e.id);
    if (!e.oneWay) {
      outgoingArcs[e.to].push(2 * e.id + 1);
    }
    if (e.kind === 4) {
      standIncidentEdges[e.from].push(e.id);
      standIncidentEdges[e.to].push(e.id);
    }
  }

  const edgeStandComp = new Int32Array(edges.length).fill(-1);
  let nextComp = 0;
  for (const e of edges) {
    if (e.kind !== 4 || edgeStandComp[e.id] >= 0) continue;
    const comp = nextComp++;
    edgeStandComp[e.id] = comp;
    const queue = [e.from, e.to];
    while (queue.length > 0) {
      const nId = queue.pop();
      for (const incEdgeId of standIncidentEdges[nId]) {
        if (edgeStandComp[incEdgeId] >= 0) continue;
        edgeStandComp[incEdgeId] = comp;
        const ie = edges[incEdgeId];
        queue.push(ie.from, ie.to);
      }
    }
  }
  const nodeStandComp = new Int32Array(nodes.length).fill(-1);
  for (let nId = 0; nId < nodes.length; nId++) {
    if (standIncidentEdges[nId].length > 0) {
      nodeStandComp[nId] = edgeStandComp[standIncidentEdges[nId][0]];
    }
  }

  // Scheduled flight plans -> wheelbases per stand & scheduled stand set
  const wheelBasesByStand = new Map();
  const scheduledStandIdents = new Set();
  for (const [siK, rawSi] of dictEntries(siDict)) {
    if (!siK.startsWith('flight-plan:')) continue;
    const fp = resolveGraphNode(rawSi, stIdx);
    if (!fp) continue;
    const acType = String(fp.AircraftType ?? '').trim();
    const wb = profilesMap.get(acType) ?? DEFAULT_WHEELBASE_M;
    const dep = resolveGraphNode(fp.InitialDeparture, stIdx);
    const arr = resolveGraphNode(fp.InitialArrival, stIdx);
    for (const leg of [dep, arr]) {
      if (!leg || !leg.Stand) continue;
      const stId = String(leg.Stand).trim();
      if (!stId) continue;
      scheduledStandIdents.add(stId);
      if (!wheelBasesByStand.has(stId)) wheelBasesByStand.set(stId, new Set());
      if (Number.isFinite(wb) && wb > 0) {
        wheelBasesByStand.get(stId).add(wb);
      }
    }
  }

  // Index FixedTaxiNavigationPoints by RelatedStand
  const standPointsByStand = new Map();
  const pushbackPointsByStand = new Map();
  for (const { pk, obj } of taxiNavPoints) {
    const rel = String(obj.RelatedStand ?? '').trim();
    if (!rel) continue;
    const t = Number(obj.Type);
    if (t === 4 || pk.startsWith('taxi-navigation:stand:')) {
      if (!standPointsByStand.has(rel)) standPointsByStand.set(rel, []);
      standPointsByStand.get(rel).push({ pk, obj });
    }
    if (t === 3 || pk.startsWith('taxi-navigation:pushback:')) {
      if (!pushbackPointsByStand.has(rel)) pushbackPointsByStand.set(rel, []);
      pushbackPointsByStand.get(rel).push({ pk, obj });
    }
  }

  function tryProject(px, pz, useMask, mask) {
    let bestEdgeId = -1;
    let bestDistSq = Infinity;
    let bestFraction = 0;

    for (let i = 0; i < edges.length; i++) {
      if (useMask && !((edgeMetadata[i].flags & mask) > 0)) continue;
      const e = edges[i];
      const abx = e.bx - e.ax;
      const abz = e.bz - e.az;
      const apx = px - e.ax;
      const apz = pz - e.az;
      const abLenSq = abx * abx + abz * abz;
      let t = abLenSq > 0 ? (apx * abx + apz * abz) / abLenSq : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const cx = e.ax + abx * t;
      const cz = e.az + abz * t;
      const dx = px - cx;
      const dz = pz - cz;
      const distSq = dx * dx + dz * dz;

      if (distSq + 1e-15 < bestDistSq) {
        bestDistSq = distSq;
        bestEdgeId = i;
        const dASq = (px - e.ax) * (px - e.ax) + (pz - e.az) * (pz - e.az);
        const dBSq = (px - e.bx) * (px - e.bx) + (pz - e.bz) * (pz - e.bz);
        if (dASq <= ENDPOINT_SNAP_SQ || dBSq <= ENDPOINT_SNAP_SQ) {
          bestFraction = dASq <= dBSq ? 0 : 1;
        } else {
          const rawFrac = Math.abs(abx) >= Math.abs(abz)
            ? (cx - e.ax) / abx
            : (cz - e.az) / abz;
          bestFraction = Math.max(0, Math.min(1, rawFrac));
        }
      }
    }

    if (bestEdgeId < 0) return null;
    return {
      edgeId: bestEdgeId,
      segmentPk: edgeMetadata[bestEdgeId].segmentPk,
      fraction: bestFraction,
      dist: Math.sqrt(bestDistSq),
    };
  }

  function endpointNode(loc) {
    const e = edges[loc.edgeId];
    if (loc.fraction === 0) return e.from;
    if (loc.fraction === 1) return e.to;
    return -1;
  }

  function arcEdge(arc) { return arc >> 1; }
  function arcBackward(arc) { return (arc & 1) !== 0; }
  function arcToNode(arc) {
    const e = edges[arc >> 1];
    return (arc & 1) !== 0 ? e.from : e.to;
  }
  function arcFacing(arc) {
    const e = edges[arc >> 1];
    return (arc & 1) !== 0 ? { x: -e.dirX, z: -e.dirZ } : { x: e.dirX, z: e.dirZ };
  }

  function turnAngleOk(f1, f2) {
    const dot = Math.max(-1, Math.min(1, f1.x * f2.x + f1.z * f2.z));
    return Math.acos(dot) <= MAX_TURN_RAD + 1e-9;
  }

  function matchStopOnTraversal(edgeId, fromFrac, toFrac, endLoc, endNodeId) {
    const minF = Math.min(fromFrac, toFrac);
    const maxF = Math.max(fromFrac, toFrac);
    const stops = [];
    if (endLoc.edgeId === edgeId) {
      if (endLoc.fraction >= minF - 1e-9 && endLoc.fraction <= maxF + 1e-9) {
        stops.push(endLoc.fraction);
      }
    }
    if (endNodeId >= 0) {
      const e = edges[edgeId];
      if (e.from === endNodeId && 0 >= minF - 1e-9 && 0 <= maxF + 1e-9) {
        stops.push(0);
      }
      if (e.to === endNodeId && 1 >= minF - 1e-9 && 1 <= maxF + 1e-9) {
        stops.push(1);
      }
    }
    return stops;
  }

  function evalPointOnEdge(edgeId, frac) {
    const e = edges[edgeId];
    return {
      x: e.ax + (e.bx - e.ax) * frac,
      z: e.az + (e.bz - e.az) * frac,
    };
  }

  function checkPushbackOption(standObj, wheelBaseMeters, pushbackNavObj) {
    const noseObj = resolveGraphNode(standObj.NosePosition, stIdx);
    const tailObj = resolveGraphNode(standObj.TailPosition, stIdx);
    if (!noseObj || !tailObj) {
      return { ok: false, reason: 'Stand is missing NosePosition or TailPosition reference' };
    }
    const noseTuple = unwrapReactive(noseObj.ReactivePosition, stIdx);
    const tailTuple = unwrapReactive(tailObj.ReactivePosition, stIdx);
    if (!Array.isArray(noseTuple) || noseTuple.length < 3 || !Array.isArray(tailTuple) || tailTuple.length < 3) {
      return { ok: false, reason: 'Stand NosePosition or TailPosition is missing Q32.32 coordinates' };
    }
    const noseX = decodeQ32(noseTuple[0]);
    const noseZ = decodeQ32(noseTuple[2]);
    const tailX = decodeQ32(tailTuple[0]);
    const tailZ = decodeQ32(tailTuple[2]);

    const sdx = noseX - tailX;
    const sdz = noseZ - tailZ;
    const standLen = Math.hypot(sdx, sdz);
    if (standLen < 1e-6) {
      return { ok: false, reason: 'Stand NosePosition and TailPosition coincide (zero direction vector)' };
    }
    const standDirX = sdx / standLen;
    const standDirZ = sdz / standLen;
    const fromFacing = { x: -standDirX, z: -standDirZ };

    const acPosX = noseX - standDirX * wheelBaseMeters;
    const acPosZ = noseZ - standDirZ * wheelBaseMeters;

    const pbPosTuple = pushbackNavObj.Position;
    if (!Array.isArray(pbPosTuple) || pbPosTuple.length < 3) {
      return { ok: false, reason: 'Pushback navigation point is missing Q32.32 Position' };
    }
    const pbX = decodeQ32(pbPosTuple[0]);
    const pbZ = decodeQ32(pbPosTuple[2]);

    const startLoc = tryProject(acPosX, acPosZ, true, 1 /* StandInternal */);
    if (!startLoc) {
      return {
        ok: false,
        reason: 'No StandInternal (Flags & 1) taxiway segment available to snap aircraft start position',
      };
    }
    const endLoc = tryProject(pbX, pbZ, true, 3 /* StandInternal | Taxiway */);
    if (!endLoc) {
      return {
        ok: false,
        reason: 'No StandInternal/Taxiway (Flags & 3) segment available to snap pushback limit point',
      };
    }

    const startEdge = edges[startLoc.edgeId];
    if ((startEdge.kind & ALLOWED_PUSHBACK_KINDS) === 0) {
      return {
        ok: false,
        reason: `Start segment "${edgeMetadata[startEdge.id].segmentPk}" has disallowed EdgeKind ${startEdge.kind}`,
        startLoc,
        endLoc,
      };
    }

    const startStandComp = edgeStandComp[startLoc.edgeId];
    const endNodeId = endpointNode(endLoc);
    const endStandComp = endNodeId >= 0 ? nodeStandComp[endNodeId] : edgeStandComp[endLoc.edgeId];
    const initialPhase = startStandComp >= 0 ? 0 : 1;

    const backward = (fromFacing.x * startEdge.dirX + fromFacing.z * startEdge.dirZ) < 0;
    const initialArc = 2 * startEdge.id + (backward ? 1 : 0);
    const targetEndFrac = backward ? 0 : 1;

    if (startLoc.fraction !== targetEndFrac && backward && startEdge.oneWay) {
      return {
        ok: false,
        reason: `Pushback reverse heading opposes one-way start segment "${edgeMetadata[startEdge.id].segmentPk}"`,
        startLoc,
        endLoc,
      };
    }

    const heap = new MinHeap();
    const bestDist = new Map();

    if (startLoc.fraction !== targetEndFrac) {
      const stops = matchStopOnTraversal(startEdge.id, startLoc.fraction, targetEndFrac, endLoc, endNodeId);
      for (const sf of stops) {
        const segDist = Math.abs(sf - startLoc.fraction) * startEdge.length;
        heap.push({
          isGoal: true,
          dist: segDist,
          segments: [{ edgeId: startEdge.id, from: startLoc.fraction, to: sf }],
        });
      }
      const fullDist = Math.abs(targetEndFrac - startLoc.fraction) * startEdge.length;
      const stateKey = `${initialArc}:${initialPhase}`;
      bestDist.set(stateKey, fullDist);
      heap.push({
        isGoal: false,
        arc: initialArc,
        phase: initialPhase,
        dist: fullDist,
        segments: [{ edgeId: startEdge.id, from: startLoc.fraction, to: targetEndFrac }],
      });
    } else {
      const stops = matchStopOnTraversal(startEdge.id, targetEndFrac, targetEndFrac, endLoc, endNodeId);
      for (const sf of stops) {
        heap.push({
          isGoal: true,
          dist: 0,
          segments: [{ edgeId: startEdge.id, from: targetEndFrac, to: sf }],
        });
      }
      const stateKey = `${initialArc}:${initialPhase}`;
      bestDist.set(stateKey, 0);
      heap.push({
        isGoal: false,
        arc: initialArc,
        phase: initialPhase,
        dist: 0,
        segments: [],
      });
    }

    let winningSegments = null;
    let sharpestBlockedTurn = null;
    let standPhaseBlocked = false;

    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur.isGoal) {
        winningSegments = cur.segments;
        break;
      }
      const stateKey = `${cur.arc}:${cur.phase}`;
      if (cur.dist > (bestDist.get(stateKey) ?? Infinity) + 1e-12) continue;

      const u = arcToNode(cur.arc);
      const curFacing = arcFacing(cur.arc);

      for (const nextArc of outgoingArcs[u]) {
        const nextEdgeId = arcEdge(nextArc);
        const nextEdge = edges[nextEdgeId];
        const nextBwd = arcBackward(nextArc);
        if ((nextEdge.kind & ALLOWED_PUSHBACK_KINDS) === 0) continue;
        if (nextEdge.oneWay && nextBwd) continue;

        const nextFacing = arcFacing(nextArc);
        if (!turnAngleOk(curFacing, nextFacing)) {
          const dot = Math.max(-1, Math.min(1, curFacing.x * nextFacing.x + curFacing.z * nextFacing.z));
          const deg = (Math.acos(dot) * 180) / Math.PI;
          if (!sharpestBlockedTurn || deg < sharpestBlockedTurn.deg) {
            sharpestBlockedTurn = {
              deg,
              atNodePk: nodes[u].pk,
              fromSegPk: edgeMetadata[arcEdge(cur.arc)].segmentPk,
              toSegPk: edgeMetadata[nextEdgeId].segmentPk,
            };
          }
          continue;
        }

        const nextComp = edgeStandComp[nextEdgeId];
        const nextPhase = standPhaseTransition(cur.phase, nextComp, startStandComp, endStandComp);
        if (nextPhase < 0) {
          standPhaseBlocked = true;
          continue;
        }

        const nFromFrac = nextBwd ? 1 : 0;
        const nToFrac = nextBwd ? 0 : 1;

        const stops = matchStopOnTraversal(nextEdgeId, nFromFrac, nToFrac, endLoc, endNodeId);
        for (const sf of stops) {
          const goalDist = cur.dist + Math.abs(sf - nFromFrac) * nextEdge.length;
          heap.push({
            isGoal: true,
            dist: goalDist,
            segments: [...cur.segments, { edgeId: nextEdgeId, from: nFromFrac, to: sf }],
          });
        }

        const nextDist = cur.dist + nextEdge.length;
        const nextKey = `${nextArc}:${nextPhase}`;
        if (nextDist + 1e-12 < (bestDist.get(nextKey) ?? Infinity)) {
          bestDist.set(nextKey, nextDist);
          heap.push({
            isGoal: false,
            arc: nextArc,
            phase: nextPhase,
            dist: nextDist,
            segments: [...cur.segments, { edgeId: nextEdgeId, from: nFromFrac, to: nToFrac }],
          });
        }
      }
    }

    if (!winningSegments || winningSegments.length === 0) {
      let detail = `start snapped to ${startLoc.segmentPk} (dist=${startLoc.dist.toFixed(2)}m), end snapped to ${endLoc.segmentPk} (dist=${endLoc.dist.toFixed(2)}m)`;
      if (sharpestBlockedTurn) {
        detail += `; blocked by ${sharpestBlockedTurn.deg.toFixed(1)}° turn (> 120°) at ${sharpestBlockedTurn.atNodePk} (${sharpestBlockedTurn.fromSegPk} -> ${sharpestBlockedTurn.toSegPk})`;
      } else if (standPhaseBlocked) {
        detail += '; blocked by StandInternal component boundary';
      } else {
        detail += '; no directed taxiway path connects start to pushback limit';
      }
      return {
        ok: false,
        reason: `NavigationService returned an empty pushback path (${detail})`,
        startLoc,
        endLoc,
      };
    }

    const lastSeg = winningSegments[winningSegments.length - 1];
    const exitPos = evalPointOnEdge(lastSeg.edgeId, lastSeg.to);
    const exitDist = Math.hypot(pbX - exitPos.x, pbZ - exitPos.z);
    if (exitDist > EXIT_TOLERANCE_M + 1e-9) {
      return {
        ok: false,
        reason: `Pushback path exit is ${exitDist.toFixed(2)}m from pushback limit (> ${EXIT_TOLERANCE_M.toFixed(1)}m EndpointTolerance)`,
        startLoc,
        endLoc,
      };
    }

    let hasNonZeroDisp = false;
    for (const seg of winningSegments) {
      const p0 = evalPointOnEdge(seg.edgeId, seg.from);
      const p1 = evalPointOnEdge(seg.edgeId, seg.to);
      if (Math.hypot(p1.x - p0.x, p1.z - p0.z) > 1e-9) {
        hasNonZeroDisp = true;
        break;
      }
    }
    if (!hasNonZeroDisp) {
      return {
        ok: false,
        reason: 'Pushback path has zero 2D displacement',
        startLoc,
        endLoc,
      };
    }

    const pathSegmentPks = new Set();
    const pathNodePks = new Set();
    for (const seg of winningSegments) {
      pathSegmentPks.add(edgeMetadata[seg.edgeId].segmentPk);
      const e = edges[seg.edgeId];
      pathNodePks.add(nodes[e.from].pk);
      pathNodePks.add(nodes[e.to].pk);
    }

    return {
      ok: true,
      segments: winningSegments,
      startLoc,
      endLoc,
      pathSegmentPks,
      pathNodePks,
    };
  }

  function standIntrinsicSignature(ident) {
    const entry = standsByIdent.get(ident);
    if (!entry) return null;
    const { obj } = entry;
    const noseObj = resolveGraphNode(obj.NosePosition, stIdx);
    const tailObj = resolveGraphNode(obj.TailPosition, stIdx);
    const pbRefs = unwrapTypedArray(obj.PushbackLimitPositions, stIdx) || [];
    const pbNodes = pbRefs.map((r) => resolveGraphNode(r, stIdx));
    const nosePart = noseObj ? `${noseObj.PK}@${nodeCoordKeyByPk.get(String(noseObj.PK)) || ''}` : 'null';
    const tailPart = tailObj ? `${tailObj.PK}@${nodeCoordKeyByPk.get(String(tailObj.PK)) || ''}` : 'null';
    const pbPart = pbNodes
      .map((n) => (n ? `${n.PK}@${nodeCoordKeyByPk.get(String(n.PK)) || ''}` : 'null'))
      .join(',');
    const stPts = (standPointsByStand.get(ident) || [])
      .map((p) => {
        const ref = resolveGraphNode(p.obj.Reference, stIdx);
        return `${p.pk}:${p.obj.Type}:${ref?.Identifier || ref?.PK || ''}@${rawTupleKey(p.obj.Position)}`;
      })
      .sort()
      .join(',');
    const pbPts = (pushbackPointsByStand.get(ident) || [])
      .map((p) => {
        const ref = resolveGraphNode(p.obj.Reference, stIdx);
        return `${p.pk}:${p.obj.Type}:${ref?.PK || ''}@${rawTupleKey(p.obj.Position)}`;
      })
      .sort()
      .join(',');
    return `${Number(obj.EgressType ?? 0)}|${nosePart}|${tailPart}|${pbPart}|${stPts}|${pbPts}`;
  }

  function getTestWheelBasesForStand(ident) {
    const scheduled = [...(wheelBasesByStand.get(ident) || [])];
    return scheduled.length > 0
      ? [...new Set([...scheduled, DEFAULT_WHEELBASE_M])]
      : [DEFAULT_WHEELBASE_M];
  }

  function computeSnappingLocationsForStand(ident) {
    const entry = standsByIdent.get(ident);
    if (!entry) return [];
    const { obj: standObj } = entry;
    const noseObj = resolveGraphNode(standObj.NosePosition, stIdx);
    const tailObj = resolveGraphNode(standObj.TailPosition, stIdx);
    if (!noseObj || !tailObj) return [];
    const noseTuple = unwrapReactive(noseObj.ReactivePosition, stIdx);
    const tailTuple = unwrapReactive(tailObj.ReactivePosition, stIdx);
    if (!Array.isArray(noseTuple) || noseTuple.length < 3 || !Array.isArray(tailTuple) || tailTuple.length < 3) {
      return [];
    }
    const noseX = decodeQ32(noseTuple[0]);
    const noseZ = decodeQ32(noseTuple[2]);
    const tailX = decodeQ32(tailTuple[0]);
    const tailZ = decodeQ32(tailTuple[2]);
    const sdx = noseX - tailX;
    const sdz = noseZ - tailZ;
    const standLen = Math.hypot(sdx, sdz);
    if (standLen < 1e-6) return [];
    const standDirX = sdx / standLen;
    const standDirZ = sdz / standLen;

    const locs = [];
    for (const wb of getTestWheelBasesForStand(ident)) {
      const acX = noseX - standDirX * wb;
      const acZ = noseZ - standDirZ * wb;
      const sLoc = tryProject(acX, acZ, true, 1);
      locs.push(sLoc ? `start:${wb}:${sLoc.segmentPk}:${sLoc.fraction.toFixed(6)}:${sLoc.dist.toFixed(4)}` : `start:${wb}:null`);
    }
    for (const pbPt of pushbackPointsByStand.get(ident) || []) {
      if (!Array.isArray(pbPt.obj.Position) || pbPt.obj.Position.length < 3) continue;
      const px = decodeQ32(pbPt.obj.Position[0]);
      const pz = decodeQ32(pbPt.obj.Position[2]);
      const eLoc = tryProject(px, pz, true, 3);
      locs.push(eLoc ? `end:${pbPt.pk}:${eLoc.segmentPk}:${eLoc.fraction.toFixed(6)}:${eLoc.dist.toFixed(4)}` : `end:${pbPt.pk}:null`);
    }
    return locs;
  }

  function evaluateStand(ident, { preStandEntry = null } = {}) {
    const entry = standsByIdent.get(ident);
    if (!entry) return { issues: [], paths: [] };
    const { obj: standObj } = entry;
    const standName = String(standObj.Name ?? ident).trim() || ident;
    const issues = [];
    const paths = [];

    const noseObj = resolveGraphNode(standObj.NosePosition, stIdx);
    const tailObj = resolveGraphNode(standObj.TailPosition, stIdx);
    if (!noseObj || !tailObj) {
      issues.push({
        standIdentifier: ident,
        standName,
        pushbackPk: `taxi-navigation:stand:${ident}`,
        reason: 'Stand is missing NosePosition or TailPosition node reference',
      });
      return { issues, paths };
    }

    const noseTuple = unwrapReactive(noseObj.ReactivePosition, stIdx);
    const tailTuple = unwrapReactive(tailObj.ReactivePosition, stIdx);
    if (!Array.isArray(noseTuple) || noseTuple.length < 3 || !Array.isArray(tailTuple) || tailTuple.length < 3) {
      issues.push({
        standIdentifier: ident,
        standName,
        pushbackPk: `taxi-navigation:stand:${ident}`,
        reason: 'Stand NosePosition or TailPosition is missing Q32.32 coordinates',
      });
      return { issues, paths };
    }

    const noseX = decodeQ32(noseTuple[0]);
    const noseZ = decodeQ32(noseTuple[2]);
    const tailX = decodeQ32(tailTuple[0]);
    const tailZ = decodeQ32(tailTuple[2]);
    if (Math.hypot(noseX - tailX, noseZ - tailZ) < 1e-6) {
      issues.push({
        standIdentifier: ident,
        standName,
        pushbackPk: `taxi-navigation:stand:${ident}`,
        reason: 'Stand NosePosition and TailPosition coincide (zero direction vector)',
      });
      return { issues, paths };
    }

    // Confirm stand FixedTaxiNavigationPoint (Type = 4) exists and matches TailPosition
    const stPts = standPointsByStand.get(ident) || [];
    if (stPts.length === 0) {
      issues.push({
        standIdentifier: ident,
        standName,
        pushbackPk: `taxi-navigation:stand:${ident}`,
        reason: `Missing stand FixedTaxiNavigationPoint (Type=4, RelatedStand="${ident}")`,
      });
    } else {
      for (const sp of stPts) {
        const refObj = resolveGraphNode(sp.obj.Reference, stIdx);
        const refIdent = refObj ? String(refObj.Identifier ?? '').trim() : '';
        if (Number(sp.obj.Type) !== 4) {
          issues.push({
            standIdentifier: ident,
            standName,
            pushbackPk: sp.pk,
            reason: `Stand navigation point has Type=${sp.obj.Type} instead of Type=4`,
          });
          continue;
        }
        if (refObj !== standObj && refIdent !== ident) {
          issues.push({
            standIdentifier: ident,
            standName,
            pushbackPk: sp.pk,
            reason: `Stand navigation point Reference does not target stand "${ident}"`,
          });
          continue;
        }
        if (!Array.isArray(sp.obj.Position) || sp.obj.Position.length < 3) {
          issues.push({
            standIdentifier: ident,
            standName,
            pushbackPk: sp.pk,
            reason: 'Stand navigation point is missing Q32.32 Position',
          });
          continue;
        }
        const sx = decodeQ32(sp.obj.Position[0]);
        const sz = decodeQ32(sp.obj.Position[2]);
        if (Math.hypot(tailX - sx, tailZ - sz) > NAV_COORD_SYNC_TOLERANCE_M) {
          issues.push({
            standIdentifier: ident,
            standName,
            pushbackPk: sp.pk,
            reason: `Stand navigation point Position (${sx.toFixed(3)}, ${sz.toFixed(3)}) does not match TailPosition (${tailX.toFixed(3)}, ${tailZ.toFixed(3)})`,
          });
        }
      }
    }

    const egressType = Number(standObj.EgressType ?? 0);
    if (egressType !== 0 /* PushOut */) {
      return { issues, paths };
    }

    const pbRawRefs = unwrapTypedArray(standObj.PushbackLimitPositions, stIdx) || [];
    const pbNodes = [];
    for (let i = 0; i < pbRawRefs.length; i++) {
      const nObj = resolveGraphNode(pbRawRefs[i], stIdx);
      if (!nObj) {
        issues.push({
          standIdentifier: ident,
          standName,
          pushbackPk: `stand:${ident}#PushbackLimitPositions[${i}]`,
          reason: `Stand PushbackLimitPositions[${i}] could not be resolved to a live TaxiwayNode`,
        });
      } else {
        pbNodes.push(nObj);
      }
    }

    if (pbNodes.length === 0) {
      if (preStandEntry && preStandEntry.hadPushbackLimits) {
        const lostPk = preStandEntry.firstPushbackNavPk || `taxi-navigation:pushback:${ident}`;
        issues.push({
          standIdentifier: ident,
          standName,
          pushbackPk: lostPk,
          reason: `All pushback limit nodes were removed from surviving PushOut stand "${ident}"`,
        });
      }
      return { issues, paths };
    }

    const pbPts = pushbackPointsByStand.get(ident) || [];
    const testWbs = getTestWheelBasesForStand(ident);

    for (const pbNode of pbNodes) {
      const pbNodePk = String(pbNode.PK ?? '');
      const matchingNav = pbPts.find((p) => {
        if (Number(p.obj.Type) !== 3) return false;
        const refNode = resolveGraphNode(p.obj.Reference, stIdx);
        return refNode && String(refNode.PK ?? '') === pbNodePk;
      });
      if (!matchingNav) {
        issues.push({
          standIdentifier: ident,
          standName,
          pushbackPk: `taxi-navigation:pushback:${ident}:${pbNode.OsmId ?? pbNodePk}`,
          reason: `No FixedTaxiNavigationPoint (Type=3, RelatedStand="${ident}") references pushback node "${pbNodePk}"`,
        });
        continue;
      }

      const nTuple = unwrapReactive(pbNode.ReactivePosition, stIdx);
      if (!Array.isArray(nTuple) || nTuple.length < 3 || !Array.isArray(matchingNav.obj.Position) || matchingNav.obj.Position.length < 3) {
        issues.push({
          standIdentifier: ident,
          standName,
          pushbackPk: matchingNav.pk,
          reason: `Pushback limit point or node "${pbNodePk}" is missing Q32.32 coordinates`,
        });
        continue;
      }
      const nx = decodeQ32(nTuple[0]);
      const nz = decodeQ32(nTuple[2]);
      const px = decodeQ32(matchingNav.obj.Position[0]);
      const pz = decodeQ32(matchingNav.obj.Position[2]);
      if (Math.hypot(nx - px, nz - pz) > NAV_COORD_SYNC_TOLERANCE_M) {
        issues.push({
          standIdentifier: ident,
          standName,
          pushbackPk: matchingNav.pk,
          reason: `Pushback limit point Position (${px.toFixed(3)}, ${pz.toFixed(3)}) does not match node "${pbNodePk}" (${nx.toFixed(3)}, ${nz.toFixed(3)})`,
        });
        continue;
      }

      for (const wb of testWbs) {
        const res = checkPushbackOption(standObj, wb, matchingNav.obj);
        if (!res.ok) {
          issues.push({
            standIdentifier: ident,
            standName,
            pushbackPk: matchingNav.pk,
            wheelBaseMeters: wb,
            reason: res.reason,
          });
          break;
        }
        paths.push(res);
      }
    }

    return { issues, paths };
  }

  return {
    stIdx,
    pkDict,
    siDict,
    nodes,
    edges,
    edgeMetadata,
    standsList,
    standsByIdent,
    standPointsByStand,
    pushbackPointsByStand,
    scheduledStandIdents,
    wheelBasesByStand,
    directedHeadErrors,
    segmentSignatures,
    nodeIncidentSigs,
    nodeCoordKeyByPk,
    tryProject,
    checkPushbackOption,
    standIntrinsicSignature,
    computeSnappingLocationsForStand,
    evaluateStand,
  };
}

/**
 * Identify stands in `postNav` affected by edits relative to `preNav`:
 *   - Explicitly flagged in `directlyAffectedStandIdents`
 *   - Newly added stands
 *   - Changes to stand `EgressType`, `NosePosition`, `TailPosition`, `PushbackLimitPositions`, or
 *     companion `FixedTaxiNavigationPoint`s (`RelatedStand`, `Reference`, `Position`, `Type`)
 *   - Changes to segment geometry, connectivity, flags, or `Directed`/`Head` orientation that touch
 *     the stand's snapped start/end segments, any segment/node along its prior pushback path, or
 *     alter `TryProject` snapping onto a nearby segment
 *   - Scheduled stands (`TaxiTimeEstimator` evaluates every scheduled departure stand on startup)
 */
function identifyAffectedStandIdents(preNav, postNav, directlyAffectedStandIdents = null) {
  if (!preNav) {
    return new Set(postNav.standsByIdent.keys());
  }

  const changedSegPks = new Set();
  for (const [pk, sig] of postNav.segmentSignatures) {
    if (preNav.segmentSignatures.get(pk) !== sig) changedSegPks.add(pk);
  }
  for (const [pk] of preNav.segmentSignatures) {
    if (!postNav.segmentSignatures.has(pk)) changedSegPks.add(pk);
  }

  const changedNodePks = new Set();
  for (const [pk, coordKey] of postNav.nodeCoordKeyByPk) {
    if (preNav.nodeCoordKeyByPk.get(pk) !== coordKey) {
      changedNodePks.add(pk);
      continue;
    }
    const preInc = (preNav.nodeIncidentSigs.get(pk) || []).slice().sort().join('|');
    const postInc = (postNav.nodeIncidentSigs.get(pk) || []).slice().sort().join('|');
    if (preInc !== postInc) changedNodePks.add(pk);
  }
  for (const [pk] of preNav.nodeCoordKeyByPk) {
    if (!postNav.nodeCoordKeyByPk.has(pk)) changedNodePks.add(pk);
  }

  const hasGraphChanges = changedSegPks.size > 0
    || changedNodePks.size > 0
    || postNav.directedHeadErrors.size > 0;

  const affected = new Set();
  if (directlyAffectedStandIdents) {
    for (const id of directlyAffectedStandIdents) {
      if (postNav.standsByIdent.has(id)) affected.add(id);
    }
  }
  for (const id of postNav.scheduledStandIdents) {
    if (postNav.standsByIdent.has(id)) affected.add(id);
  }

  for (const [ident] of postNav.standsByIdent) {
    if (affected.has(ident)) continue;
    if (!preNav.standsByIdent.has(ident)) {
      affected.add(ident);
      continue;
    }
    if (preNav.standIntrinsicSignature(ident) !== postNav.standIntrinsicSignature(ident)) {
      affected.add(ident);
      continue;
    }
    if (!hasGraphChanges) continue;

    // Check if TryProject start/end snapping changed (catches nearby segment edits without moving stand's own nodes)
    const preSnaps = preNav.computeSnappingLocationsForStand(ident).join('|');
    const postSnaps = postNav.computeSnappingLocationsForStand(ident).join('|');
    if (preSnaps !== postSnaps) {
      affected.add(ident);
      continue;
    }

    // Check if any segment/node on the pre-edit pushback path changed
    const preEval = preNav.evaluateStand(ident);
    if (preEval.issues.length === 0) {
      let touchedPath = false;
      for (const p of preEval.paths) {
        if (changedSegPks.has(p.startLoc.segmentPk) || changedSegPks.has(p.endLoc.segmentPk)) {
          touchedPath = true;
          break;
        }
        for (const spk of p.pathSegmentPks) {
          if (changedSegPks.has(spk)) {
            touchedPath = true;
            break;
          }
        }
        if (touchedPath) break;
        for (const npk of p.pathNodePks) {
          if (changedNodePks.has(npk)) {
            touchedPath = true;
            break;
          }
        }
        if (touchedPath) break;
      }
      if (touchedPath) {
        affected.add(ident);
      } else if (postNav.evaluateStand(ident).issues.length > 0) {
        affected.add(ident);
      }
    }
  }

  return affected;
}

function collectPushbackValidationIssues(postStaticData, schema, options = {}) {
  const {
    preStaticData = null,
    directlyAffectedStandIdents = null,
    wheelBaseByAircraft = null,
  } = options;

  const navOpts = wheelBaseByAircraft ? { wheelBaseByAircraft } : {};
  const preNav = preStaticData ? buildNavigationFromStaticData(preStaticData, schema, navOpts) : null;
  const postNav = buildNavigationFromStaticData(postStaticData, schema, navOpts);

  const issues = [];
  for (const [segPk, reason] of postNav.directedHeadErrors) {
    if (!preNav || !preNav.directedHeadErrors.has(segPk)) {
      issues.push({
        standIdentifier: '(directed-segment)',
        standName: '(directed-segment)',
        pushbackPk: segPk,
        reason,
      });
    }
  }

  const candidateIdents = identifyAffectedStandIdents(preNav, postNav, directlyAffectedStandIdents);

  for (const ident of candidateIdents) {
    let preStandEntry = null;
    if (preNav && preNav.standsByIdent.has(ident)) {
      const preObj = preNav.standsByIdent.get(ident).obj;
      const prePbRefs = unwrapTypedArray(preObj.PushbackLimitPositions, preNav.stIdx) || [];
      const prePbNavs = preNav.pushbackPointsByStand.get(ident) || [];
      preStandEntry = {
        hadPushbackLimits: Number(preObj.EgressType ?? 0) === 0 && prePbRefs.length > 0,
        firstPushbackNavPk: prePbNavs[0]?.pk || null,
      };
    }
    const { issues: standIssues } = postNav.evaluateStand(ident, { preStandEntry });
    for (const iss of standIssues) {
      issues.push(iss);
    }
  }

  return {
    issues,
    checkedStandCount: candidateIdents.size,
  };
}

function validateV3PushbackPaths(postStaticData, schema, options = {}) {
  const { issues, checkedStandCount } = collectPushbackValidationIssues(postStaticData, schema, options);
  if (issues.length > 0) {
    throw new PushbackValidationError(issues);
  }
  return { ok: true, checkedStandCount };
}

module.exports = {
  STANDARD_WHEELBASES_M,
  DEFAULT_WHEELBASE_M,
  PushbackValidationError,
  loadWheelBasesNearLevel,
  buildNavigationFromStaticData,
  identifyAffectedStandIdents,
  collectPushbackValidationIssues,
  validateV3PushbackPaths,
};
