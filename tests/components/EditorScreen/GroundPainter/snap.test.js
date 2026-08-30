import { describe, it, expect } from 'vitest';
import {
  findSnap, SNAP_TYPES, collectSnapGeometry, dynamicSnapDist, dynamicAngleTolDeg,
  getSnapGuides, getSnappedWorldPos, distancePointToLine, closestPointOnSegment,
  projectPointToLine, segmentAngleDeg, normalizeAngle180, angleDiffToLine, worldSnapDist,
} from '../../../../src/components/EditorScreen/GroundPainter/snap.js';

const opts = (extra = {}) => ({ snapDist: 0.5, angleToleranceDeg: 5, ...extra });

// Straight ground edge: A=(0,0) → B=(10,0). Drawing the next vertex from B.
const PREV = { x: 0, z: 0 };
const ANCHOR = { x: 10, z: 0 };

describe('findSnap endpoint / on-segment', () => {
  it('snaps to a nearby existing vertex', () => {
    const geom = { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }], segments: [] };
    const res = findSnap({ x: 10.3, z: 0.1 }, null, geom, opts());
    expect(res.type).toBe(SNAP_TYPES.ENDPOINT);
    expect(res.x).toBeCloseTo(10, 5);
    expect(res.z).toBeCloseTo(0, 5);
  });
});

describe('findSnap angle snap (relative to the last drawn edge)', () => {
  const empty = { points: [], segments: [] };

  it('snaps a fresh edge to the collinear (180° vertex) continuation', () => {
    const res = findSnap({ x: 20, z: 0.4 }, ANCHOR, empty, opts({ prev: PREV }));
    expect(res.type).toBe(SNAP_TYPES.EXTENSION_180);
    expect(res.kind).toBe('anchor');
    expect(res.angle).toBeCloseTo(180, 5);
    expect(res.z).toBeCloseTo(0, 5); // y snapped off the ~0.4 offset onto the straight continuation
  });

  it('snaps a fresh edge perpendicular (90° vertex) to the last edge', () => {
    const res = findSnap({ x: 10.3, z: 8 }, ANCHOR, empty, opts({ prev: PREV }));
    expect(res.type).toBe(SNAP_TYPES.PERPENDICULAR_90);
    expect(res.kind).toBe('anchor');
    expect(res.angle).toBeCloseTo(90, 5);
    expect(res.x).toBeCloseTo(10, 5); // x snapped to the perpendicular ray
  });

  it('snaps a fresh edge diagonal (45° / 135° vertex)', () => {
    const res = findSnap({ x: 16.5, z: 7.5 }, ANCHOR, empty, opts({ prev: PREV }));
    expect(res.type).toBe(SNAP_TYPES.DIAGONAL_45);
    expect(res.angle).toBeCloseTo(135, 5);
  });

  it('does NOT snap when the turn is far from any nice angle', () => {
    // ~30° turn, 15° from the nearest target (45°) and 30° from collinear.
    const res = findSnap({ x: 18.66, z: 5 }, ANCHOR, empty, opts({ prev: PREV }));
    expect(res).toBeNull();
  });

  it('does NOT snap on the first edge (no previous vertex)', () => {
    expect(findSnap({ x: 20, z: 0.4 }, ANCHOR, empty, opts({ prev: null }))).toBeNull();
  });
});

