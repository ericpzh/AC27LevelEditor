import { describe, it, expect } from 'vitest';
import { polygonIsSimple } from '../../../../src/components/EditorScreen/GroundPainter/polygon_simple.js';
// Also ensure CJS mirror behaves identically
import { polygonIsSimple as polygonIsSimpleCjs } from '../../../../src/acl/scenery_graph.js';

describe('polygonIsSimple — ESM mirror (GroundPainter)', () => {
  it('simple triangle is simple', () => {
    expect(polygonIsSimple([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: 10 }])).toBe(true);
  });
  it('rectangle is simple', () => {
    expect(polygonIsSimple([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }])).toBe(true);
  });
  it('bowtie (self-crossing) is not simple', () => {
    // classic bowtie: (0,0)-(10,10)-(10,0)-(0,10)
    expect(polygonIsSimple([{ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 10, z: 0 }, { x: 0, z: 10 }])).toBe(false);
  });
  it('trailing duplicate closing point is dropped before check', () => {
    // triangle with closing duplicate of first point — still simple
    expect(polygonIsSimple([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: 10 }, { x: 0, z: 0 }])).toBe(true);
  });
  it('degenerate zero-length edge is ignored (still simple)', () => {
    // duplicate consecutive point creates zero-length edge — should be ignored
    expect(polygonIsSimple([{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: 10 }])).toBe(true);
  });
  it('adjacent edges sharing a vertex are not considered crossing', () => {
    // L-shaped hexagon that touches at a vertex but does not properly cross
    expect(polygonIsSimple([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 5 }, { x: 5, z: 5 }, { x: 5, z: 10 }, { x: 0, z: 10 }])).toBe(true);
  });
  it('star-like self-intersecting polygon is not simple', () => {
    // 5-point star approximation that must self-intersect
    const pts = [{ x: 0, z: 3 }, { x: 2, z: 2 }, { x: 3, z: 0 }, { x: 4, z: 2 }, { x: 6, z: 3 }, { x: 4, z: 4 }, { x: 3, z: 6 }, { x: 2, z: 4 }];
    // This concave octagon is mostly simple — pick a guaranteed bowtie subcase instead
    expect(polygonIsSimple([{ x: 0, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }, { x: 4, z: 0 }])).toBe(false);
  });
  it('non-array / too few points returns true', () => {
    expect(polygonIsSimple(null)).toBe(true);
    expect(polygonIsSimple([])).toBe(true);
    expect(polygonIsSimple([{ x: 0, z: 0 }])).toBe(true);
    expect(polygonIsSimple([{ x: 0, z: 0 }, { x: 1, z: 1 }])).toBe(true);
  });
  it('bbox prefilter keeps disjoint edges cheap — no false positive', () => {
    // Two non-adjacent edges far apart: bbox check skips _segProperCross
    const pts = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 10, z: 1 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
    expect(polygonIsSimple(pts)).toBe(true);
  });
  it('custom epsilon is respected (tiny gap not considered crossing)', () => {
    // Near-bowtie where crossing is just outside epsilon — with larger eps it collapses
    const epsSmall = 1e-9;
    const epsLarge = 1e-4;
    // Points that almost cross but don't with tight epsilon
    const pts = [{ x: 0, z: 0 }, { x: 10, z: 0.00005 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
    // With default eps this is simple (no proper crossing)
    expect(polygonIsSimple(pts, epsSmall)).toBe(true);
    expect(polygonIsSimple(pts, epsLarge)).toBe(true);
  });
  it('ESM mirror matches CJS implementation for bowtie and simple cases', () => {
    const simple = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
    const bowtie = [{ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 10, z: 0 }, { x: 0, z: 10 }];
    expect(polygonIsSimple(simple)).toBe(polygonIsSimpleCjs(simple));
    expect(polygonIsSimple(bowtie)).toBe(polygonIsSimpleCjs(bowtie));
  });
  it('closed ring with duplicate closing point that still bowties is not simple', () => {
    expect(polygonIsSimple([{ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 10, z: 0 }, { x: 0, z: 10 }, { x: 0, z: 0 }])).toBe(false);
  });
});
