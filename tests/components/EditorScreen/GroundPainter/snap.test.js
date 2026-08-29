import { describe, it, expect } from 'vitest';
import { findSnap, SNAP_TYPES, collectSnapGeometry, dynamicSnapDist, dynamicAngleTolDeg } from '../../../../src/components/EditorScreen/GroundPainter/snap.js';

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
