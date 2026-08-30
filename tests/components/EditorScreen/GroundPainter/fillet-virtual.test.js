import { describe, it, expect } from 'vitest';
import { computeFillet, applyVirtualFillet } from '../../../../src/components/EditorScreen/GroundPainter/fillet.js';

// ── Helpers ──────────────────────────────────────────────────────────────
function mkGraph(pts, segPairs, segExtras = []) {
  const nodes = pts.map(([x, z]) => ({ x, z }));
  const segments = segPairs.map(([a, b], i) => ({
    aIdx: a, bIdx: b, nodeIdxs: [a, b], flags: 2, directed: false,
    ...(segExtras[i] || {}),
  }));
  return { nodes, segments, runways: [], stands: [], areas: [] };
}

function mkMeta(g) {
  return {
    nodeOrigPk: g.nodes.map((_, i) => 1000 + i),
    segOrigPk: g.segments.map((_, i) => 2000 + i),
    deletedPks: [],
  };
}

function polyLen(g, seg) {
  const pts = (seg.nodeIdxs || [seg.aIdx, seg.bIdx]).map((i) => g.nodes[i]).filter(Boolean);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return len;
}

function totalLen(g) {
  return g.segments.reduce((s, sg) => s + polyLen(g, sg), 0);
}

function referencedNodes(g) {
  const used = new Set();
  for (const sg of g.segments) for (const i of (sg.nodeIdxs || [sg.aIdx, sg.bIdx])) used.add(i);
  return used;
}

function nodeAt(g, x, z, eps = 1e-6) {
  return g.nodes.findIndex((n) => n && Math.abs(n.x - x) < eps && Math.abs(n.z - z) < eps);
}

// L-gap: A runs south from (10,0), B runs west from (0,10). Their lines cross at
// the imaginary O=(10,10) ahead of both — the classic disconnected fillet.
const L_GAP_PTS = [[10, 0], [10, -50], [0, 10], [-50, 10]];

describe('computeFillet — virtual (disconnected) picks', () => {
  it('computes the tangent geometry at the imaginary intersection', () => {
    const g = mkGraph(L_GAP_PTS, [[0, 1], [2, 3]]);
    const res = computeFillet(g, 0, 1, 2);
    expect(res.ok).toBe(true);
    expect(res.virtualO).toBe(true);
    expect(res.o.x).toBeCloseTo(10, 6);
    expect(res.o.z).toBeCloseTo(10, 6);
    // 90° corner: tangent distance t = r / tan(45°) = r
    expect(res.t).toBeCloseTo(2, 6);
    expect(res.t1.x).toBeCloseTo(10, 6);
    expect(res.t1.z).toBeCloseTo(8, 6);
    expect(res.t2.x).toBeCloseTo(8, 6);
    expect(res.t2.z).toBeCloseTo(10, 6);
    expect(res.nearIdxA).toBe(0);
    expect(res.nearIdxB).toBe(2);
  });

  it('rejects parallel disconnected picks instead of crashing', () => {
    const g = mkGraph([[0, 0], [10, 0], [0, 5], [10, 5]], [[0, 1], [2, 3]]);
    const res = computeFillet(g, 0, 1, 2);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ground_painter_fillet_error_parallel');
  });

  it('rejects collinear-disjoint picks (no intersection point)', () => {
    const g = mkGraph([[0, 0], [5, 0], [7, 0], [12, 0]], [[0, 1], [2, 3]]);
    const res = computeFillet(g, 0, 1, 2);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ground_painter_fillet_error_parallel');
  });
});

