import { describe, it, expect } from 'vitest';
import { objectAABB, collectSnapLines, snapPoint, snapBox } from '../../src/utils/liverySnap';

describe('objectAABB', () => {
  it('boxes an unrotated movable around its frame', () => {
    const o = { id: 1, x: 100, y: 200, w: 100, h: 50 };
    expect(objectAABB(o)).toEqual({ x0: 50, y0: 175, x1: 150, y1: 225, cx: 100, cy: 200 });
  });

  it('uses the part-erase boundary when one is stored', () => {
    const o = { x: 0, y: 0, w: 100, h: 50, frame: { x0: 0, y0: 0, x1: 50, y1: 25 } };
    expect(objectAABB(o)).toEqual({ x0: 0, y0: 0, x1: 50, y1: 25, cx: 25, cy: 12.5 });
  });

  it('grows the box to the rotated corners', () => {
    const o = { x: 0, y: 0, rot: Math.PI / 2, w: 100, h: 50 };
    const b = objectAABB(o);
    // 100×50 rotated 90° → 50×100.
    expect(b.x1 - b.x0).toBeCloseTo(50, 6);
    expect(b.y1 - b.y0).toBeCloseTo(100, 6);
    expect(b.cx).toBeCloseTo(0, 6);
    expect(b.cy).toBeCloseTo(0, 6);
  });

  it('returns null for a missing object', () => {
    expect(objectAABB(null)).toBeNull();
  });
});

describe('collectSnapLines', () => {
  it('adds canvas lines plus every other movable edges + mid lines', () => {
    const a = { id: 1, x: 100, y: 200, w: 100, h: 50 };
    const b = { id: 2, x: 500, y: 600, w: 200, h: 100 };
    const lines = collectSnapLines([a, b], 1, [0, 1024, 2048], [0, 1024, 2048]);
    // Canvas guides present…
    expect(lines.xs).toContain(0);
    expect(lines.xs).toContain(1024);
    // …the other movable's box (edges 400/600, centre 500)…
    expect(lines.xs).toContain(400);
    expect(lines.xs).toContain(500);
    expect(lines.xs).toContain(600);
    expect(lines.ys).toContain(550);
    expect(lines.ys).toContain(600);
    expect(lines.ys).toContain(650);
    // …but not the excluded object's own edges.
    expect(lines.xs).not.toContain(50);
    expect(lines.xs).not.toContain(100);
    expect(lines.xs).not.toContain(150);
  });
});

describe('snapPoint', () => {
  const lines = { xs: [0, 1024, 2048], ys: [0, 1024, 2048] };

  it('snaps each axis independently within the threshold', () => {
    const s = snapPoint(1016, 1030, lines, 20);
    expect(s.dx).toBeCloseTo(8, 6);
    expect(s.dy).toBeCloseTo(-6, 6);
    expect(s.guideX).toBe(1024);
    expect(s.guideY).toBe(1024);
  });

  it('leaves an axis alone when no guide is close', () => {
    const s = snapPoint(1400, 1024, lines, 20);
    expect(s.dx).toBe(0);
    expect(s.guideX).toBeNull();
    expect(s.dy).toBe(0);
    expect(s.guideY).toBe(1024);
  });

  it('does not snap outside the threshold', () => {
    const s = snapPoint(1400, 1500, lines, 20);
    expect(s).toEqual({ dx: 0, dy: 0, guideX: null, guideY: null });
  });
});

describe('snapBox', () => {
  const lines = { xs: [0, 1024, 2048], ys: [0, 1024, 2048] };

  it('snaps any of the three vertical/horizontal candidates', () => {
    // Box centre 1000, left edge 950, right edge 1050 — the right edge is 26
    // from the 1024 midline, so the whole box shifts by +24 to land it there.
    const s = snapBox({ x0: 950, y0: 900, x1: 1050, y1: 1100, cx: 1000, cy: 1000 }, lines, 30);
    expect(s.dx).toBeCloseTo(24, 6);
    expect(s.guideX).toBe(1024);
    // Top edge 900 → 1024 is far; centre 1000 → 1024 is 24 within threshold.
    expect(s.dy).toBeCloseTo(24, 6);
    expect(s.guideY).toBe(1024);
  });

  it('prefers the closest candidate across all edges', () => {
    // Left edge 1010 is 14 from 1024; centre 1060 and right 1110 are further.
    const s = snapBox({ x0: 1010, y0: 0, x1: 1110, y1: 10, cx: 1060, cy: 5 }, lines, 20);
    expect(s.dx).toBeCloseTo(14, 6);
    expect(s.guideX).toBe(1024);
  });

  it('returns no guide when nothing is in range', () => {
    const s = snapBox({ x0: 1400, y0: 1400, x1: 1500, y1: 1500, cx: 1450, cy: 1450 }, lines, 20);
    expect(s).toEqual({ dx: 0, dy: 0, guideX: null, guideY: null });
  });
});
