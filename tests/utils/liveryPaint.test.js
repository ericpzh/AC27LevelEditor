import { describe, it, expect } from 'vitest';
import {
  MAX_UNDO,
  createUndoStack,
  pushUndo,
  undoStep,
  redoStep,
  floodFill,
  hexToRgba,
  rgbaToHex,
  hexToRgb,
  rgbToHex,
  rgbToHsv,
  hsvToRgb,
  SELECT_MODES,
  MASK_OPS,
  maskPaintOp,
  lassoBounds,
  wandRegion,
  constrainImageToMask,
  isMaskEmpty,
  traceMaskBorder,
  chainBorderSegments,
} from '../../src/utils/liveryPaint';

function blank(w, h, r = 0, g = 0, b = 0, a = 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return { data, width: w, height: h };
}

describe('undo stack', () => {
  it('caps depth at MAX_UNDO (≥20)', () => {
    expect(MAX_UNDO).toBeGreaterThanOrEqual(20);
    const s = createUndoStack();
    for (let i = 0; i < 25; i++) pushUndo(s, { snap: i });
    expect(s.past).toHaveLength(MAX_UNDO);
    // Oldest dropped: first undo returns snap 24..5 (20 steps).
    let cur = { cur: true };
    for (let i = 0; i < MAX_UNDO; i++) {
      const prev = undoStep(s, cur);
      expect(prev).not.toBeNull();
      cur = prev;
    }
    expect(cur).toEqual({ snap: 5 });
    expect(undoStep(s, cur)).toBeNull();
  });

  it('redo replays undone snapshots', () => {
    const s = createUndoStack();
    pushUndo(s, 'a');
    pushUndo(s, 'b');
    const cur = 'c';
    expect(undoStep(s, cur)).toBe('b');
    expect(redoStep(s, 'b')).toBe('c');
    expect(redoStep(s, 'c')).toBeNull();
  });

  it('a new push clears the redo future', () => {
    const s = createUndoStack();
    pushUndo(s, 'a');
    undoStep(s, 'b');
    pushUndo(s, 'c');
    expect(redoStep(s, 'x')).toBeNull();
  });
});

describe('hexToRgba / rgbaToHex', () => {
  it('converts both directions', () => {
    expect(hexToRgba('#ff0000')).toEqual([255, 0, 0, 255]);
    expect(hexToRgba('#00ff00', 0.5)).toEqual([0, 255, 0, 128]);
    expect(hexToRgba('#abc')).toEqual([170, 187, 204, 255]);
    expect(rgbaToHex(255, 0, 0)).toBe('#ff0000');
  });
});

describe('hex/rgb/hsv colour conversion (RGBA picker)', () => {
  it('hex → rgb handles short, long and malformed input', () => {
    expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('#abc')).toEqual({ r: 170, g: 187, b: 204 });
    expect(hexToRgb('00ff00')).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb('')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb('#zzz')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('rgb → hex pads and clamps', () => {
    expect(rgbToHex({ r: 255, g: 0, b: 0 })).toBe('#ff0000');
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
    expect(rgbToHex({ r: 300, g: -20, b: 127.6 })).toBe('#ff0080');
  });

  it('rgb → hsv covers the primary hues', () => {
    const red = rgbToHsv({ r: 255, g: 0, b: 0 });
    expect(red).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0 }).h).toBe(120);
    expect(rgbToHsv({ r: 0, g: 0, b: 255 }).h).toBe(240);
    // Achromatic colours carry no hue or saturation.
    expect(rgbToHsv({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, v: 128 / 255 });
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
  });

  it('hsv → rgb round-trips the primaries and wraps hue', () => {
    expect(rgbToHex(hsvToRgb({ h: 0, s: 1, v: 1 }))).toBe('#ff0000');
    expect(rgbToHex(hsvToRgb({ h: 120, s: 1, v: 1 }))).toBe('#00ff00');
    expect(rgbToHex(hsvToRgb({ h: 240, s: 1, v: 1 }))).toBe('#0000ff');
    expect(rgbToHex(hsvToRgb({ h: 360, s: 1, v: 1 }))).toBe('#ff0000');
    expect(rgbToHex(hsvToRgb({ h: -120, s: 1, v: 1 }))).toBe('#0000ff');
    expect(rgbToHex(hsvToRgb({ h: 0, s: 0, v: 0 }))).toBe('#000000');
  });

  it('round-trips every primary and secondary hue through hex', () => {
    for (const h of [0, 60, 120, 180, 240, 300]) {
      const hex = rgbToHex(hsvToRgb({ h, s: 1, v: 1 }));
      expect(rgbToHsv(hexToRgb(hex)).h).toBeCloseTo(h, 6);
    }
  });
});