describe('collectSnapGeometry', () => {
  it('builds points + segments from a Graph-shaped input', () => {
    const geom = collectSnapGeometry({
      nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
      segments: [{ nodeIdxs: [0, 1] }],
    });
    expect(geom.points).toHaveLength(2);
    expect(geom.segments).toHaveLength(1);
  });

  it('enriches a Graph with runway baselines, closed area rings and stand axes', () => {
    const geom = collectSnapGeometry({
      nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }, { x: 5, z: 5 }, { x: 5, z: 7 }],
      segments: [
        { nodeIdxs: [0, 1, 2] },   // two edges
        { nodeIdxs: [0, 0] },      // zero-length edge dropped
        { aIdx: 0, bIdx: 1 },      // legacy aIdx/bIdx form
      ],
      runways: [{ thAIdx: 0, thBIdx: 2 }],
      areas: [{ points: [{ x: 1, z: 1 }, { x: 2, z: 1 }, { x: 2, z: 2 }] }],
      stands: [{ noseIdx: 0, tailIdx: 3 }],
    });
    // 2 (polyline) + 1 (legacy) + 1 (runway) + 3 (closed ring) + 1 (stand) = 8
    expect(geom.segments).toHaveLength(8);
    // 5 nodes + 3 area corners, with the stand nose (0,0) deduped against node 0
    expect(geom.points).toHaveLength(8);
  });

  it('reads the editor val shapes ({ taxiwayPaths, runwayData, areaData, standPositions })', () => {
    const geom = collectSnapGeometry({
      taxiwayPaths: { paths: [{ points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] }, { points: [{ x: 0, z: 5 }, { x: 0, z: 15 }] }] },
      runwayData: { r1: { points: [{ x: 0, z: 0 }, { x: 30, z: 0 }] }, r2: {} },
      areaData: { bld: [{ points: [{ x: 1, z: 1 }, { x: 2, z: 1 }, { x: 2, z: 2 }] }] },
      standPositions: { s1: { x: 3, y: 3 }, s2: {} },
    });
    // 2 path edges + 1 runway baseline (first→last; malformed row skipped) + 3 ring edges
    expect(geom.segments).toHaveLength(6);
    // path vertices + 3 area corners + the stand point = 8
    expect(geom.points).toHaveLength(8);
    // NOTE: standPositions read st.y but pushPoint stores it in the z slot.
    expect(geom.points).toContainEqual({ x: 3, z: 3 });
  });

  it('returns empty geometry for null input', () => {
    expect(collectSnapGeometry(null)).toEqual({ points: [], segments: [] });
  });
});

describe('dynamicSnapDist (zoom-aware snap distance)', () => {
  const BASE = 1000; // base (fit) viewBox diagonal in world units
  const atBase = dynamicSnapDist(BASE, BASE);        // zoom = 1
  const zoomedIn = dynamicSnapDist(BASE / 4, BASE);  // zoom = 0.25
  const zoomedOut = dynamicSnapDist(BASE * 2, BASE); // zoom = 2

  it('snap distance shrinks when zoomed in and grows when zoomed out', () => {
    expect(zoomedIn).toBeLessThan(atBase);
    expect(zoomedOut).toBeGreaterThan(atBase);
  });

  it('world distance is proportional to the viewport at base zoom', () => {
    // snap = baseDiag * factor at zoom 1 (factor default 0.012)
    expect(atBase).toBeCloseTo(BASE * 0.012, 5);
  });

  it('the on-screen grab aperture is tighter when zoomed in (less grabby)', () => {
    // screen aperture ∝ snap / vbDiag; pow>1 shrinks it when zoomed in
    expect(zoomedIn / (BASE / 4)).toBeLessThan(atBase / BASE);
    expect(zoomedOut / (BASE * 2)).toBeGreaterThan(atBase / BASE);
  });

  it('falls back to a stable 0.50 when no viewBox is available', () => {
    expect(dynamicSnapDist(0, 0)).toBe(0.50);
  });

  it('clamps the zoom ratio so deep zoom-in never explodes the radius', () => {
    const deep = dynamicSnapDist(BASE * 0.01, BASE); // zoom 0.01 → clamped to minZoom
    expect(deep).toBeGreaterThan(0);
    expect(deep).toBeLessThan(atBase);
  });
});

