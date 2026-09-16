// ─── Painter pure helpers (renderer, no DOM) ───
// Undo stack + flood fill + color utils. Canvas-bound drawing stays in
// LiveryCanvas.jsx; everything here is unit-testable without a canvas.

export const MAX_UNDO = 20;

export function createUndoStack() {
  return { past: [], future: [] };
}

// Push a snapshot (ImageData) taken BEFORE a mutation. Caps depth at MAX_UNDO.
export function pushUndo(stack, snapshot) {
  stack.past.push(snapshot);
  if (stack.past.length > MAX_UNDO) stack.past.shift();
  stack.future.length = 0;
}

// Returns the snapshot to restore, or null when empty.
export function undoStep(stack, current) {
  if (stack.past.length === 0) return null;
  stack.future.push(current);
  return stack.past.pop();
}

export function redoStep(stack, current) {
  if (stack.future.length === 0) return null;
  stack.past.push(current);
  return stack.future.pop();
}

export function hexToRgba(hex, alpha = 1) {
  const h = String(hex || '#000000').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(alpha * 255)];
}

export function rgbaToHex(r, g, b) {
  const p = (v) => v.toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}

// Scanline flood fill over {data, width, height} (ImageData-like). Mutates in
// place. Returns true when at least one pixel changed.
export function floodFill(img, sx, sy, fill, tolerance = 32) {
  const { data, width, height } = img;
  sx |= 0; sy |= 0;
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return false;
  const start = (sy * width + sx) * 4;
  const sr = data[start], sg = data[start + 1], sb = data[start + 2], sa = data[start + 3];
  const [fr, fg, fb, fa] = fill;
  const same = (i) =>
    Math.abs(data[i] - sr) <= tolerance &&
    Math.abs(data[i + 1] - sg) <= tolerance &&
    Math.abs(data[i + 2] - sb) <= tolerance &&
    Math.abs(data[i + 3] - sa) <= tolerance;
  if (same(start) && sr === fr && sg === fg && sb === fb && sa === fa) return false;

  const visited = new Uint8Array(width * height);
  const stack = [sx, sy];
  let changed = false;
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const vi = y * width + x;
    if (visited[vi]) continue;
    visited[vi] = 1;
    const i = vi * 4;
    if (!same(i)) continue;
    // Expand the horizontal span.
    let x0 = x, x1 = x;
    while (x0 - 1 >= 0 && !visited[y * width + x0 - 1] && same((y * width + x0 - 1) * 4)) { x0--; }
    while (x1 + 1 < width && !visited[y * width + x1 + 1] && same((y * width + x1 + 1) * 4)) { x1++; }
    for (let xx = x0; xx <= x1; xx++) {
      const ii = (y * width + xx) * 4;
      visited[y * width + xx] = 1;
      data[ii] = fr; data[ii + 1] = fg; data[ii + 2] = fb; data[ii + 3] = fa;
      changed = true;
      // enqueue rows above/below as single seeds (visited[] dedups)
      if (y - 1 >= 0) { stack.push(xx, y - 1); }
      if (y + 1 < height) { stack.push(xx, y + 1); }
    }
  }
  return changed;
}