describe('floodFill', () => {
  it('fills a solid region and stops at a border', () => {
    const img = blank(5, 5, 255, 255, 255, 255);
    // Black vertical wall at x=2.
    for (let y = 0; y < 5; y++) {
      const i = (y * 5 + 2) * 4;
      img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0;
    }
    expect(floodFill(img, 0, 0, [255, 0, 0, 255], 0)).toBe(true);
    // Left side red, wall + right side untouched.
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([255, 0, 0]);
    const wall = (0 * 5 + 2) * 4;
    expect([img.data[wall], img.data[wall + 1], img.data[wall + 2]]).toEqual([0, 0, 0]);
    const right = (0 * 5 + 4) * 4;
    expect([img.data[right], img.data[right + 1], img.data[right + 2]]).toEqual([255, 255, 255]);
  });

  it('returns false when filling with the same color', () => {
    const img = blank(3, 3, 10, 20, 30, 255);
    expect(floodFill(img, 1, 1, [10, 20, 30, 255], 32)).toBe(false);
  });

  it('returns false out of bounds', () => {
    const img = blank(3, 3);
    expect(floodFill(img, -1, 0, [1, 2, 3, 255], 0)).toBe(false);
    expect(floodFill(img, 9, 9, [1, 2, 3, 255], 0)).toBe(false);
  });

  it('tolerance bridges near-identical pixels', () => {
    const img = blank(4, 1, 100, 100, 100, 255);
    img.data[4] = 110; img.data[5] = 100; img.data[6] = 100; // x=1 slightly off
    img.data[8] = 200; // x=2 far off — barrier
    expect(floodFill(img, 0, 0, [0, 0, 0, 255], 16)).toBe(true);
    expect(img.data[0]).toBe(0);
    expect(img.data[4]).toBe(0); // within tolerance
    expect(img.data[8]).toBe(200); // barrier untouched
  });
});

describe('selection mask ops', () => {
  it('exposes the three select modes and combine ops', () => {
    expect(SELECT_MODES).toEqual(['object', 'pen', 'wand']);
    expect(MASK_OPS).toEqual(['combine', 'erase', 'replace']);
  });

  it('maskPaintOp maps combine/erase/replace to composite recipes', () => {
    expect(maskPaintOp('combine')).toEqual({ clear: false, composite: 'source-over' });
    expect(maskPaintOp('erase')).toEqual({ clear: false, composite: 'destination-out' });
    expect(maskPaintOp('replace')).toEqual({ clear: true, composite: 'source-over' });
    // Unknown defaults to combine (never erases by accident).
    expect(maskPaintOp('bogus')).toEqual({ clear: false, composite: 'source-over' });
  });

  it('lassoBounds measures the point bbox', () => {
    expect(lassoBounds([])).toBeNull();
    expect(lassoBounds(null)).toBeNull();
    expect(lassoBounds([{ x: 5, y: 5 }])).toEqual({ minX: 5, minY: 5, maxX: 5, maxY: 5 });
    expect(lassoBounds([{ x: 1, y: 9 }, { x: 4, y: 2 }, { x: 2, y: 7 }]))
      .toEqual({ minX: 1, minY: 2, maxX: 4, maxY: 9 });
  });
});

describe('wandRegion', () => {
  it('selects a solid image entirely', () => {
    const r = wandRegion(blank(4, 3, 200, 200, 200, 255), 1, 1, 0);
    expect(r.count).toBe(12);
    expect(r.bounds).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 2 });
    // One span per row (emission order is BFS-dependent — sort first).
    expect(r.spans).toHaveLength(3);
    const rows = r.spans.slice().sort((a, b) => a.y - b.y);
    expect(rows).toEqual([
      { y: 0, x0: 0, x1: 3 },
      { y: 1, x0: 0, x1: 3 },
      { y: 2, x0: 0, x1: 3 },
    ]);
  });

  it('stops at a contrasting wall and never mutates the input', () => {
    const img = blank(5, 5, 255, 255, 255, 255);
    for (let y = 0; y < 5; y++) {
      const i = (y * 5 + 2) * 4;
      img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0;
    }
    const before = img.data.slice();
    const r = wandRegion(img, 0, 0, 0);
    expect(r.count).toBe(10); // two left columns
    expect(r.bounds).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 4 });
    expect(Array.from(img.data)).toEqual(Array.from(before));
  });

  it('tolerance bridges near-identical pixels but not barriers', () => {
    const img = blank(4, 1, 100, 100, 100, 255);
    img.data[4] = 110; // x=1 within tolerance
    img.data[8] = 200; // x=2 barrier
    const r = wandRegion(img, 0, 0, 16);
    expect(r.count).toBe(2);
    expect(r.bounds).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 0 });
  });

  it('returns null for an out-of-bounds seed', () => {
    const img = blank(3, 3);
    expect(wandRegion(img, -1, 0, 0)).toBeNull();
    expect(wandRegion(img, 3, 3, 0)).toBeNull();
  });
});

