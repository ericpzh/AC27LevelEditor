// ─── Painter pure helpers (renderer, no DOM) ───
// Undo stack + flood fill + color utils + selection-mask ops. Canvas-bound
// drawing stays in LiveryCanvas.jsx; everything here is unit-testable
// without a canvas.

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

// ── Colour-space helpers for the custom RGBA picker ────────
// The painter's picker is HSV + alpha (like Photoshop's), because a hue/sat
// square needs HSV. RGB 0-255, HSV with h in [0,360) and s/v in [0,1].

export function hexToRgb(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const full = (h.length === 3 ? h.split('').map(c => c + c).join('') : h).slice(0, 6);
  const n = parseInt(full, 16);
  const v = Number.isFinite(n) ? n : 0;
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

export function rgbToHex(rgb) {
  const p = (v) => Math.max(0, Math.min(255, Math.round(v || 0))).toString(16).padStart(2, '0');
  return `#${p(rgb && rgb.r)}${p(rgb && rgb.g)}${p(rgb && rgb.b)}`;
}

export function rgbToHsv(rgb) {
  const r = ((rgb && rgb.r) || 0) / 255;
  const g = ((rgb && rgb.g) || 0) / 255;
  const b = ((rgb && rgb.b) || 0) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(hsv) {
  const h = (((hsv && hsv.h) || 0) % 360 + 360) % 360;
  const s = Math.max(0, Math.min(1, (hsv && hsv.s) || 0));
  const v = Math.max(0, Math.min(1, (hsv && hsv.v) || 0));
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
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

// ── Selection mask ops ─────────────────────────────────────
// The Select tool's pen (freehand lasso) and wand (tolerance flood) build a
// working selection that clips paints to the selected area. The mask itself
// lives on an offscreen canvas in LiveryCanvas.jsx; the helpers below are the
// pure, canvas-free core: region computation, combine ops and clip math.

// Select-tool sub-modes ('object' is the legacy move/scale/rotate behaviour)
// and the mask combine ops (how a new region applies to the existing mask).
export const SELECT_MODES = ['object', 'pen', 'wand'];
export const MASK_OPS = ['combine', 'erase', 'replace'];

// Canvas composite recipe for painting a region into the mask. 'replace'
// clears the mask first; otherwise 'erase' cuts out, anything else adds.
export function maskPaintOp(mode) {
  if (mode === 'erase') return { clear: false, composite: 'destination-out' };
  return { clear: mode === 'replace', composite: 'source-over' };
}

// Bounding box of a lasso point list ({minX,minY,maxX,maxY}), or null when
// empty. The caller treats a <2px span as a tap (ignored, like curve commits).
export function lassoBounds(pts) {
  if (!pts || pts.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (!p) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

// Magic wand: the contiguous region around (sx, sy) whose pixels match the
// seed within `tolerance` per channel (same similarity rule as floodFill).
// Returns scanline spans ({spans: [{y, x0, x1}…], count, bounds}) so the
// caller can paint the region with fillRect runs — no ImageData needed — or
// null when the seed is outside the image. Never mutates the input.
export function wandRegion(img, sx, sy, tolerance = 32) {
  const { data, width, height } = img;
  sx |= 0; sy |= 0;
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const start = (sy * width + sx) * 4;
  const sr = data[start], sg = data[start + 1], sb = data[start + 2], sa = data[start + 3];
  const same = (i) =>
    Math.abs(data[i] - sr) <= tolerance &&
    Math.abs(data[i + 1] - sg) <= tolerance &&
    Math.abs(data[i + 2] - sb) <= tolerance &&
    Math.abs(data[i + 3] - sa) <= tolerance;

  const visited = new Uint8Array(width * height);
  const stack = [sx, sy];
  const spans = [];
  let count = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const vi = y * width + x;
    if (visited[vi]) continue;
    visited[vi] = 1;
    if (!same(vi * 4)) continue;
    // Expand the horizontal span.
    let x0 = x, x1 = x;
    while (x0 - 1 >= 0 && !visited[y * width + x0 - 1] && same((y * width + x0 - 1) * 4)) { x0--; }
    while (x1 + 1 < width && !visited[y * width + x1 + 1] && same((y * width + x1 + 1) * 4)) { x1++; }
    for (let xx = x0; xx <= x1; xx++) visited[y * width + xx] = 1;
    spans.push({ y, x0, x1 });
    count += x1 - x0 + 1;
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    // Enqueue rows above/below as single seeds (visited[] dedups).
    if (y - 1 >= 0) { for (let xx = x0; xx <= x1; xx++) { stack.push(xx, y - 1); } }
    if (y + 1 < height) { for (let xx = x0; xx <= x1; xx++) { stack.push(xx, y + 1); } }
  }
  if (count === 0) return { spans: [], count: 0, bounds: { minX: sx, minY: sy, maxX: sx, maxY: sy } };
  return { spans, count, bounds: { minX, minY, maxX, maxY } };
}

// Clip a freshly-painted raster to the mask: every pixel the mask leaves
// unselected (alpha < 128) is reverted to the pre-gesture `before` pixels.
// Mutates `img` in place; returns true when at least one pixel was restored
// (so the caller can skip the putImageData when nothing changed).
export function constrainImageToMask(img, before, mask) {
  if (!img || !before || !mask || !img.data || !before.data || !mask.data) return false;
  const d = img.data, b = before.data, m = mask.data;
  const n = Math.min(d.length, b.length, m.length);
  let restored = false;
  for (let i = 0; i + 3 < n; i += 4) {
    if (m[i + 3] < 128) {
      if (d[i] !== b[i] || d[i + 1] !== b[i + 1] || d[i + 2] !== b[i + 2] || d[i + 3] !== b[i + 3]) {
        d[i] = b[i]; d[i + 1] = b[i + 1]; d[i + 2] = b[i + 2]; d[i + 3] = b[i + 3];
        restored = true;
      }
    }
  }
  return restored;
}

// True when no mask pixel reaches the selected threshold — an empty mask
// means "no selection" (paints go everywhere), e.g. after erasing it all.
export function isMaskEmpty(mask) {
  if (!mask || !mask.data) return true;
  const m = mask.data;
  for (let i = 3; i < m.length; i += 4) {
    if (m[i] >= 128) return false;
  }
  return true;
}

// Union perimeter of a selection mask (ImageData-like {data, width, height},
// alpha >= 128 = selected). Returns edge segments [[x1,y1,x2,y2]…] tracing
// the boundary between selected and unselected pixels. Because the segments
// come from the already-unioned pixel mask, interior overlaps between two
// combined regions produce no edges. Pure — exported for tests.
export function traceMaskBorder(img) {
  if (!img || !img.data || !img.width || !img.height) return [];
  const d = img.data;
  const W = img.width | 0;
  const H = img.height | 0;
  if (W <= 0 || H <= 0 || d.length < W * H * 4) return [];
  const segs = [];
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (d[(row + x) * 4 + 3] < 128) continue;
      // Each boundary edge is emitted once, from the selected side only.
      if (x === 0 || d[(row + x - 1) * 4 + 3] < 128) segs.push([x, y, x, y + 1]);
      if (y === 0 || d[((y - 1) * W + x) * 4 + 3] < 128) segs.push([x, y, x + 1, y]);
      if (x === W - 1 || d[(row + x + 1) * 4 + 3] < 128) segs.push([x + 1, y, x + 1, y + 1]);
      if (y === H - 1 || d[((y + 1) * W + x) * 4 + 3] < 128) segs.push([x, y + 1, x + 1, y + 1]);
      // Safety valve: a pathological mask (e.g. noise/checkerboard) could
      // produce millions of segments and freeze the overlay stroke.
      if (segs.length > 100000) return segs;
    }
  }
  return segs;
}

// Chain unit edge segments into continuous loops so a dashed stroke renders
// dotted. A canvas dash restarts on every moveTo — stroking thousands of 1px
// segments one by one restarts the dash per segment (every segment starts
// "on"), which renders as a SOLID line. Each chained loop is one subpath, so
// the dash runs along the loop and renders dotted. Returns loops: arrays of
// [x,y] points ([[x,y]…] per loop, last point may equal the first when the
// loop is closed). Each input segment is used exactly once, so disjoint
// regions become separate loops. Pure — exported for tests.
export function chainBorderSegments(segs) {
  if (!segs || segs.length === 0) return [];
  const key = (x, y) => x + ',' + y;
  const byPoint = new Map();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const k1 = key(s[0], s[1]);
    const k2 = key(s[2], s[3]);
    let a = byPoint.get(k1);
    if (!a) { a = []; byPoint.set(k1, a); }
    a.push(i);
    let b = byPoint.get(k2);
    if (!b) { b = []; byPoint.set(k2, b); }
    b.push(i);
  }
  const used = new Uint8Array(segs.length);
  const loops = [];
  const takeUnusedAt = (x, y) => {
    const cand = byPoint.get(key(x, y));
    if (!cand) return -1;
    for (const ci of cand) {
      if (!used[ci]) return ci;
    }
    return -1;
  };
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const s = segs[i];
    const loop = [[s[0], s[1]], [s[2], s[3]]];
    // Extend forward from the tail.
    let guard = segs.length + 1;
    while (guard-- > 0) {
      const end = loop[loop.length - 1];
      if (end[0] === loop[0][0] && end[1] === loop[0][1] && loop.length > 2) break;
      const nxt = takeUnusedAt(end[0], end[1]);
      if (nxt < 0) break;
      used[nxt] = 1;
      const ns = segs[nxt];
      if (ns[0] === end[0] && ns[1] === end[1]) loop.push([ns[2], ns[3]]);
      else loop.push([ns[0], ns[1]]);
    }
    // Extend backward from the head (covers open chains started mid-way).
    guard = segs.length + 1;
    while (guard-- > 0) {
      const head = loop[0];
      const tail = loop[loop.length - 1];
      if (head[0] === tail[0] && head[1] === tail[1] && loop.length > 2) break;
      const nxt = takeUnusedAt(head[0], head[1]);
      if (nxt < 0) break;
      used[nxt] = 1;
      const ns = segs[nxt];
      if (ns[2] === head[0] && ns[3] === head[1]) loop.unshift([ns[0], ns[1]]);
      else loop.unshift([ns[2], ns[3]]);
    }
    loops.push(loop);
  }
  return loops;
}