describe('applyVirtualFillet — tangent beyond the near endpoints (gap bridged by stubs)', () => {
  const g0 = mkGraph(L_GAP_PTS, [[0, 1], [2, 3]]);
  const res = computeFillet(g0, 0, 1, 2);
  const g = structuredClone(g0);
  const m = mkMeta(g);
  applyVirtualFillet(g, m, res, 0, 1);

  it('keeps both original segments fully intact with their PKs', () => {
    expect(g.segments[0].nodeIdxs).toEqual([0, 1]);
    expect(g.segments[1].nodeIdxs).toEqual([2, 3]);
    expect(m.segOrigPk[0]).toBe(2000);
    expect(m.segOrigPk[1]).toBe(2001);
    expect(m.deletedPks).toEqual([]);
  });

  it('adds one extension stub per segment plus the arc, and deletes nothing', () => {
    // 2 originals + 2 stubs + 1 arc
    expect(g.segments.length).toBe(5);
    // Every original node is still referenced by some segment
    for (let i = 0; i < 4; i++) expect(referencedNodes(g).has(i)).toBe(true);
    // Total taxiway length only grew (stubs + arc added on top)
    expect(totalLen(g)).toBeGreaterThan(totalLen(g0));
  });

  it('bridges each gap with a stub from the tangent point to the near endpoint', () => {
    const t1Idx = nodeAt(g, 10, 8);
    const t2Idx = nodeAt(g, 8, 10);
    expect(t1Idx).toBeGreaterThanOrEqual(0);
    expect(t2Idx).toBeGreaterThanOrEqual(0);
    const stubA = g.segments.find((sg) => (sg.nodeIdxs || []).includes(t1Idx) && (sg.nodeIdxs || []).includes(0));
    const stubB = g.segments.find((sg) => (sg.nodeIdxs || []).includes(t2Idx) && (sg.nodeIdxs || []).includes(2));
    expect(stubA).toBeTruthy();
    expect(stubB).toBeTruthy();
  });

  it('anchors the arc at the stub tangent nodes', () => {
    const arc = g.segments[g.segments.length - 1];
    expect(arc.flags).toBe(2);
    expect(arc.nodeIdxs[0]).toBe(nodeAt(g, 10, 8));
    expect(arc.nodeIdxs[arc.nodeIdxs.length - 1]).toBe(nodeAt(g, 8, 10));
  });
});

describe('applyVirtualFillet — tangent point inside the span (segments split, nothing trimmed)', () => {
  // Near endpoints sit 1 GU from the imaginary O=(10,10); with r=2 the tangent
  // points (distance 2) land INSIDE both segments. The old code deleted the
  // [near..tangent] piece of each — the invariant is that it must stay.
  const g0 = mkGraph([[10, 9], [10, -50], [9, 10], [-50, 10]], [[0, 1], [2, 3]]);
  const res = computeFillet(g0, 0, 1, 2);
  const g = structuredClone(g0);
  const m = mkMeta(g);
  applyVirtualFillet(g, m, res, 0, 1);

  it('preserves every original node and the full length of both lines', () => {
    for (let i = 0; i < 4; i++) expect(referencedNodes(g).has(i)).toBe(true);
    // A-line (x=10): pieces must still cover z from 9 down to -50 with no gap
    const aPts = [];
    const bPts = [];
    for (const sg of g.segments) {
      for (const ni of sg.nodeIdxs || []) {
        const n = g.nodes[ni];
        if (Math.abs(n.x - 10) < 1e-6) aPts.push(n.z);
        if (Math.abs(n.z - 10) < 1e-6) bPts.push(n.x);
      }
    }
    aPts.sort((p, q) => q - p);
    bPts.sort((p, q) => q - p);
    expect(aPts[0]).toBeCloseTo(9, 6);
    expect(aPts[aPts.length - 1]).toBeCloseTo(-50, 6);
    expect(bPts[0]).toBeCloseTo(9, 6);
    expect(bPts[bPts.length - 1]).toBeCloseTo(-50, 6);
    // monotonic coverage with no gaps > 1e-6 between consecutive points
    for (const pts of [aPts, bPts]) {
      for (let i = 1; i < pts.length; i++) expect(pts[i - 1] - pts[i]).toBeGreaterThan(-1e-6);
    }
  });

  it('splits both segments at the tangent points and branches the arc there', () => {
    // both original PKs ghost-deleted (their geometry lives on in the pieces)
    expect(m.deletedPks.sort()).toEqual([2000, 2001]);
    // tangent nodes exist at (10,8) and (8,10)
    const t1Idx = nodeAt(g, 10, 8);
    const t2Idx = nodeAt(g, 8, 10);
    expect(t1Idx).toBeGreaterThanOrEqual(0);
    expect(t2Idx).toBeGreaterThanOrEqual(0);
    // each tangent node is shared by a kept piece AND the arc (real junction)
    const arc = g.segments[g.segments.length - 1];
    const uses = (idx, sg) => (sg.nodeIdxs || []).includes(idx);
    expect(g.segments.filter((sg) => sg !== arc && uses(t1Idx, sg)).length).toBeGreaterThanOrEqual(1);
    expect(g.segments.filter((sg) => sg !== arc && uses(t2Idx, sg)).length).toBeGreaterThanOrEqual(1);
    expect(uses(t1Idx, arc)).toBe(true);
    expect(uses(t2Idx, arc)).toBe(true);
  });

  it('never shortens the network', () => {
    expect(totalLen(g)).toBeGreaterThan(totalLen(g0));
  });
});

