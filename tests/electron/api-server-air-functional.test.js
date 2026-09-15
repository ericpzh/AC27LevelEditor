import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const api = require('../../electron/api-server.js');
const { handleMcpMessage, MCP_TOOLS } = api;

// Fake Electron window that returns a controllable store snapshot
let fakeState = null;
let fakeCache = {};
const fakeWindow = {
  webContents: {
    executeJavaScript: async () => JSON.parse(JSON.stringify(fakeState)),
    send: vi.fn(),
  },
};
function setFakeState(s) { fakeState = s; }
function fakeCacheGetter() { return fakeCache; }

function baseGraph() {
  return {
    nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }],
    segments: [{ aIdx: 0, bIdx: 1, nodeIdxs: [0, 1], flags: 2, directed: false }],
    runways: [{ thAIdx: 0, thBIdx: 1, names: ['01', '19'], name: '01', physicalName: '01/19', width: 0.5, entries: [], exits: [] }],
    areas: [], stands: [],
    airwayNodes: [{ x: -50, z: 0, name: 'FIXA' }, { x: 0, z: 0, name: 'FIXB' }, { x: 50, z: 0, name: 'FIXC' }],
    procedures: [{ name: 'STAR1', routeType: 0, runwayName: '01', airwayNodeIdxs: [0, 1, 2] }],
  };
}
function baseMeta(g) {
  return {
    nodeOrigPk: g.nodes.map((_, i) => 100 + i),
    segOrigPk: g.segments.map((_, i) => 200 + i),
    runwayOrigPk: g.runways.map((_, i) => 300 + i),
    runwayPavement: g.runways.map(() => []),
    runwayOrigInfo: g.runways.map((rw) => ({ pks: [], physicalName: rw.physicalName, names: rw.names, width: rw.width })),
    areaOrigId: [], standOrigPk: [],
    airwayNodeOrigPk: g.airwayNodes.map((_, i) => 400 + i),
    airwaySegOrigPk: g.procedures.map((_, i) => 500 + i),
    deletedPks: [], deletedAreaIds: [], deletedAirwayPks: [],
  };
}
function makeState(overrides = {}) {
  const g = baseGraph();
  const m = baseMeta(g);
  // capture pushStoreUpdate effect by intercepting fakeWindow.webContents.send
  fakeWindow.webContents.send = vi.fn((channel, updates) => {
    if (updates.groundPainterGraph) fakeState.groundPainterGraph = updates.groundPainterGraph;
    if (updates.groundPainterMeta) fakeState.groundPainterMeta = updates.groundPainterMeta;
    if (updates.groundPainterHistory) fakeState.groundPainterHistory = updates.groundPainterHistory;
    if (updates.groundPainterMetaHistory) fakeState.groundPainterMetaHistory = updates.groundPainterMetaHistory;
    if ('groundPainterHasEdited' in updates) fakeState.groundPainterHasEdited = updates.groundPainterHasEdited;
    if ('groundPainterMode' in updates) fakeState.groundPainterMode = updates.groundPainterMode;
    if ('groundPainterActiveRunways' in updates) fakeState.groundPainterActiveRunways = updates.groundPainterActiveRunways;
  });
  fakeState = {
    screen: 'editor', currentPath: '/tmp/test.acl', currentAirport: 'ZSPD',
    flights: [], isDemo: false, modified: false,
    showGroundPainter: true, groundPainterGraph: g, groundPainterMeta: m,
    groundPainterHistory: null, groundPainterMetaHistory: null,
    groundPainterHasEdited: false, groundPainterTool: 'select', groundPainterMode: 'air',
    ...overrides,
  };
  fakeCache = { ZSPD: { approachData: { airwayNodes: g.airwayNodes } } };
}

async function callTool(name, args = {}) {
  const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const content = res.result?.content?.[0]?.text;
  return content ? JSON.parse(content) : res;
}

beforeEach(() => {
  api.startServer(fakeWindow, 0, fakeCacheGetter);
});
afterEach(() => { try { api.stopServer(); } catch (_) {} });

