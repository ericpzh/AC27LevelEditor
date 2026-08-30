import { describe, it, expect } from 'vitest';
import {
  segNodeIdxs, polylineLengthMeters, segmentLengthMeters, runwayLengthMeters,
  formatLengthMeters, buildTaxiPaths,
} from '../../../../src/components/EditorScreen/GroundPainter/metrics';

// 1 GU = 100 m (DEFAULT_AIRPORT_SCALE)

describe('segNodeIdxs', () => {
  it('prefers nodeIdxs when present', () => {
    expect(segNodeIdxs({ nodeIdxs: [1, 2, 3], aIdx: 7, bIdx: 8 })).toEqual([1, 2, 3]);
  });
  it('falls back to legacy aIdx/bIdx and tolerates null', () => {
    expect(segNodeIdxs({ aIdx: 4, bIdx: 5 })).toEqual([4, 5]);
    expect(segNodeIdxs(null)).toEqual([]);
  });
});

describe('polylineLengthMeters', () => {
  it('sums consecutive legs (not the closing chord)', () => {
    // legs 3 + 4 = 7 GU = 700 m
    const pts = [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 4 }];
    expect(polylineLengthMeters(pts)).toBe(700);
  });
  it('is 0 below two points; a null point breaks the pair chain to its neighbors', () => {
    expect(polylineLengthMeters(null)).toBe(0);
    expect(polylineLengthMeters([{ x: 0, z: 0 }])).toBe(0);
    // pairs (p0,null) and (null,p2) are both skipped — nothing accumulates.
    expect(polylineLengthMeters([{ x: 0, z: 0 }, null, { x: 10, z: 0 }])).toBe(0);
  });
});

describe('segmentLengthMeters', () => {
  const graph = {
    nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 4 }],
    segments: [
      { nodeIdxs: [0, 1] },                    // straight 10 GU
      { nodeIdxs: [1, 2] },                    // 4 GU
      { nodeIdxs: [0, 1, 2] },                 // polyline 14 GU
      { aIdx: 0, bIdx: 1 },                    // legacy form
      { nodeIdxs: [0, 99] },                   // dangling node filtered out
    ],
  };
  it('measures straight, polyline and legacy segments', () => {
    expect(segmentLengthMeters(graph, 0)).toBe(1000);
    expect(segmentLengthMeters(graph, 1)).toBe(400);
    expect(segmentLengthMeters(graph, 2)).toBe(1400);
    expect(segmentLengthMeters(graph, 3)).toBe(1000);
  });
  it('returns null for missing segment, degenerate polyline, or dangling nodes', () => {
    expect(segmentLengthMeters(graph, 99)).toBeNull();
    expect(segmentLengthMeters(null, 0)).toBeNull();
    expect(segmentLengthMeters(graph, 4)).toBeNull(); // only 1 resolvable point
  });
});

describe('runwayLengthMeters', () => {
  const graph = {
    nodes: [{ x: 0, z: 0 }, { x: 18, z: 24 }], // 30 GU apart
    runways: [{ thAIdx: 0, thBIdx: 1 }, { thAIdx: 0, thBIdx: 99 }, {}],
  };
  it('measures threshold-to-threshold distance', () => {
    expect(runwayLengthMeters(graph, 0)).toBe(3000);
  });
  it('returns null for dangling thresholds or malformed rows', () => {
    expect(runwayLengthMeters(graph, 1)).toBeNull();
    expect(runwayLengthMeters(graph, 2)).toBeNull();
    expect(runwayLengthMeters({ nodes: [], runways: [] }, 0)).toBeNull();
  });
});

describe('formatLengthMeters', () => {
  it('formats finite values with a unit and thousands separators', () => {
    expect(formatLengthMeters(1200)).toMatch(/1,200 m|1200 m/); // locale-dependent grouping
    expect(formatLengthMeters(0)).toBe('0 m');
  });
  it('returns empty for null/non-finite', () => {
    expect(formatLengthMeters(null)).toBe('');
    expect(formatLengthMeters(NaN)).toBe('');
    expect(formatLengthMeters(Infinity)).toBe('');
  });
});

describe('buildTaxiPaths', () => {
  it('builds one polyline per segment, dropping missing nodes and <2-point stubs', () => {
    const graph = {
      nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }],
      segments: [
        { nodeIdxs: [0, 1] },
        { nodeIdxs: [0, 1, 2] },
        { nodeIdxs: [0, 99] },   // missing node → 1 point → dropped
        { aIdx: 1, bIdx: 2 },
      ],
    };
    const paths = buildTaxiPaths(graph);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toEqual([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    expect(paths[1]).toHaveLength(3);
    expect(paths[2]).toEqual([{ x: 10, z: 0 }, { x: 10, z: 10 }]);
  });
  it('tolerates a graph without segments', () => {
    expect(buildTaxiPaths({ nodes: [] })).toEqual([]);
  });
});