describe('dynamicAngleTolDeg (zoom-aware angle tolerance)', () => {
  const BASE = 1000; // base (fit) viewBox diagonal in world units
  const atBase = dynamicAngleTolDeg(BASE, BASE);        // zoom = 1
  const zoomedIn = dynamicAngleTolDeg(BASE / 4, BASE);  // zoom = 0.25
  const zoomedOut = dynamicAngleTolDeg(BASE * 2, BASE); // zoom = 2

  it('is the classic 2.5° window at base zoom', () => {
    expect(atBase).toBeCloseTo(2.5, 5);
  });

  it('shrinks when zoomed in (less snappy) and grows when zoomed out', () => {
    expect(zoomedIn).toBeLessThan(atBase);
    expect(zoomedOut).toBeGreaterThan(atBase);
  });

  it('clamps so deep zoom-in never drops below the usable floor', () => {
    const deep = dynamicAngleTolDeg(BASE * 0.01, BASE); // zoom 0.01 → clamped to minZoom
    expect(deep).toBeGreaterThanOrEqual(0.6);
    expect(deep).toBeLessThan(atBase);
  });

  it('falls back to the base tolerance when no viewBox is available', () => {
    expect(dynamicAngleTolDeg(0, 0)).toBe(2.5);
  });
});

// Straight ground edge: A=(0,0) → B=(10,0) — used as a bare segment below.
const SEG_ONLY = { points: [], segments: [{ a: { x: 0, z: 0 }, b: { x: 10, z: 0 } }] };

describe('findSnap on-segment (projection) tier of the cascade', () => {
  it('projects a cursor near a segment interior onto the segment', () => {
    const res = findSnap({ x: 4.2, z: 0.3 }, null, SEG_ONLY, opts());
    expect(res.type).toBe(SNAP_TYPES.ON_SEGMENT);
    expect(res.x).toBeCloseTo(4.2, 6);
    expect(res.z).toBeCloseTo(0, 6);
    expect(res.distance).toBeCloseTo(0.3, 6);
  });

  it('endpoint wins over on-segment when both are within snapDist', () => {
    // nearest vertex (10,0) at 0.28; segment projection is nearer but lower priority.
    const geom = { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }], segments: SEG_ONLY.segments };
    const res = findSnap({ x: 10.2, z: 0.2 }, null, geom, opts());
    expect(res.type).toBe(SNAP_TYPES.ENDPOINT);
    expect(res.x).toBeCloseTo(10, 6);
    expect(res.z).toBeCloseTo(0, 6);
  });

  it('falls through to the angle tier when the segment is out of reach', () => {
    // 2 GU off the segment; with no anchor/prev the cascade ends in null.
    expect(findSnap({ x: 5, z: 2 }, null, SEG_ONLY, opts())).toBeNull();
    // With an anchor + prev the angle tier gets its chance instead.
    const res = findSnap({ x: 10, z: 5 }, { x: 10, z: 0 }, SEG_ONLY, opts({ prev: { x: 0, z: 0 } }));
    expect(res.type).toBe(SNAP_TYPES.PERPENDICULAR_90); // turn = +90° from the prev→anchor edge
  });
});

describe('getSnapGuides (render data)', () => {
  it('emits the 180/90/45/135 guide families per segment, anchored at the segment start', () => {
    const guides = getSnapGuides({ x: 0, z: 0 }, SEG_ONLY, null);
    expect(guides).toHaveLength(4);
    expect(guides.map((g) => g.family)).toEqual(['180', '90', '45', '135']);
    expect(guides[0].origin).toEqual({ x: 0, z: 0 });
    expect(guides[0].angleDeg).toBeCloseTo(0, 6);
    expect(guides[1].angleDeg).toBeCloseTo(90, 6);
  });

  it('is empty without an anchor or geometry', () => {
    expect(getSnapGuides(null, SEG_ONLY, null)).toEqual([]);
    expect(getSnapGuides({ x: 0, z: 0 }, null, null)).toEqual([]);
  });
});

