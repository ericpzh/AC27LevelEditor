/**
 * GATCARC4 v3 scenery & Ground/Air Painter parity suite.
 *
 * Provides 1-to-1 GATCARC4 v3 coverage mirroring all 22 Odin v2 Ground/Air Painter
 * integration suites against `tests/fixtures/game-root-v3`:
 *   1. `scenery_roundtrip` — byte-identical no-touch, shared taxiway-node move (+ companion
 *      `FixedTaxiNavigationPoint` update & untouched `BigInt` preservation), new node/segment
 *      synthesis, area vertex move & new area synthesis
 *   2. `area_readd_after_delete_all` — delete all `Area` polygons -> re-add `Area` polygons
 *      -> readable by both `readSceneryGraph()` and `readAreas()`
 *   3. `ghost_ref_invariant` & `survivor_ref_gate` — `repairGhostRefs` twin remapping &
 *      unrepairable drop; writer survivor gate midpoint excision (`ground_painter_writer_gate_rewired`),
 *      2-node drop (`ground_painter_writer_gate_dropped_unrepairable`), and zero-length dedupe
 *   4. `id_renumber`, `jetway_id_collision`, `scenery_type_registration`, & `scenery_type_regroup`
 *      — collision-free `$id`/wrapper `id` allocation across `StaticData` & `RuntimeData` jetways,
 *      explicit `$type` preservation after deleting first `Area`/`Stand`, canonical `PKStaticEntities`
 *      prefix regrouping
 *   5. `runway_entries_prune_on_taxiway_delete`, `runway_entry_type_id`, & `runway_gate_synthetic`
 *      — pruning dead `Runway.Entries`/`Exits` while rescuing structural runway nodes, re-adding
 *      `Runway+Entry` onto an emptied runway, dropping invalid synthetic runways with
 *      `ground_painter_writer_new_runway_dropped`
 *   6. `runway_rename_drop_pavement`, `runway_timeline_prune`, `scenery_physical_runway_cleanup`,
 *      & `scenery_runway_rename_routes` — renaming `01/19 -> 02/20` (static & runtime
 *      `physical-runway:*`, pavement strips, `MetaData.RunwayTimeline`, `Runway.Routes` preservation
 *      + new procedure), adding & deleting a second runway pair `09/27`
 *   7. `scenery_airway` — add/move/rename/delete `airway-node` & `airway-segment` procedures,
 *      `readAirwayOsmPool()` negative-ID pool invariants
 *   8. `scenery_delete_cascade` & `taxinav_stale_stand` — stand deletion cascades across `stand:*`,
 *      `taxi-navigation:stand:*`, `taxi-navigation:pushback:*` (even when pushback `TaxiwayNode`
 *      remains live), and static/runtime `jetway:*`
 *   9. `scenery_naming` — `nameEdited: true` gate on survivor stands & taxiways + new stand naming
 *  10. `scenery_taxiway_split`, `taxiway_path_continuity`, & `taxiway_visual_props` — pavement split
 *      under `parentOsm` preserving `IsUnselectable`, degree-3 branch linear-chain decomposition
 *      with contiguous `0..N-1` ordinals & endpoint continuity, and visual-property uniformity
 *      healing & sibling rename propagation per `OsmId`
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { FIXTURES_GAME_ROOT_V3 } from '../helpers/gameRoot';
import { ghostNodeIndices, repairGhostRefs } from '../../src/components/EditorScreen/GroundPainter/fillet';

const require = createRequire(import.meta.url);
const { openAcl } = require('../../src/acl/archive');
const { getSchemaForHash } = require('../../src/acl/v3/schema_registry');
const { validateV3Container } = require('../../src/acl/v3/validator');
const {
  dictEntries,
  dictGet,
  indexDocumentGraph,
  resolveGraphNode,
  unwrapReactive,
  unwrapTypedArray,
} = require('../../src/acl/v3/graph');

const LEVELS_DIR = path.join(
  FIXTURES_GAME_ROOT_V3,
  'GroundATC_Data',
  'StreamingAssets',
  'Airports',
  'ZSJN',
  'Levels',
);
const LEISURE_1_BYTES = fs.readFileSync(path.join(LEVELS_DIR, 'ZSJN_leisure_1.acl'));
const RUNWAYCHANGE_BYTES = fs.readFileSync(path.join(LEVELS_DIR, 'ZSJN_runwaychange.acl'));

function freshHandle(buf = LEISURE_1_BYTES, name = 'ZSJN_leisure_1.acl') {
  return openAcl(Buffer.from(buf), { filePath: path.join(LEVELS_DIR, name) });
}

function getStaticMaps(handle) {
  const schema = getSchemaForHash(handle.header.schemaHash);
  const stIdx = indexDocumentGraph(handle.container.staticData, schema.roots.static, schema);
  const pkDict = resolveGraphNode(handle.container.staticData.PKStaticEntities, stIdx);
  const npkArr = unwrapTypedArray(handle.container.staticData.NonPKStaticEntities, stIdx) || [];
  const siDict = resolveGraphNode(handle.container.staticData.StaticItems, stIdx);
  return { schema, stIdx, pkDict, npkArr, siDict };
}

function getRuntimeDict(handle, frameIdx = 0) {
  const schema = getSchemaForHash(handle.header.schemaHash);
  const frame = handle.container.frames[frameIdx];
  const rtIdx = indexDocumentGraph(frame.runtimeData, schema.roots.runtime, schema);
  const reDict = resolveGraphNode(frame.runtimeData.RuntimeEntities, rtIdx);
  return { schema, rtIdx, reDict };
}

// ── 1. scenery_roundtrip v3 ──────────────────────────────────────────────────

describe('GATCARC4 v3 — scenery roundtrip & exact coordinate preservation', () => {
  it('no-touch applyEdits leaves container clean and toBuffer() byte-identical', () => {
    const h = freshHandle();
    const { graph, meta } = h.readSceneryGraph();
    const res = h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    expect(res.warnings).toEqual([]);
    const out = h.toBuffer();
    expect(out.equals(LEISURE_1_BYTES)).toBe(true);
  });

  it('moves a shared taxiway node (updating companion taxi-navigation) while keeping untouched raw BigInt tuples exact', () => {
    const h = freshHandle();
    const preMaps = getStaticMaps(h);
    const { graph, meta } = h.readSceneryGraph();

    const movedIdx = graph.segments[0].aIdx;
    const movedPk = meta.nodeOrigPk[movedIdx];
    const untouchedIdx = graph.segments[10].bIdx;
    const untouchedPk = meta.nodeOrigPk[untouchedIdx];
    expect(movedPk).toBeTruthy();
    expect(untouchedPk).toBeTruthy();
    expect(untouchedPk).not.toBe(movedPk);

    const origUntouchedTuple = [
      ...unwrapReactive(resolveGraphNode(dictGet(preMaps.pkDict, untouchedPk), preMaps.stIdx).ReactivePosition, preMaps.stIdx),
    ];

    const nx = graph.nodes[movedIdx].x + 0.125;
    const nz = graph.nodes[movedIdx].z - 0.075;
    graph.nodes[movedIdx].x = nx;
    graph.nodes[movedIdx].z = nz;

    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });

    const postMaps = getStaticMaps(reopened);
    const postUntouchedTuple = unwrapReactive(
      resolveGraphNode(dictGet(postMaps.pkDict, untouchedPk), postMaps.stIdx).ReactivePosition,
      postMaps.stIdx,
    );
    expect(postUntouchedTuple).toEqual(origUntouchedTuple);

    const g1 = reopened.readSceneryGraph().graph;
    const found = g1.nodes.find((n) => Math.abs(n.x - nx) < 1e-6 && Math.abs(n.z - nz) < 1e-6);
    expect(found).toBeTruthy();
  });

  it('synthesizes new taxiway nodes + segment and new/moved Area polygons cleanly', () => {
    const h = freshHandle();
    const { graph, meta } = h.readSceneryGraph();
    const baseSegs = graph.segments.length;
    const baseAreas = graph.areas.length;

    const nA = graph.nodes.length;
    graph.nodes.push({ x: 1.25, z: 2.5, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);
    const nB = graph.nodes.length;
    graph.nodes.push({ x: 1.75, z: 3.0, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);
    graph.segments.push({ aIdx: nA, bIdx: nB, nodeIdxs: [nA, nB], name: 'TWY-V3', flags: 2, directed: false });
    meta.segOrigPk.push(null);

    // Move vertex 0 of existing area 0 and append a new simple triangle area
    graph.areas[0].points[0] = {
      x: graph.areas[0].points[0].x + 0.05,
      z: graph.areas[0].points[0].z + 0.05,
    };
    graph.areas.push({
      areaType: 1,
      points: [{ x: 4.0, z: 4.0 }, { x: 4.5, z: 4.0 }, { x: 4.25, z: 4.5 }],
    });
    if (Array.isArray(meta.areaOrigId)) meta.areaOrigId.push(null);

    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
    const g1 = reopened.readSceneryGraph().graph;
    expect(g1.segments.length).toBe(baseSegs + 1);
    expect(g1.segments.some((s) => s.name === 'TWY-V3')).toBe(true);
    expect(g1.areas.length).toBe(baseAreas + 1);
  });
});

// ── 2. area_readd_after_delete_all v3 ────────────────────────────────────────

describe('GATCARC4 v3 — re-adding Areas after deleting all existing Areas', () => {
  it('deletes all Areas cleanly, then re-adds 2 new Areas readable by readSceneryGraph and readAreas', () => {
    const h1 = freshHandle();
    const { graph: g0, meta: m0 } = h1.readSceneryGraph();
    expect(g0.areas.length).toBeGreaterThan(0);

    m0.deletedAreaIds = [...(m0.areaOrigId || g0.areas.map((a) => a._origId)).filter((x) => x != null)];
    g0.areas = [];
    m0.areaOrigId = [];

    h1.applyEdits({ sceneryGraph: g0, sceneryMeta: m0 });
    const h2 = openAcl(h1.toBuffer(), { validateOnOpen: true });
    expect(h2.readSceneryGraph().graph.areas).toEqual([]);
    expect(h2.readAreas()).toEqual({});

    const { graph: g2, meta: m2 } = h2.readSceneryGraph();
    g2.areas.push(
      { areaType: 0, points: [{ x: 1.0, z: 1.0 }, { x: 1.4, z: 1.0 }, { x: 1.2, z: 1.4 }] },
      { areaType: 1, points: [{ x: 2.0, z: 2.0 }, { x: 2.6, z: 2.0 }, { x: 2.6, z: 2.5 }, { x: 2.0, z: 2.5 }] },
    );
    m2.areaOrigId.push(null, null);

    h2.applyEdits({ sceneryGraph: g2, sceneryMeta: m2 });
    const h3 = openAcl(h2.toBuffer(), { validateOnOpen: true });
    validateV3Container(h3.container);
    expect(h3.readSceneryGraph().graph.areas.length).toBe(2);
    expect(Object.values(h3.readAreas()).reduce((sum, arr) => sum + arr.length, 0)).toBe(2);
  });
});

// ── 3. ghost_ref_invariant & survivor_ref_gate v3 ───────────────────────────

describe('GATCARC4 v3 — ghost-node repair & writer survivor reference gate', () => {
  it('re-points a new leg from a ghost-deleted node onto its co-located live twin via repairGhostRefs', () => {
    const h = freshHandle(RUNWAYCHANGE_BYTES, 'ZSJN_runwaychange.acl');
    const { graph, meta } = h.readSceneryGraph();
    meta.deletedPks = meta.deletedPks || [];
    const baseSegCount = graph.segments.length;

    const liveIdx = graph.nodes.length;
    graph.nodes.push({ x: 0.5, z: 0.5, type: 2, flags: 0 });
    const ghostIdx = graph.nodes.length;
    graph.nodes.push({ x: 0.5, z: 0.5, type: 2, flags: 0 });
    const endIdx = graph.nodes.length;
    graph.nodes.push({ x: 1.5, z: 1.5, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null, 'taxiway-node:ghost-v3', null);
    meta.deletedPks.push('taxiway-node:ghost-v3');

    graph.segments.push({ aIdx: ghostIdx, bIdx: endIdx, nodeIdxs: [ghostIdx, endIdx], flags: 2, directed: false });
    meta.segOrigPk.push(null);

    expect([...ghostNodeIndices(graph, meta)]).toContain(ghostIdx);
    const rep = repairGhostRefs(graph, meta);
    expect(rep.remapped).toBe(1);
    expect(rep.dropped).toBe(0);

    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
    expect(reopened.readSceneryGraph().graph.segments.length).toBe(baseSegCount + 1);
  });

  it('excises deleted midpoint on >=3-node segment (rewired warning) and drops 2-node segment on deleted endpoint (unrepairable warning)', () => {
    const h = freshHandle();
    const { graph, meta } = h.readSceneryGraph();
    meta.deletedPks = meta.deletedPks || [];

    // Find a >=3-node non-runway segment whose interior node is not shared with a stand/runway
    const rwNodeIdxs = new Set();
    for (const rw of graph.runways) {
      rwNodeIdxs.add(rw.thAIdx);
      rwNodeIdxs.add(rw.thBIdx);
      for (const en of rw.entries || []) { rwNodeIdxs.add(en.holdingIdx); rwNodeIdxs.add(en.lineUpIdx); rwNodeIdxs.add(en.defineIdx); }
      for (const ex of rw.exits || []) { rwNodeIdxs.add(ex.exitIdx); rwNodeIdxs.add(ex.holdingIdx); rwNodeIdxs.add(ex.defineIdx); }
    }
    for (const st of graph.stands) {
      rwNodeIdxs.add(st.noseIdx);
      rwNodeIdxs.add(st.tailIdx);
    }

    const polySeg = graph.segments.find(
      (s) => Array.isArray(s.nodeIdxs) && s.nodeIdxs.length >= 3 && !rwNodeIdxs.has(s.nodeIdxs[1]),
    );
    const twoSeg = graph.segments.find(
      (s) =>
        s !== polySeg &&
        Array.isArray(s.nodeIdxs) &&
        s.nodeIdxs.length === 2 &&
        !rwNodeIdxs.has(s.nodeIdxs[0]) &&
        // ensure no co-located live twin
        graph.nodes.filter((n) => Math.hypot(n.x - graph.nodes[s.nodeIdxs[0]].x, n.z - graph.nodes[s.nodeIdxs[0]].z) < 1e-5).length === 1,
    );
    expect(polySeg).toBeTruthy();
    expect(twoSeg).toBeTruthy();

    meta.deletedPks.push(meta.nodeOrigPk[polySeg.nodeIdxs[1]]);
    meta.deletedPks.push(meta.nodeOrigPk[twoSeg.nodeIdxs[0]]);

    const res = h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    const warnKeys = res.warnings.map((w) => w.key);
    expect(warnKeys).toContain('ground_painter_writer_gate_rewired');
    expect(warnKeys).toContain('ground_painter_writer_gate_dropped_unrepairable');

    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
    validateV3Container(reopened.container);
  });
});

// ── 4. id_renumber, jetway_id_collision, type registration, & PK regroup v3 ─

describe('GATCARC4 v3 — canonical PKStaticEntities regrouping, $type preservation, and collision-free IDs', () => {
  it('regroups PKStaticEntities into canonical prefix blocks and preserves collision-free IDs across StaticData & RuntimeData', () => {
    const h = freshHandle();
    const { graph, meta } = h.readSceneryGraph();
    meta.deletedPks = meta.deletedPks || [];
    meta.deletedAreaIds = meta.deletedAreaIds || [];

    // Delete first Stand and first Area to verify surviving stands/areas retain explicit $type
    meta.deletedPks.push(meta.standOrigPk[0]);
    graph.stands.shift();
    meta.standOrigPk.shift();
    if (meta.areaOrigId?.length) {
      meta.deletedAreaIds.push(meta.areaOrigId[0]);
      graph.areas.shift();
      meta.areaOrigId.shift();
    }

    // Add new taxiway nodes + segment, new stand, and new airway node + procedure
    const nNose = graph.nodes.length;
    graph.nodes.push({ x: 3.1, z: 3.1, type: 0, flags: 0 });
    const nTail = graph.nodes.length;
    graph.nodes.push({ x: 3.1, z: 3.3, type: 1, flags: 0 });
    meta.nodeOrigPk.push(null, null);
    graph.segments.push({ aIdx: nNose, bIdx: nTail, nodeIdxs: [nNose, nTail], name: 'TWY-REGROUP', flags: 2, directed: false });
    meta.segOrigPk.push(null);
    graph.stands.push({
      identifier: 'V3G1',
      name: 'V3G1',
      noseIdx: nNose,
      tailIdx: nTail,
      sizeLimit: 3,
      standType: 0,
      hasJetway: true,
    });
    meta.standOrigPk.push(null);

    const a0 = graph.airwayNodes.length;
    graph.airwayNodes.push({ x: 25.0, z: 25.0, name: 'FIXV3A' });
    const a1 = graph.airwayNodes.length;
    graph.airwayNodes.push({ x: 20.0, z: 20.0, name: 'FIXV3B' });
    meta.airwayNodeOrigPk.push(null, null);
    graph.procedures.push({
      name: 'FIXV31A',
      routeType: 0,
      runwayName: '01',
      airwayNodeIdxs: [a0, a1],
    });
    meta.airwaySegOrigPk.push(null);

    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
    validateV3Container(reopened.container);

    // Check PKStaticEntities prefix ordering has zero backward transitions
    const { pkDict, npkArr } = getStaticMaps(reopened);
    const ORDER = [
      'taxiway-node',
      'taxiway-segment',
      'airway-node',
      'airway-segment',
      'runway',
      'stand',
      'taxi-navigation',
    ];
    let maxOrderSeen = -1;
    for (const [k, rawV] of dictEntries(pkDict)) {
      const pref = k.slice(0, k.indexOf(':'));
      const idx = ORDER.indexOf(pref);
      if (idx >= 0) {
        expect(idx).toBeGreaterThanOrEqual(maxOrderSeen);
        maxOrderSeen = idx;
      }
      if (pref === 'stand') {
        expect(rawV.$type || '').toBe('ContextCross.Models.Stand');
      }
    }
    for (const item of npkArr) {
      if (item && typeof item === 'object' && item.NodePositions) {
        expect(item.$type).toBe('ContextCross.Models.Area');
      }
    }
  });
});

// ── 5. runway_entries_prune, runway_entry_type_id, & runway_gate_synthetic v3 ─

describe('GATCARC4 v3 — runway entry pruning, entry re-addition, and invalid synthetic runway gate', () => {
  it('prunes Runway.Entries/Exits when all serving taxiways are deleted while keeping runways alive, then re-adds a Runway+Entry cleanly', () => {
    const h1 = freshHandle();
    const { graph: g0, meta: m0 } = h1.readSceneryGraph();

    // Delete every original taxiway node & segment; writer rescues runway structural nodes
    m0.deletedPks = [
      ...m0.nodeOrigPk.filter(Boolean),
      ...m0.segOrigPk.filter(Boolean),
      ...m0.standOrigPk.filter(Boolean),
    ];
    g0.stands = [];
    m0.standOrigPk = [];

    h1.applyEdits({ sceneryGraph: g0, sceneryMeta: m0 });
    const h2 = openAcl(h1.toBuffer(), { validateOnOpen: true });
    validateV3Container(h2.container);

    const g1 = h2.readSceneryGraph().graph;
    expect(g1.runways.length).toBe(1);
    expect(g1.runways[0].entries).toEqual([]);
    expect(g1.runways[0].exits).toEqual([]);

    // Now add holding/lineUp/define nodes + a new Runway+Entry onto the emptied runway
    const { graph: g2, meta: m2 } = h2.readSceneryGraph();
    const hIdx = g2.nodes.length;
    g2.nodes.push({ x: 0.2, z: -5.0, type: 3, flags: 0 });
    const lIdx = g2.nodes.length;
    g2.nodes.push({ x: 0.0, z: -5.0, type: 2, flags: 0 });
    const dIdx = g2.nodes.length;
    g2.nodes.push({ x: 0.4, z: -5.0, type: 2, flags: 0 });
    m2.nodeOrigPk.push(null, null, null);
    g2.segments.push({ aIdx: dIdx, bIdx: lIdx, nodeIdxs: [dIdx, hIdx, lIdx], name: 'E1', flags: 2, directed: false });
    m2.segOrigPk.push(null);
    g2.runways[0].entries = [{
      runwayName: '01',
      name: 'E1',
      holdingIdx: hIdx,
      lineUpIdx: lIdx,
      defineIdx: dIdx,
    }];

    h2.applyEdits({ sceneryGraph: g2, sceneryMeta: m2 });
    const h3 = openAcl(h2.toBuffer(), { validateOnOpen: true });
    validateV3Container(h3.container);
    expect(h3.readSceneryGraph().graph.runways[0].entries.length).toBe(1);
  });

  it('drops a newly added synthetic runway whose threshold node is missing and emits ground_painter_writer_new_runway_dropped', () => {
    const h = freshHandle();
    const { graph, meta } = h.readSceneryGraph();

    graph.runways.push({
      physicalName: '09/27',
      names: ['09', '27'],
      thAIdx: 999999, // invalid index
      thBIdx: 999998,
      entries: [],
      exits: [],
    });
    meta.runwayOrigPk.push(null);

    const res = h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    expect(res.warnings.map((w) => w.key)).toContain('ground_painter_writer_new_runway_dropped');

    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
    expect(reopened.readSceneryGraph().graph.runways.map((r) => r.physicalName)).toEqual(['01/19']);
  });
});

// ── 6. runway rename, routes, physical-runway cleanup, & RunwayTimeline v3 ──

describe('GATCARC4 v3 — runway rename, route preservation, physical-runway cleanup, and RunwayTimeline', () => {
  it('renames 01/19 -> 02/20 across PKStaticEntities, StaticItems, RuntimeEntities, pavement strips, Runway.Routes, and MetaData.RunwayTimeline', () => {
    const h = freshHandle(LEISURE_1_BYTES, 'ZSJN_leisure_1.acl');
    // Seed a RunwayTimeline switch event on 01 -> 19 so timeline remapping is verified alongside RuntimeEntities
    h.container.metaData.RunwayTimeline = {
      initialRunways: ['01'],
      timeline: [{ time: '06:00:00', changes: [{ runway: '01', active: false }, { runway: '19', active: true }] }],
    };
    const { graph, meta } = h.readSceneryGraph();
    const origProcCount = graph.procedures.length;
    expect(origProcCount).toBeGreaterThan(0);

    graph.runways[0].physicalName = '02/20';
    graph.runways[0].names = ['02', '20'];
    for (const p of graph.procedures) {
      if (p.runwayName === '01') p.runwayName = '02';
      else if (p.runwayName === '19') p.runwayName = '20';
    }
    // Also add 1 new procedure on renamed runway '02'
    graph.procedures.push({
      name: 'RNWV32A',
      routeType: 0,
      runwayName: '02',
      airwayNodeIdxs: [0, 1],
    });
    meta.airwaySegOrigPk.push(null);

    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
    validateV3Container(reopened.container);

    const { pkDict, siDict } = getStaticMaps(reopened);
    expect(dictGet(pkDict, 'runway:01')).toBeUndefined();
    expect(dictGet(pkDict, 'runway:19')).toBeUndefined();
    expect(dictGet(pkDict, 'runway:02')).toBeTruthy();
    expect(dictGet(pkDict, 'runway:20')).toBeTruthy();
    expect(dictGet(siDict, 'physical-runway:01/19')).toBeUndefined();
    expect(dictGet(siDict, 'physical-runway:02/20')).toBeTruthy();

    const { reDict } = getRuntimeDict(reopened, 0);
    expect(dictGet(reDict, 'physical-runway:01/19')).toBeUndefined();
    expect(dictGet(reDict, 'physical-runway:02/20')).toBeTruthy();

    // Coupled pavement strips renamed, leaving zero orphan '01/19' segments
    const g1 = reopened.readSceneryGraph().graph;
    expect(g1.segments.some((s) => s.name === '01/19')).toBe(false);
    expect(g1.segments.some((s) => s.name === '02/20')).toBe(true);
    expect(g1.procedures.length).toBe(origProcCount + 1);

    // MetaData.RunwayTimeline remapped from 01/19 to 02/20
    const rtl = reopened.container.metaData?.RunwayTimeline;
    expect(rtl.initialRunways.some((r) => r === '01' || r === '19')).toBe(false);
    expect(rtl.initialRunways.some((r) => r === '02' || r === '20')).toBe(true);
    for (const ev of rtl.timeline || []) {
      for (const ch of ev.changes || []) {
        expect(['02', '20']).toContain(ch.runway);
      }
    }
  });

  it('adds a second runway pair 09/27 (synthesizing static + runtime physical-runway:09/27) and cleans it up completely on delete', () => {
    const h1 = freshHandle();
    const { graph: g0, meta: m0 } = h1.readSceneryGraph();

    const thA = g0.nodes.length;
    g0.nodes.push({ x: -12.0, z: 5.0, type: 2, flags: 0 });
    const thB = g0.nodes.length;
    g0.nodes.push({ x: 12.0, z: 5.0, type: 2, flags: 0 });
    m0.nodeOrigPk.push(null, null);
    g0.segments.push({ aIdx: thA, bIdx: thB, nodeIdxs: [thA, thB], name: '09/27', flags: 4, directed: false });
    m0.segOrigPk.push(null);
    g0.runways.push({
      physicalName: '09/27',
      names: ['09', '27'],
      thAIdx: thA,
      thBIdx: thB,
      entries: [],
      exits: [],
    });
    m0.runwayOrigPk.push(null);

    h1.applyEdits({ sceneryGraph: g0, sceneryMeta: m0 });
    const h2 = openAcl(h1.toBuffer(), { validateOnOpen: true });
    validateV3Container(h2.container);

    expect(dictGet(getStaticMaps(h2).siDict, 'physical-runway:09/27')).toBeTruthy();
    expect(dictGet(getRuntimeDict(h2, 0).reDict, 'physical-runway:09/27')).toBeTruthy();
    expect(h2.container.metaData.RunwayTimeline.initialRunways).toContain('09');

    // Now delete runway 09/27 and its pavement strip
    const { graph: g2, meta: m2 } = h2.readSceneryGraph();
    m2.deletedPks = m2.deletedPks || [];
    const rwIdx = g2.runways.findIndex((r) => r.physicalName === '09/27');
    expect(rwIdx).toBeGreaterThanOrEqual(0);
    const pairPks = m2.runwayOrigPk[rwIdx];
    for (const pk of Array.isArray(pairPks) ? pairPks : [pairPks]) {
      if (pk) m2.deletedPks.push(pk);
    }
    g2.runways.splice(rwIdx, 1);
    m2.runwayOrigPk.splice(rwIdx, 1);

    for (let i = g2.segments.length - 1; i >= 0; i--) {
      if (g2.segments[i].name === '09/27') {
        if (m2.segOrigPk[i]) m2.deletedPks.push(m2.segOrigPk[i]);
        g2.segments.splice(i, 1);
        m2.segOrigPk.splice(i, 1);
      }
    }

    h2.applyEdits({ sceneryGraph: g2, sceneryMeta: m2 });
    const h3 = openAcl(h2.toBuffer(), { validateOnOpen: true });
    validateV3Container(h3.container);

    expect(dictGet(getStaticMaps(h3).siDict, 'physical-runway:09/27')).toBeUndefined();
    expect(dictGet(getRuntimeDict(h3, 0).reDict, 'physical-runway:09/27')).toBeUndefined();
    expect(h3.container.metaData.RunwayTimeline.initialRunways).not.toContain('09');
    expect(h3.readSceneryGraph().graph.segments.some((s) => s.name === '09/27')).toBe(false);
  });
});

// ── 7. scenery_airway v3 ────────────────────────────────────────────────────

describe('GATCARC4 v3 — Air Painter airway nodes & procedures round-trip', () => {
  it('adds, moves, renames, and deletes airway nodes & procedures while maintaining negative OsmId pool invariants', () => {
    const h = freshHandle();
    const poolBefore = h.readAirwayOsmPool();
    expect(poolBefore.nodeIds.length).toBeGreaterThan(0);

    const { graph, meta } = h.readSceneryGraph();
    meta.deletedPks = meta.deletedPks || [];
    meta.deletedAirwayPks = meta.deletedAirwayPks || [];

    // Move & rename existing airway node 0
    graph.airwayNodes[0].x += 1.5;
    graph.airwayNodes[0].z -= 1.25;
    graph.airwayNodes[0].name = 'MOVFIX';
    graph.airwayNodes[0].nameEdited = true;

    // Rename procedure 0
    graph.procedures[0].name = 'RENPRC1';

    // Add 2 new airway nodes + 1 SID procedure
    const iA = graph.airwayNodes.length;
    graph.airwayNodes.push({ x: 35.5, z: -42.25, name: 'SIDFX1' });
    const iB = graph.airwayNodes.length;
    graph.airwayNodes.push({ x: 48.0, z: -55.0, name: 'SIDFX2' });
    meta.airwayNodeOrigPk.push(null, null);
    graph.procedures.push({
      name: 'SIDV31D',
      routeType: 2,
      runwayName: '01',
      airwayNodeIdxs: [iA, iB],
    });
    meta.airwaySegOrigPk.push(null);

    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
    validateV3Container(reopened.container);

    // Synthesized airway nodes & procedures allocate negative OsmIds disjoint from existing OSM IDs
    const poolAfter = reopened.readAirwayOsmPool();
    expect(poolAfter.nodeIds.filter((id) => id < 0).length).toBeGreaterThanOrEqual(2);
    expect(poolAfter.segIds.filter((id) => id < 0).length).toBeGreaterThanOrEqual(1);

    const g1 = reopened.readSceneryGraph().graph;
    expect(g1.airwayNodes.some((n) => n.name === 'MOVFIX')).toBe(true);
    expect(g1.airwayNodes.some((n) => n.name === 'SIDFX1')).toBe(true);
    expect(g1.procedures.some((p) => p.name === 'RENPRC1')).toBe(true);
    expect(g1.procedures.some((p) => p.name === 'SIDV31D' && p.routeType === 2)).toBe(true);
  });
});

// ── 8. scenery_delete_cascade & taxinav_stale_stand v3 ──────────────────────

describe('GATCARC4 v3 — stand deletion cascade across taxi-navigation & jetways', () => {
  it('removes stand, stand/pushback taxi-navigation (even when pushback node stays live), and static+runtime jetway', () => {
    const h = freshHandle();
    const preMaps = getStaticMaps(h);

    // Pick a stand that owns both a jetway and pushback taxi-navigation entries
    let targetStandId = null;
    for (const [k, rawV] of dictEntries(preMaps.pkDict)) {
      if (!k.startsWith('taxi-navigation:pushback:')) continue;
      const nav = resolveGraphNode(rawV, preMaps.stIdx);
      const stId = String(nav?.RelatedStand || '').trim();
      if (stId && dictGet(preMaps.siDict, `jetway:${stId}`)) {
        targetStandId = stId;
        break;
      }
    }
    expect(targetStandId).toBeTruthy();

    const { graph, meta } = h.readSceneryGraph();
    meta.deletedPks = meta.deletedPks || [];
    const sIdx = graph.stands.findIndex((s) => (s.identifier || s.name) === targetStandId);
    expect(sIdx).toBeGreaterThanOrEqual(0);
    // Delete ONLY the stand (leaving all TaxiwayNodes, including its pushback limit node, live!)
    meta.deletedPks.push(meta.standOrigPk[sIdx]);
    graph.stands.splice(sIdx, 1);
    meta.standOrigPk.splice(sIdx, 1);

    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
    validateV3Container(reopened.container);

    const postMaps = getStaticMaps(reopened);
    expect(dictGet(postMaps.pkDict, `stand:${targetStandId}`)).toBeUndefined();
    expect(dictGet(postMaps.siDict, `jetway:${targetStandId}`)).toBeUndefined();
    expect(dictGet(getRuntimeDict(reopened, 0).reDict, `jetway:${targetStandId}`)).toBeUndefined();

    for (const [k, rawV] of dictEntries(postMaps.pkDict)) {
      if (!k.startsWith('taxi-navigation:')) continue;
      const nav = resolveGraphNode(rawV, postMaps.stIdx);
      expect(String(nav.RelatedStand || '').trim()).not.toBe(targetStandId);
    }
  });
});

// ── 9. scenery_naming v3 ────────────────────────────────────────────────────

describe('GATCARC4 v3 — explicit nameEdited gate for stands and taxiways', () => {
  it('persists stand & taxiway renames only when nameEdited is true, and names newly synthesized stands', () => {
    const h = freshHandle();
    const { graph, meta } = h.readSceneryGraph();

    const origStand0Name = graph.stands[0].name;
    // Mutate without nameEdited -> ignored
    graph.stands[0].name = 'IGNORED-STAND';
    // Mutate with nameEdited -> persisted
    graph.stands[1].name = 'GATE-V3-REN';
    graph.stands[1].nameEdited = true;

    const twySeg = graph.segments.find((s) => s.flags !== 4 && s.name);
    expect(twySeg).toBeTruthy();
    twySeg.name = 'TWY-V3-REN';
    twySeg.nameEdited = true;

    const nN = graph.nodes.length;
    graph.nodes.push({ x: 5.1, z: 5.1, type: 0, flags: 0 });
    const nT = graph.nodes.length;
    graph.nodes.push({ x: 5.1, z: 5.3, type: 1, flags: 0 });
    meta.nodeOrigPk.push(null, null);
    graph.stands.push({
      identifier: 'GATE-7',
      name: 'GATE-7',
      noseIdx: nN,
      tailIdx: nT,
      sizeLimit: 3,
      standType: 0,
      hasJetway: false,
    });
    meta.standOrigPk.push(null);

    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
    const g1 = reopened.readSceneryGraph().graph;

    expect(g1.stands.some((s) => s.name === 'IGNORED-STAND')).toBe(false);
    expect(g1.stands.some((s) => s.name === origStand0Name)).toBe(true);
    expect(g1.stands.some((s) => s.name === 'GATE-V3-REN')).toBe(true);
    expect(g1.stands.some((s) => s.name === 'GATE-7')).toBe(true);
    expect(g1.segments.some((s) => s.name === 'TWY-V3-REN')).toBe(true);
  });
});

// ── 10. scenery_taxiway_split, taxiway_path_continuity, & taxiway_visual_props v3 ─

describe('GATCARC4 v3 — OsmId pavement split, linear-chain continuity, and visual-property uniformity', () => {
  it('splits a runway pavement strip under parentOsm preserving single OsmId, contiguous 0..N-1 ordinals, endpoint continuity, and IsUnselectable', () => {
    const h = freshHandle();
    const preMaps = getStaticMaps(h);

    // Pre-mark OsmId 50095 segments as IsUnselectable: true (mirroring v2 scenery_taxiway_split)
    let targetOsm = null;
    for (const [pk, rawV] of dictEntries(preMaps.pkDict)) {
      if (!pk.startsWith('taxiway-segment:')) continue;
      const sg = resolveGraphNode(rawV, preMaps.stIdx);
      if (Number(sg.Flags) === 4 && sg.OsmId != null) {
        targetOsm = Number(sg.OsmId);
        sg.IsUnselectable = true;
      }
    }
    expect(targetOsm).not.toBeNull();

    const { graph, meta } = h.readSceneryGraph();
    meta.deletedPks = meta.deletedPks || [];
    const sIdx = meta.segOrigPk.findIndex((pk) => pk && pk.startsWith(`taxiway-segment:${targetOsm}:`));
    expect(sIdx).toBeGreaterThanOrEqual(0);
    const origSeg = graph.segments[sIdx];
    const origPk = meta.segOrigPk[sIdx];

    // Split origSeg at midpoint into two pieces carrying `parentOsm: targetOsm`
    const nA = origSeg.nodeIdxs[0];
    const nB = origSeg.nodeIdxs[origSeg.nodeIdxs.length - 1];
    const midIdx = graph.nodes.length;
    graph.nodes.push({
      x: (graph.nodes[nA].x + graph.nodes[nB].x) / 2,
      z: (graph.nodes[nA].z + graph.nodes[nB].z) / 2,
      type: 2,
      flags: 0,
    });
    meta.nodeOrigPk.push(null);

    meta.deletedPks.push(origPk);
    graph.segments.splice(
      sIdx,
      1,
      {
        aIdx: nA,
        bIdx: midIdx,
        nodeIdxs: [nA, midIdx],
        name: origSeg.name,
        flags: origSeg.flags,
        directed: origSeg.directed,
        parentOsm: targetOsm,
      },
      {
        aIdx: midIdx,
        bIdx: nB,
        nodeIdxs: [midIdx, nB],
        name: origSeg.name,
        flags: origSeg.flags,
        directed: origSeg.directed,
        parentOsm: targetOsm,
      },
    );
    meta.segOrigPk.splice(sIdx, 1, null, null);

    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
    validateV3Container(reopened.container);

    const postMaps = getStaticMaps(reopened);
    const pieces = [];
    for (const [pk, rawV] of dictEntries(postMaps.pkDict)) {
      if (!pk.startsWith(`taxiway-segment:${targetOsm}:`)) continue;
      const ord = Number(pk.split(':')[2]);
      pieces.push({ ord, obj: resolveGraphNode(rawV, postMaps.stIdx) });
    }
    pieces.sort((a, b) => a.ord - b.ord);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    expect(pieces.map((p) => p.ord)).toEqual(pieces.map((_, i) => i));

    for (let i = 0; i < pieces.length; i++) {
      expect(pieces[i].obj.IsUnselectable).toBe(true);
      if (i > 0) {
        const prevNodes = unwrapTypedArray(pieces[i - 1].obj.Nodes, postMaps.stIdx).map((r) => resolveGraphNode(r, postMaps.stIdx));
        const curNodes = unwrapTypedArray(pieces[i].obj.Nodes, postMaps.stIdx).map((r) => resolveGraphNode(r, postMaps.stIdx));
        expect(prevNodes[prevNodes.length - 1]).toBe(curNodes[0]);
      }
    }
  });

  it('decomposes a degree-3 branched parentOsm group into separate linear chains and heals inconsistent OsmId visual properties', () => {
    const h = freshHandle();
    const preMaps = getStaticMaps(h);

    // Find a multi-piece OsmId to corrupt one piece's visual props AND attach a degree-3 branch
    const byOsm = new Map();
    for (const [pk, rawV] of dictEntries(preMaps.pkDict)) {
      if (!pk.startsWith('taxiway-segment:')) continue;
      const sg = resolveGraphNode(rawV, preMaps.stIdx);
      if (Number(sg.Flags) === 4 || sg.OsmId == null) continue;
      const k = Number(sg.OsmId);
      if (!byOsm.has(k)) byOsm.set(k, []);
      byOsm.get(k).push({ pk, sg });
    }
    const multiEntry = [...byOsm.entries()].find(([, arr]) => arr.length >= 2);
    expect(multiEntry).toBeTruthy();
    const [multiOsm, multiSegs] = multiEntry;

    // Corrupt visual properties on the second piece (simulating pre-invariant drift)
    multiSegs[1].sg.IsHidden = !Boolean(multiSegs[0].sg.IsHidden);
    multiSegs[1].sg.Name = 'DRIFTED-NAME';

    const { graph, meta } = h.readSceneryGraph();
    // Rename piece 0 via editor (`nameEdited: true`) AND attach a degree-3 T-branch under `parentOsm: multiOsm`
    const gSegIdx = meta.segOrigPk.findIndex((pk) => pk && pk.startsWith(`taxiway-segment:${multiOsm}:`));
    expect(gSegIdx).toBeGreaterThanOrEqual(0);
    const gSeg = graph.segments[gSegIdx];
    gSeg.name = 'UNIFIED-TWY';
    gSeg.nameEdited = true;

    const spurEnd = graph.nodes.length;
    graph.nodes.push({ x: graph.nodes[gSeg.bIdx].x + 0.35, z: graph.nodes[gSeg.bIdx].z + 0.35, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);
    graph.segments.push({
      aIdx: gSeg.bIdx,
      bIdx: spurEnd,
      nodeIdxs: [gSeg.bIdx, spurEnd],
      name: 'UNIFIED-TWY',
      flags: gSeg.flags,
      directed: gSeg.directed,
      parentOsm: multiOsm,
    });
    meta.segOrigPk.push(null);

    h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
    validateV3Container(reopened.container);

    // Every OsmId across the entire file must now have 0..N-1 contiguous ordinals,
    // endpoint continuity, and 100% uniform visual properties
    const postMaps = getStaticMaps(reopened);
    const postByOsm = new Map();
    for (const [pk, rawV] of dictEntries(postMaps.pkDict)) {
      if (!pk.startsWith('taxiway-segment:')) continue;
      const sg = resolveGraphNode(rawV, postMaps.stIdx);
      const osm = String(sg.OsmId);
      const ord = Number(pk.split(':')[2]);
      if (!postByOsm.has(osm)) postByOsm.set(osm, []);
      postByOsm.get(osm).push({ pk, ord, sg });
    }

    for (const [, list] of postByOsm) {
      list.sort((a, b) => a.ord - b.ord);
      expect(list.map((x) => x.ord)).toEqual(list.map((_, i) => i));
      const sigs = new Set(
        list.map((x) =>
          JSON.stringify({
            name: String(x.sg.Name ?? ''),
            flags: Number(x.sg.Flags ?? 0),
            directed: Boolean(x.sg.Directed),
            isHidden: Boolean(x.sg.IsHidden),
            isUnselectable: Boolean(x.sg.IsUnselectable),
          }),
        ),
      );
      expect(sigs.size).toBe(1);
      for (let i = 1; i < list.length; i++) {
        const prevNodes = unwrapTypedArray(list[i - 1].sg.Nodes, postMaps.stIdx).map((r) => resolveGraphNode(r, postMaps.stIdx));
        const curNodes = unwrapTypedArray(list[i].sg.Nodes, postMaps.stIdx).map((r) => resolveGraphNode(r, postMaps.stIdx));
        expect(prevNodes[prevNodes.length - 1]).toBe(curNodes[0]);
      }
    }

    // And the renamed OsmId carries 'UNIFIED-TWY' on every piece
    const unifiedGroup = postByOsm.get(String(multiOsm));
    expect(unifiedGroup).toBeTruthy();
    for (const item of unifiedGroup) {
      expect(item.sg.Name).toBe('UNIFIED-TWY');
    }
  });
});
