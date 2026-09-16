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