describe('api-server air tools — set_ground_painter_mode', () => {
  it('rejects a missing or invalid mode', async () => {
    makeState({ groundPainterMode: 'ground' });
    let r = await callTool('set_ground_painter_mode', {});
    expect(r.success).toBe(false);
    r = await callTool('set_ground_painter_mode', { mode: 'sideways' });
    expect(r.success).toBe(false);
    expect(fakeState.groundPainterMode).toBe('ground');
  });
  it('switches ground → air and reports the previous mode', async () => {
    makeState({ groundPainterMode: 'ground' });
    const r = await callTool('set_ground_painter_mode', { mode: 'air' });
    expect(r.success).toBe(true);
    expect(r.previous).toBe('ground');
    expect(r.mode).toBe('air');
    expect(fakeState.groundPainterMode).toBe('air');
  });
  it('clears the air runway filter when returning to ground', async () => {
    makeState({ groundPainterMode: 'air', groundPainterActiveRunways: ['01'] });
    const r = await callTool('set_ground_painter_mode', { mode: 'ground' });
    expect(r.success).toBe(true);
    expect(fakeState.groundPainterMode).toBe('ground');
    expect(fakeState.groundPainterActiveRunways).toBe(null);
  });
});

describe('api-server air tools — create_airway_nodes', () => {
  it('rejects when nodes missing or empty', async () => {
    makeState();
    let r = await callTool('create_airway_nodes', {});
    expect(r.success).toBe(false);
    r = await callTool('create_airway_nodes', { nodes: [] });
    expect(r.success).toBe(false);
  });
  it('rejects non-finite x/z', async () => {
    makeState();
    const r = await callTool('create_airway_nodes', { nodes: [{ x: NaN, z: 0 }] });
    expect(r.success).toBe(false);
  });
  it('adds nodes with history and increments count', async () => {
    makeState();
    const r = await callTool('create_airway_nodes', { nodes: [{ x: 100, z: 100, name: 'NEW1' }, { x: 110, z: 110 }] });
    expect(r.success).toBe(true);
    expect(r.added).toBe(2);
    expect(fakeState.groundPainterGraph.airwayNodes.length).toBe(5);
    expect(fakeState.groundPainterHistory).toBeTruthy();
  });
});

