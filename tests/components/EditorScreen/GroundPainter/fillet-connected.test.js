import { describe, it, expect } from 'vitest';
import { computeFillet } from '../../../../src/components/EditorScreen/GroundPainter/fillet.js';

// ── Helpers (mirrors fillet-virtual.test.js) ─────────────────────────────
function mkGraph(pts, segPairs, segExtras = []) {
  const nodes = pts.map(([x, z]) => ({ x, z }));
  const segments = segPairs.map(([a, b], i) => ({
    aIdx: a, bIdx: b, nodeIdxs: [a, b], flags: 2, directed: false,
    ...(segExtras[i] || {}),
  }));
  return { nodes, segments, runways: [], stands: [], areas: [] };
}

// Classic connected L corner: A runs west from O=(10,0), B runs north from O.
// 90° corner: tangent distance t = r / tan(45°) = r.
const CORNER_PTS = [[0, 0], [10, 0], [10, 10]];

describe('computeFillet — connected (shared node) picks', () => {
  it('rounds the shared corner: O is the shared endpoint, tangents at t=r along each leg', () => {
    const g = mkGraph(CORNER_PTS, [[0, 1], [1, 2]]);
    const res = computeFillet(g, 0, 1, 2);
    expect(res.ok).toBe(true);
    expect(res.virtualO).toBe(false);
    expect(res.duplicate).toBe(false);
    expect(res.oIdx).toBe(1);
    expect(res.o.x).toBeCloseTo(10, 6);
    expect(res.o.z).toBeCloseTo(0, 6);
    expect(res.t).toBeCloseTo(2, 6);
    expect(res.t1.x).toBeCloseTo(8, 6);
    expect(res.t1.z).toBeCloseTo(0, 6);
    expect(res.t2.x).toBeCloseTo(10, 6);
    expect(res.t2.z).toBeCloseTo(2, 6);
    expect(res.nearIdxA).toBe(1);
    expect(res.nearIdxB).toBe(1);
    // rMax keeps the tangents inside the 10 GU legs: 10 * tan(45°) * 0.98
    expect(res.rMax).toBeCloseTo(9.8, 6);
    // arc sweeps the minor (90°) arc away from O, endpoints exactly t1/t2
    expect(res.arcPoints[0].x).toBeCloseTo(8, 6);
    expect(res.arcPoints[res.arcPoints.length - 1].z).toBeCloseTo(2, 6);
  });

  it('clamps the radius to rMax when the requested radius exceeds the short leg', () => {
    // B leg is only 1.5 GU: rMax = 1.5 * 0.98 = 1.47 < requested 2.
    const g = mkGraph([[0, 0], [10, 0], [10, 1.5]], [[0, 1], [1, 2]]);
    const res = computeFillet(g, 0, 1, 2);
    expect(res.ok).toBe(true);
    expect(res.rEff).toBeCloseTo(1.47, 6);
    expect(res.rEff).toBeLessThan(res.rReq);
    expect(res.t).toBeCloseTo(1.47, 6); // cot(45°) = 1
  });

  it('handles duplicate nodes at one snap point (T junction arms with separate O vertices)', () => {
    // Segments do NOT share an index, but node 1 and node 2 share the O coordinate.
    const g = mkGraph([[0, 0], [10, 0], [10, 0], [10, 10]], [[0, 1], [2, 3]]);
    const res = computeFillet(g, 0, 1, 2);
    expect(res.ok).toBe(true);
    expect(res.duplicate).toBe(true);
    expect(res.oIdxA).toBe(1);
    expect(res.oIdxB).toBe(2);
    expect(res.o.x).toBeCloseTo(10, 6);
    expect(res.o.z).toBeCloseTo(0, 6);
    expect(res.t1.x).toBeCloseTo(8, 6);
    expect(res.t2.z).toBeCloseTo(2, 6);
    expect(res.nearIdxA).toBe(1);
    expect(res.nearIdxB).toBe(2);
  });

  it('picks the LONGER ray for a runway pavement strip whose O (threshold) is interior', () => {
    // 4-point pavement strip (flags 4) along x=10: overhang (10,10.6), threshold
    // O=(10,10), runway end (10,-40), far overhang (10,-40.6). The connected leg
    // runs west from O. The ray must go INTO the runway (50.6 GU), not the 0.6
    // overhang stub, so the tangent lands at (10,8).
    const g = {
      nodes: [
        { x: 10, z: 10.6 }, { x: 10, z: 10 }, { x: 10, z: -40 }, { x: 10, z: -40.6 }, { x: 0, z: 10 },
      ],
      segments: [
        { aIdx: 0, bIdx: 3, nodeIdxs: [0, 1, 2, 3], flags: 4, directed: false, name: '04/22' },
        { aIdx: 1, bIdx: 4, nodeIdxs: [1, 4], flags: 2, directed: false },
      ],
      runways: [], stands: [], areas: [],
    };
    const res = computeFillet(g, 0, 1, 2);
    expect(res.ok).toBe(true);
    expect(res.virtualO).toBe(false);
    expect(res.oIdx).toBe(1);
    expect(res.p1Idx).toBe(3); // far end of the pavement interior, not the overhang
    expect(res.t1.x).toBeCloseTo(10, 6);
    expect(res.t1.z).toBeCloseTo(8, 6);
    expect(res.t2.x).toBeCloseTo(8, 6);
    expect(res.t2.z).toBeCloseTo(10, 6);
  });
});

describe('computeFillet — connected pick rejections', () => {
  it('rejects a degenerate leg (zero-length ray) instead of crashing', () => {
    // B collapses onto O itself: no usable ray.
    const g = mkGraph([[0, 0], [10, 0], [10, 0]], [[0, 1], [1, 2]]);
    const res = computeFillet(g, 0, 1, 2);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ground_painter_fillet_error_degenerate');
  });

  it('rejects a leg whose far node is missing from the graph', () => {
    const g = mkGraph(CORNER_PTS, [[0, 1], [1, 2]]);
    g.segments[1].nodeIdxs = [1, 99];
    g.segments[1].bIdx = 99;
    const res = computeFillet(g, 0, 1, 2);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ground_painter_fillet_error_degenerate');
  });

  it('rejects a collinear continuation (no corner to round)', () => {
    const g = mkGraph([[0, 0], [10, 0], [30, 0]], [[0, 1], [1, 2]]);
    const res = computeFillet(g, 0, 1, 2);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ground_painter_fillet_error_angle');
  });
});
