/**
 * Livery painter — movable snapping (pure math, no DOM).
 *
 * Movables snap to world-space guide LINES while they are moved or scaled:
 *   · another movable's boundary — the edges of its axis-aligned world box
 *   · another movable's mid lines — the box's vertical + horizontal centre lines
 *   · the canvas boundary — the texture / panel edges
 *   · the canvas mid lines — the texture / panel centre lines
 *
 * `collectSnapLines` gathers the vertical (x) and horizontal (y) guide values
 * from every movable except the one being edited, plus the caller-supplied
 * canvas lines. `snapBox` snaps a moving object by any of its three vertical
 * candidates (left edge / centre / right edge) and its three horizontal ones
 * (top / centre / bottom). `snapPoint` snaps a single point — the dragged
 * corner of a scale gesture, which tracks the pointer 1:1 — so a scaled object
 * lands its moving edge exactly on a guide.
 *
 * Everything is pure so the component and tests share the same math.
 */

// The drawn/visible frame of a movable in its own local (translate+rotate)
// coordinates. Mirrors `frameOf` in LiveryCanvas, but inlined so this module
// stays dependency-free (and free of an import cycle).
function frameOf(o) {
  if (o && o.frame) return o.frame;
  const hw = ((o && o.w) || 0) / 2;
  const hh = ((o && o.h) || 0) / 2;
  return { x0: -hw, y0: -hh, x1: hw, y1: hh };
}

// Axis-aligned world bounding box of a movable (works for any rotation), plus
// its centre. `null` for a missing object.
export function objectAABB(o) {
  if (!o) return null;
  const f = frameOf(o);
  const c = Math.cos(o.rot || 0);
  const s = Math.sin(o.rot || 0);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [lx, ly] of [[f.x0, f.y0], [f.x1, f.y0], [f.x1, f.y1], [f.x0, f.y1]]) {
    const wx = o.x + lx * c - ly * s;
    const wy = o.y + lx * s + ly * c;
    if (wx < x0) x0 = wx;
    if (wx > x1) x1 = wx;
    if (wy < y0) y0 = wy;
    if (wy > y1) y1 = wy;
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

// Gather the guide lines: every OTHER movable contributes its box edges + mid
// lines; `baseXs`/`baseYs` carry the canvas boundary + mid lines (the caller
// derives those from the panel layout, so multi-image panels each contribute
// their own edges/centre). Duplicates are harmless — snapping scans them all.
export function collectSnapLines(objects, excludeId, baseXs = [], baseYs = []) {
  const xs = [...baseXs];
  const ys = [...baseYs];
  for (const o of objects || []) {
    if (!o || o.id === excludeId) continue;
    const b = objectAABB(o);
    if (!b) continue;
    xs.push(b.x0, b.cx, b.x1);
    ys.push(b.y0, b.cy, b.y1);
  }
  return { xs, ys };
}

// Nearest guide to a single coordinate, within `threshold`. Returns the signed
// delta to apply and the guide value (for drawing the guide line), or a null
// guide when nothing is close enough.
function nearest(value, lines, threshold) {
  let best = threshold;
  let delta = 0;
  let guide = null;
  for (const t of lines) {
    const d = t - value;
    const ad = Math.abs(d);
    if (ad <= best) { best = ad; delta = d; guide = t; }
  }
  return { delta, guide };
}

// Snap a single point (a dragged scale corner) to the nearest guide on each
// axis. Returns the deltas plus the matched guide values (null = no snap).
export function snapPoint(px, py, lines, threshold) {
  const x = nearest(px, lines.xs, threshold);
  const y = nearest(py, lines.ys, threshold);
  return { dx: x.delta, dy: y.delta, guideX: x.guide, guideY: y.guide };
}

// Snap a moving object's box: try its left edge / centre / right edge against
// every vertical guide, and top / centre / bottom against every horizontal one.
export function snapBox(box, lines, threshold) {
  let bestX = threshold, dx = 0, guideX = null;
  for (const t of lines.xs) {
    for (const c of [box.x0, box.cx, box.x1]) {
      const d = t - c;
      const ad = Math.abs(d);
      if (ad <= bestX) { bestX = ad; dx = d; guideX = t; }
    }
  }
  let bestY = threshold, dy = 0, guideY = null;
  for (const t of lines.ys) {
    for (const c of [box.y0, box.cy, box.y1]) {
      const d = t - c;
      const ad = Math.abs(d);
      if (ad <= bestY) { bestY = ad; dy = d; guideY = t; }
    }
  }
  return { dx, dy, guideX, guideY };
}