describe('getSnappedWorldPos (client → SVG → world boundary)', () => {
  const svgEl = {
    createSVGPoint() {
      return { x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } };
    },
    getScreenCTM() { return { inverse() { return {}; } }; },
  };

  it('negates svg y into world z and runs the snap cascade on the result', () => {
    // client (4.2, -0.3) → svg (4.2, -0.3) → world (4.2, 0.3) → on-segment snap.
    const res = getSnappedWorldPos({ clientX: 4.2, clientY: -0.3 }, svgEl, null, null, SEG_ONLY, opts());
    expect(res.type).toBe(SNAP_TYPES.ON_SEGMENT);
    expect(res.z).toBeCloseTo(0, 6);
    // ...and the endpoint tier through the same conversion (geom with vertices).
    const withPts = { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }], segments: SEG_ONLY.segments };
    const ep = getSnappedWorldPos({ clientX: 10.2, clientY: 0.2 }, svgEl, null, null, withPts, opts());
    expect(ep.type).toBe(SNAP_TYPES.ENDPOINT);
    expect(ep.x).toBeCloseTo(10, 6);
  });

  it('returns null when the SVG element cannot provide a point or CTM', () => {
    expect(getSnappedWorldPos({ clientX: 0, clientY: 0 }, {}, null, null, SEG_ONLY, opts())).toBeNull();
    const noCtm = { createSVGPoint: svgEl.createSVGPoint };
    expect(getSnappedWorldPos({ clientX: 0, clientY: 0 }, noCtm, null, null, SEG_ONLY, opts())).toBeNull();
  });
});

describe('geometry & threshold helpers', () => {
  it('distancePointToLine measures perpendicular distance and falls back to point distance', () => {
    expect(distancePointToLine(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 9);
    expect(distancePointToLine(5, 3, 0, 0, 0, 0)).toBeCloseTo(Math.hypot(5, 3), 9); // degenerate line
  });

  it('closestPointOnSegment clamps the projection to the segment span', () => {
    expect(closestPointOnSegment(5, 2, 0, 0, 10, 0)).toEqual({ x: 5, z: 0, t: 0.5 });
    expect(closestPointOnSegment(-3, 4, 0, 0, 10, 0).t).toBe(0);    // clamped before A
    expect(closestPointOnSegment(15, 4, 0, 0, 10, 0).t).toBe(1);    // clamped after B
    expect(closestPointOnSegment(1, 1, 0, 0, 0, 0)).toEqual({ x: 0, z: 0, t: 0 }); // degenerate
  });

  it('projectPointToLine projects along a direction vector (not a segment)', () => {
    expect(projectPointToLine(5, 7, 0, 0, 1, 0)).toEqual({ x: 5, z: 0 });
    expect(projectPointToLine(5, 7, 0, 0, 0, 0).x).toBeCloseTo(0, 9); // zero direction is tolerated
  });

  it('angle helpers normalize into their documented ranges', () => {
    expect(segmentAngleDeg(0, 0, 10, 0)).toBeCloseTo(0, 9);
    expect(segmentAngleDeg(0, 0, 0, 10)).toBeCloseTo(90, 9);
    expect(normalizeAngle180(-90)).toBe(90);
    expect(normalizeAngle180(270)).toBe(90);
    expect(angleDiffToLine(30, 0)).toBeCloseTo(30, 9);
    expect(angleDiffToLine(150, 0)).toBeCloseTo(30, 9); // folds into [0,90]
  });

  it('worldSnapDist clamps to the fixed world band', () => {
    expect(worldSnapDist(50)).toBeCloseTo(0.6, 9);   // 50*0.012, inside the band
    expect(worldSnapDist(10)).toBe(0.25);            // floor
    expect(worldSnapDist(1000)).toBe(0.80);          // 12 clamps to the ceiling
    expect(worldSnapDist(0)).toBe(0.25);             // zero/NaN diagonal sanitizes to 0 → floor
  });
});