describe('applyVirtualFillet — a node already sits at the tangent point', () => {
  // Endpoints exactly at the tangent distance (2 GU from O): the arc anchors
  // directly on the existing nodes — no stub, no split, no new tangent node.
  const g0 = mkGraph([[10, 8], [10, -50], [8, 10], [-50, 10]], [[0, 1], [2, 3]]);
  const res = computeFillet(g0, 0, 1, 2);
  const g = structuredClone(g0);
  const m = mkMeta(g);
  applyVirtualFillet(g, m, res, 0, 1);

  it('only adds the arc, anchored at the pre-existing endpoint nodes', () => {
    expect(g.segments.length).toBe(3);
    expect(g.segments[0].nodeIdxs).toEqual([0, 1]);
    expect(g.segments[1].nodeIdxs).toEqual([2, 3]);
    expect(m.deletedPks).toEqual([]);
    const arc = g.segments[2];
    expect(arc.nodeIdxs[0]).toBe(0);
    expect(arc.nodeIdxs[arc.nodeIdxs.length - 1]).toBe(2);
    expect(g.nodes.length).toBe(g0.nodes.length + arc.nodeIdxs.length - 2);
  });
});

describe('applyVirtualFillet — runway pavement strip (4 collinear points) as a picked leg', () => {
  // Pavement strip overhang-threshold-threshold-overhang along x=10, filleted
  // into a horizontal segment whose line crosses at the threshold O=(10,10).
  // The overhang stub behind O is tolerated (≤0.75 GU) by the straddle check.
  const g0 = mkGraph(
    [[10, 10.6], [10, 10], [10, -40], [10, -40.6], [0, 10], [-50, 10]],
    [[0, 3], [4, 5]],
    [{ flags: 4, name: '04/19' }, {}],
  );
  // Repair the pavement strip to its real 4-point polyline
  g0.segments[0].nodeIdxs = [0, 1, 2, 3];
  const res = computeFillet(g0, 0, 1, 2);
  const g = structuredClone(g0);
  const m = mkMeta(g);
  applyVirtualFillet(g, m, res, 0, 1);

  it('keeps the whole strip including the overhang, split at the tangent point', () => {
    expect(res.ok).toBe(true);
    for (let i = 0; i < 6; i++) expect(referencedNodes(g).has(i)).toBe(true);
    // all four original strip nodes survive on x=10 pieces
    const stripNodes = new Set();
    for (const sg of g.segments) {
      if (sg.flags !== 4) continue;
      for (const ni of sg.nodeIdxs || []) stripNodes.add(ni);
    }
    for (const i of [0, 1, 2, 3]) expect(stripNodes.has(i)).toBe(true);
    expect(totalLen(g)).toBeGreaterThan(totalLen(g0));
  });
});