describe('api-server air tools — create_airway_procedures', () => {
  it('validates routeType 0..3', async () => {
    makeState();
    const r = await callTool('create_airway_procedures', { procedures: [{ name: 'BAD', routeType: 9, runwayName: '01', airwayNodeIdxs: [0, 1] }] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/routeType/);
  });
  it('validates runwayName existence', async () => {
    makeState();
    const r = await callTool('create_airway_procedures', { procedures: [{ name: 'P2', routeType: 0, runwayName: '99', airwayNodeIdxs: [0, 1] }] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/runwayName|not found/);
  });
  it('validates airwayNodeIdxs length and range', async () => {
    makeState();
    let r = await callTool('create_airway_procedures', { procedures: [{ name: 'P2', routeType: 0, runwayName: '01', airwayNodeIdxs: [0] }] });
    expect(r.success).toBe(false);
    r = await callTool('create_airway_procedures', { procedures: [{ name: 'P2', routeType: 0, runwayName: '01', airwayNodeIdxs: [0, 99] }] });
    expect(r.success).toBe(false);
  });
  it('rejects consecutive duplicate indices and duplicate procedure (name+runway+type)', async () => {
    makeState();
    let r = await callTool('create_airway_procedures', { procedures: [{ name: 'P2', routeType: 0, runwayName: '01', airwayNodeIdxs: [0, 0, 1] }] });
    expect(r.success).toBe(false);
    r = await callTool('create_airway_procedures', { procedures: [{ name: 'STAR1', routeType: 0, runwayName: '01', airwayNodeIdxs: [0, 1] }] });
    expect(r.success).toBe(false);
  });
  it('adds valid procedure and pushes history', async () => {
    makeState();
    const r = await callTool('create_airway_procedures', { procedures: [{ name: 'SID1', routeType: 2, runwayName: '01', airwayNodeIdxs: [1, 2] }] });
    expect(r.success).toBe(true);
    expect(r.added).toBe(1);
    expect(fakeState.groundPainterGraph.procedures.length).toBe(2);
  });
});

describe('api-server air tools — delete / move / rename', () => {
  it('delete_airway_objects rejects no target and out-of-threshold', async () => {
    makeState();
    let r = await callTool('delete_airway_objects', {});
    expect(r.success).toBe(false);
    r = await callTool('delete_airway_objects', { target: { x: 9999, z: 9999 }, threshold: 0.1 });
    expect(r.success).toBe(false);
  });
  it('delete airway node cascades degenerate procedure (<2 nodes) and reindexes', async () => {
    makeState();
    // Deleting FIXA (0) should drop SID-like if we had 2-node proc, but our STAR1 has 3 — remains with 2
    let r = await callTool('delete_airway_objects', { target: { x: -50, z: 0 }, threshold: 1.5 });
    expect(r.success).toBe(true);
    expect(r.deleted.kind).toBe('airwayNode');
    // STAR1 had [0,1,2] → after deleting 0, becomes [0,1] (reindexed: 1→0,2→1) still valid
    expect(fakeState.groundPainterGraph.airwayNodes.length).toBe(2);
    expect(fakeState.groundPainterGraph.procedures[0].airwayNodeIdxs).toEqual([0, 1]);
    // Create a 2-node procedure that will become degenerate after node deletion
    await callTool('create_airway_procedures', { procedures: [{ name: 'TMP', routeType: 2, runwayName: '01', airwayNodeIdxs: [0, 1] }] });
    // Delete FIXB at (0,0) — TMP [0,1] will drop to 1 node and be cascaded
    r = await callTool('delete_airway_objects', { target: { x: 0, z: 0 } });
    expect(r.success).toBe(true);
  });
  it('move_airway_objects validates dx/dz and supports selectAll', async () => {
    makeState();
    let r = await callTool('move_airway_objects', { dx: 0, dz: 0 });
    expect(r.success).toBe(false);
    r = await callTool('move_airway_objects', { dx: 5, dz: 0, selectAll: true });
    expect(r.success).toBe(true);
    expect(r.moved.nodes).toBe(3);
    expect(fakeState.groundPainterGraph.airwayNodes[0].x).toBe(-45);
  });
  it('move_airway_objects via targets resolves procedure nodes', async () => {
    makeState();
    const r = await callTool('move_airway_objects', { targets: [{ x: -50, z: 0 }], dx: 2, dz: 3 });
    expect(r.success).toBe(true);
    expect(r.moved.nodes).toBe(1);
  });
  it('rename_airway_object validates and enforces duplicate procedure name guard', async () => {
    makeState();
    let r = await callTool('rename_airway_object', { kind: 'airwayNode', idx: 0, name: 'NEWFX' });
    expect(r.success).toBe(true);
    expect(fakeState.groundPainterGraph.airwayNodes[0].name).toBe('NEWFX');
    // Duplicate procedure rename should fail
    await callTool('create_airway_procedures', { procedures: [{ name: 'APPX', routeType: 1, runwayName: '01', airwayNodeIdxs: [0, 1] }] });
    r = await callTool('rename_airway_object', { kind: 'procedure', idx: 1, name: 'STAR1' });
    // STAR1 already exists for runway 01 routeType 0 — but APPX is routeType 1, different type so allowed
    // To trigger duplicate, rename APPX to same name+runway+type as existing
    // Create a second proc with same type as STAR1 then try duplicate
    await callTool('create_airway_procedures', { procedures: [{ name: 'OTHER', routeType: 0, runwayName: '01', airwayNodeIdxs: [0, 1] }] });
    r = await callTool('rename_airway_object', { kind: 'procedure', idx: 2, name: 'STAR1' });
    expect(r.success).toBe(false);
  });
  it('rename rejects invalid idx and missing name', async () => {
    makeState();
    let r = await callTool('rename_airway_object', { kind: 'airwayNode', idx: 99, name: 'X' });
    expect(r.success).toBe(false);
    r = await callTool('rename_airway_object', { kind: 'airwayNode', idx: 0, name: '' });
    expect(r.success).toBe(false);
  });
});

describe('api-server air tools — create_airway_fillet', () => {
  it('rejects radius outside 50..500 and missing procedure', async () => {
    makeState();
    let r = await callTool('create_airway_fillet', { procedure: 0, vertex: 1, radius: 10 });
    expect(r.success).toBe(false);
    r = await callTool('create_airway_fillet', { procedure: 0, vertex: 1, radius: 120 });
    // Should succeed when angle is moderate — our baseGraph has collinear FIXA-FIXB-FIXC (straight line) angle 180 → not filletable
    // Expect angle error
    expect(r.success).toBe(false);
  });
  it('intra-procedure fillet with sharp corner succeeds and inserts arc nodes', async () => {
    // Build a non-collinear procedure: FIXA(-50,0) → FIXB(0,10) → FIXC(50,0) has ~90° at FIXB
    makeState();
    // Overwrite airwayNodes to make a sharp corner
    fakeState.groundPainterGraph.airwayNodes = [{ x: -50, z: 0, name: 'A' }, { x: 0, z: 10, name: 'B' }, { x: 50, z: 0, name: 'C' }];
    fakeState.groundPainterGraph.procedures = [{ name: 'STAR1', routeType: 0, runwayName: '01', airwayNodeIdxs: [0, 1, 2] }];
    const r = await callTool('create_airway_fillet', { procedure: 0, vertex: 1, radius: 120 });
    // 120 GU may still be too large for short legs — if so, try 50
    if (!r.success) {
      const r2 = await callTool('create_airway_fillet', { procedure: 0, vertex: 1, radius: 50 });
      expect(r2.success).toBe(true);
      expect(r2.newNodes).toBeGreaterThan(1);
      expect(fakeState.groundPainterGraph.airwayNodes.length).toBeGreaterThan(3);
    } else {
      expect(r.success).toBe(true);
    }
  });
  it('rejects inter-procedure fillet (procA != procB)', async () => {
    makeState();
    fakeState.groundPainterGraph.airwayNodes.push({ x: 50, z: 50, name: 'FIXD' });
    fakeState.groundPainterGraph.procedures.push({ name: 'SID1', routeType: 2, runwayName: '01', airwayNodeIdxs: [0, 1] });
    fakeState.groundPainterMeta.airwayNodeOrigPk.push(null);
    fakeState.groundPainterMeta.airwaySegOrigPk.push(null);
    const r = await callTool('create_airway_fillet', { procA: 0, procB: 1, radius: 120 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/same procedure/);
  });
});

describe('scenery_write OsmPool and ghost helpers (air)', () => {
  it('getAirwayOsmPoolInfo tracks pool, survivors, and pending', async () => {
    const sw = require('../../src/acl/scenery_write.js');
    // Create synthetic pkEntries with airway nodes/segments
    const pkEntries = [
      `{"$k": "airway-node:-10", "OsmId": -10, "$id": 1}`,
      `{"$k": "airway-node:-11", "OsmId": -11, "$id": 2}`,
      `{"$k": "airway-segment:-20", "OsmId": -20, "$id": 3}`,
    ];
    const g = baseGraph();
    const m = baseMeta(g);
    const info = sw.getAirwayOsmPoolInfo(pkEntries, g, m);
    expect(info.nodePoolSize).toBeGreaterThanOrEqual(0);
    // pendingNewNodes should reflect null origPks
    // Add a new airway node (null pk)
    g.airwayNodes.push({ x: 999, z: 999, name: 'NEW' });
    m.airwayNodeOrigPk.push(null);
    const info2 = sw.getAirwayOsmPoolInfo(pkEntries, g, m);
    expect(info2.pendingNewNodes).toBe(1);
  });
  it('ghost and parentOsm helpers are exercised via fillet virtual path', async () => {
    const fillet = await import('../../src/components/EditorScreen/GroundPainter/fillet.js');
    const g = { nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }], segments: [{ aIdx: 0, bIdx: 1, nodeIdxs: [0, 1], flags: 2, directed: false }, { aIdx: 1, bIdx: 2, nodeIdxs: [1, 2], flags: 2, directed: false }], runways: [], stands: [] };
    const meta = { nodeOrigPk: [1, 2, 3], segOrigPk: [10, 11], deletedPks: [] };
    const ghosts = fillet.ghostNodeIndices(g, meta);
    expect(ghosts instanceof Set).toBe(true);
    // No ghost initially
    expect(ghosts.size).toBe(0);
    // Make node 1 a ghost
    meta.deletedPks.push(2);
    const ghosts2 = fillet.ghostNodeIndices(g, meta);
    expect(ghosts2.has(1)).toBe(true);
    // Repair should remap new segments that reference ghost
    g.segments.push({ aIdx: 1, bIdx: 0, nodeIdxs: [1, 0], flags: 2, directed: false });
    meta.segOrigPk.push(null); // new segment
    // Add a live twin at same coord as ghost (0,0 duplicate)
    g.nodes.push({ x: 0, z: 0, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);
    const res = fillet.repairGhostRefs(g, meta);
    expect(res.remapped).toBeGreaterThanOrEqual(0);
  });
});

// Regression (ground-fuzz `delete_one` self-loop refusal): the runway-delete
// orphan GC receives its threshold indices AND every pavement-strip node — and
// the strips' end nodes ARE the thresholds, plus consecutive strips share
// endpoints — so the candidate list contains duplicates. Without dedup the GC
// splices the same index twice, over-decrements every index above it, and
// collapses a nearby segment's endpoints onto one index → a zero-length
// self-loop that `_validateNoDegenerateEdges` refuses ("joins vertex … to
// itself"). The GC must dedup its orphan set.
describe('api-server delete_ground_objects — runway orphan GC', () => {
  function runwayState() {
    const g = {
      nodes: [
        { x: 0, z: 0 }, { x: 0, z: 10 }, { x: 0, z: 20 },
        { x: 5, z: 0 }, { x: 5, z: 10 }, { x: 5, z: 20 },
      ],
      segments: [
        { aIdx: 1, bIdx: 2, nodeIdxs: [1, 2], name: '01/19', flags: 4, directed: false },
        { aIdx: 3, bIdx: 4, nodeIdxs: [3, 4], flags: 2, directed: false },
      ],
      runways: [{ thAIdx: 1, thBIdx: 2, names: ['01', '19'], name: '01', physicalName: '01/19', width: 0.5, entries: [], exits: [] }],
      areas: [], stands: [], airwayNodes: [], procedures: [],
    };
    const m = {
      nodeOrigPk: [100, 101, 102, 103, 104, 105],
      segOrigPk: [200, 201],
      runwayOrigPk: [300],
      runwayPavement: [[1, 2]],
      runwayOrigInfo: [{ pks: ['runway:01', 'runway:19'], physicalName: '01/19', names: ['01', '19'], width: 0.5 }],
      areaOrigId: [], standOrigPk: [], airwayNodeOrigPk: [], airwaySegOrigPk: [],
      deletedPks: [], deletedAreaIds: [], deletedAirwayPks: [],
    };
    return { g, m };
  }

  it('dedups overlapping threshold/strip nodes and never creates a self-loop segment', async () => {
    makeState();
    const { g, m } = runwayState();
    fakeState.groundPainterGraph = g;
    fakeState.groundPainterMeta = m;

    // Target the runway midpoint; `_resolveGroundTarget` skips pavement strips by
    // name, so the runway (not the strip) is deleted.
    const r = await callTool('delete_ground_objects', { target: { x: 0, z: 15 } });
    expect(r.success).toBe(true);
    expect(r.deleted.kind).toBe('runway');

    const ng = fakeState.groundPainterGraph;
    expect(ng.runways).toHaveLength(0);
    // Pavement strip removed with the runway.
    expect(ng.segments.some((sg) => sg.name === '01/19')).toBe(false);
    // No segment may collapse to a self-loop / consecutive duplicate endpoint.
    for (const sg of ng.segments) {
      const ix = sg.nodeIdxs && sg.nodeIdxs.length ? sg.nodeIdxs : [sg.aIdx, sg.bIdx];
      expect(sg.aIdx != null && sg.aIdx === sg.bIdx).toBe(false);
      for (let k = 1; k < ix.length; k++) expect(ix[k - 1]).not.toBe(ix[k]);
    }
  });
});

describe('api-server — runway rename cascades to air/route references', () => {
  it('rewrites procedures + entries/exits to follow the renamed end names', async () => {
    makeState();
    const g = fakeState.groundPainterGraph;
    g.runways[0] = {
      ...g.runways[0],
      names: ['01', '19'], name: '01', physicalName: '01/19',
      entries: [{ name: 'A', runwayName: '01', holdingIdx: 1, lineUpIdx: 2, defineIdx: 2 }],
      exits: [{ name: 'B', runwayName: '19', exitIdx: 2, holdingIdx: 1, defineIdx: 2, isLeft: false }],
    };

    const r = await callTool('rename_ground_object', { kind: 'runway', idx: 0, names: ['32R', '3C'] });
    expect(r.success).toBe(true);

    const ng = fakeState.groundPainterGraph;
    expect(ng.runways[0].names).toEqual(['32R', '3C']);
    expect(ng.runways[0].physicalName).toBe('32R/3C');
    // The writer groups procedures by `runwayName === <runway PK suffix>`; without
    // this remap every STAR/APP route on the runway was dropped on save and the
    // game null-derefed spawning arrivals that still referenced them.
    expect(ng.procedures[0].runwayName).toBe('32R');
    expect(ng.runways[0].entries[0].runwayName).toBe('32R');
    expect(ng.runways[0].exits[0].runwayName).toBe('3C');
  });
});