describe('constrainImageToMask / isMaskEmpty', () => {
  function maskImg(w, h, alphaAt) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const a = alphaAt(i % w, (i / w) | 0);
      data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = a;
    }
    return { data, width: w, height: h };
  }

  it('restores unselected pixels and keeps selected ones', () => {
    const before = blank(3, 1, 10, 20, 30, 255);
    const img = blank(3, 1, 200, 0, 0, 255); // freshly painted red
    const mask = maskImg(3, 1, (x) => (x === 1 ? 255 : 0)); // only middle selected
    expect(constrainImageToMask(img, before, mask)).toBe(true);
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([10, 20, 30]); // restored
    expect([img.data[4], img.data[5], img.data[6]]).toEqual([200, 0, 0]); // kept
    expect([img.data[8], img.data[9], img.data[10]]).toEqual([10, 20, 30]); // restored
  });

  it('treats feathered mask edges (<128) as unselected', () => {
    const before = blank(2, 1, 1, 2, 3, 255);
    const img = blank(2, 1, 9, 9, 9, 255);
    const mask = maskImg(2, 1, (x) => (x === 0 ? 127 : 128));
    expect(constrainImageToMask(img, before, mask)).toBe(true);
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([1, 2, 3]); // 127 restored
    expect([img.data[4], img.data[5], img.data[6]]).toEqual([9, 9, 9]); // 128 kept
  });

  it('returns false when there is nothing to restore', () => {
    const same = blank(2, 1, 5, 5, 5, 255);
    const mask = maskImg(2, 1, () => 0);
    expect(constrainImageToMask(same, blank(2, 1, 5, 5, 5, 255), mask)).toBe(false);
    expect(constrainImageToMask(null, same, mask)).toBe(false);
    expect(constrainImageToMask(same, null, mask)).toBe(false);
    expect(constrainImageToMask(same, same, null)).toBe(false);
  });

  it('isMaskEmpty detects an empty vs live mask', () => {
    expect(isMaskEmpty(maskImg(2, 2, () => 0))).toBe(true);
    expect(isMaskEmpty(maskImg(2, 2, () => 127))).toBe(true); // below threshold
    expect(isMaskEmpty(maskImg(2, 2, (x, y) => (x === 1 && y === 1 ? 255 : 0)))).toBe(false);
    expect(isMaskEmpty(null)).toBe(true);
  });
});

describe('traceMaskBorder / chainBorderSegments', () => {
  function selImg(w, h, sel) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        data[(y * w + x) * 4 + 3] = sel(x, y) ? 255 : 0;
      }
    }
    return { data, width: w, height: h };
  }
  const segKey = (s) => s.join(',');

  it('returns no edges for an empty or unselected mask', () => {
    expect(traceMaskBorder(null)).toEqual([]);
    expect(traceMaskBorder({})).toEqual([]);
    expect(traceMaskBorder(selImg(3, 3, () => false))).toEqual([]);
    expect(traceMaskBorder({ data: new Uint8ClampedArray(4), width: 0, height: 0 })).toEqual([]);
  });

  it('traces the four edges of a lone selected pixel', () => {
    const segs = traceMaskBorder(selImg(3, 3, (x, y) => x === 1 && y === 1));
    expect(segs.map(segKey).sort()).toEqual([
      '1,1,1,2', // left
      '1,1,2,1', // top
      '1,2,2,2', // bottom
      '2,1,2,2', // right
    ].sort());
  });

  it('emits only the outer perimeter when selected pixels are adjacent', () => {
    // A full 2×2 block has 8 perimeter segments and no interior edges.
    const segs = traceMaskBorder(selImg(2, 2, () => true));
    expect(segs).toHaveLength(8);
    expect(segs.map(segKey)).not.toContain('1,0,1,1');
    expect(segs.map(segKey)).not.toContain('0,1,1,1');
  });

  it('chains the segments of a lone pixel into one closed loop', () => {
    const loops = chainBorderSegments(traceMaskBorder(selImg(1, 1, () => true)));
    expect(loops).toHaveLength(1);
    const loop = loops[0];
    expect(loop[0]).toEqual(loop[loop.length - 1]); // closed
    expect(loop).toHaveLength(5); // 4 edges + closing point
  });

  it('chains a 2×2 block into one closed loop of its four corners', () => {
    const segs = traceMaskBorder(selImg(2, 2, () => true));
    const loops = chainBorderSegments(segs);
    expect(loops).toHaveLength(1);
    const pts = loops[0];
    expect(pts[0]).toEqual(pts[pts.length - 1]);
    for (const corner of [[0, 0], [2, 0], [2, 2], [0, 2]]) {
      expect(pts).toContainEqual(corner);
    }
    // Every input segment is consumed exactly once.
    expect(pts.length - 1).toBe(segs.length);
  });

  it('makes one loop per disjoint region', () => {
    const loops = chainBorderSegments(traceMaskBorder(selImg(5, 1, (x) => x === 0 || x === 4)));
    expect(loops).toHaveLength(2);
    expect(loops.every(l => l[0][0] === l[l.length - 1][0] && l[0][1] === l[l.length - 1][1])).toBe(true);
  });

  it('handles empty and open (unclosed) segment lists', () => {
    expect(chainBorderSegments([])).toEqual([]);
    expect(chainBorderSegments(null)).toEqual([]);
    expect(chainBorderSegments([[0, 0, 1, 0]])).toEqual([[[0, 0], [1, 0]]]);
  });
});
