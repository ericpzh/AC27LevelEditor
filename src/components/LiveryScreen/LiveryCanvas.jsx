import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import {
  createUndoStack,
  pushUndo,
  undoStep,
  redoStep,
  hexToRgba,
  rgbaToHex,
  maskPaintOp,
  lassoBounds,
  wandRegion,
  constrainImageToMask,
  isMaskEmpty,
  traceMaskBorder,
  chainBorderSegments,
} from '../../utils/liveryPaint';
import {
  IoBrushOutline,
  IoEyedropOutline,
  IoColorFillOutline,
  IoColorFill,
  IoRemoveOutline,
  IoSquareOutline,
  IoEllipseOutline,
  IoTextOutline,
  IoArrowUndoOutline,
  IoArrowRedoOutline,
  IoAddOutline,
  IoRemove,
  IoScanOutline,
} from 'react-icons/io5';
import { AiOutlineClear } from 'react-icons/ai';
import { FaEraser, FaRegHandPaper, FaPaintBrush } from 'react-icons/fa';
import { FaArrowPointer, FaAnglesUp, FaAngleUp, FaAngleDown, FaAnglesDown, FaPencil } from 'react-icons/fa6';
import { TbSticker2, TbLayersUnion, TbLayersDifference, TbLayersSelected, TbVectorSpline } from 'react-icons/tb';
import { BsMagic } from 'react-icons/bs';
import { HiDocumentDuplicate } from 'react-icons/hi';
import { MdOutlineLayersClear } from 'react-icons/md';
import { CiBookmarkRemove } from 'react-icons/ci';
import { LuFlipHorizontal, LuFlipVertical, LuLasso } from 'react-icons/lu';
import useTooltip from '../BrowserScreen/useTooltip';
import LiveryColorPicker from './LiveryColorPicker';
import { PANEL_GAP } from '../../utils/constants/livery';

export const TEXTURE = 2048;

// The overlay canvas is padded beyond the backing store so a live object's
// selection box + handles stay visible once the object is dragged off the
// canvas edge — the object's own pixels are clipped to the base bitmap, the
// selection chrome is not.
export const OVERLAY_PAD = 256;

// Opaque fallback base for a new/cleared canvas. The BaseMap replaces the
// model's own texture, so a transparent background would render as holes.
export const DEFAULT_BASE_COLOR = '#ffffff';

// Neutral gutter painted between the panels of a multi-image aircraft so the
// gap reads as "not part of either texture" and is obviously unexported.
export const GAP_FILL = '#2a2f36';

// ── Eraser drag preview ──────────────────────────────────────
// While the eraser pointer is down the trail is only RECORDED and darkened on
// the overlay (50% black), so an event costs one overlay line stroke. The real
// work — restoring the base background and punching holes into every live
// object — runs once on release. Doing it per frame rebuilt/punched/blitted
// each erased object on every overlay frame, which is what made drags stall.
const ERASE_PREVIEW_COLOR = 'rgba(0,0,0,0.5)';
// `strokes` are world/texture-space { size, pts:[{x,y}], drawn }. `onlyNew`
// strokes just the points appended since the last call (incremental preview).
function paintErasePreview(ctx, strokes, onlyNew, ox = 0, oy = 0) {
  if (!ctx || !strokes || strokes.length === 0) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, ox, oy);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ERASE_PREVIEW_COLOR;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const st of strokes) {
    const pts = st.pts || [];
    if (pts.length === 0) continue;
    const from = onlyNew ? (st.drawn || 0) : 0;
    if (onlyNew && pts.length <= from) continue;
    ctx.lineWidth = Math.max(1, st.size || 1);
    ctx.beginPath();
    if (pts.length === 1) {
      // A single recorded point still needs a visible dab.
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[0].x + 0.01, pts[0].y + 0.01);
    } else {
      // Re-anchor one point back so the incremental path stays joined.
      const start = from > 0 ? from - 1 : 0;
      ctx.moveTo(pts[start].x, pts[start].y);
      for (let j = start + 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
    }
    ctx.stroke();
    st.drawn = pts.length;
  }
  ctx.restore();
}

// ── Base painting helpers (shared by mount + Clear) ──────────
// A single-image aircraft paints one 2048² panel; A388/B38M (two built-in
// BaseMaps) paint two side by side with a PANEL_GAP gutter. `panelLayout`
// derives the backing-store size + panel origin for a given panel count.
export function panelLayout(panelCount) {
  const n = Math.max(1, panelCount || 1);
  const gap = n > 1 ? PANEL_GAP : 0;
  return {
    count: n,
    gap,
    width: n * TEXTURE + (n - 1) * gap,
    height: TEXTURE,
    x: (i) => i * (TEXTURE + gap),
  };
}

// Paint the opaque panel backgrounds synchronously: neutral gutter, then a
// white (or fallback) base per panel. Images are painted afterwards so an
// async load never leaves a transparent hole.
export function fillPanelBases(ctx, layout, fallback = DEFAULT_BASE_COLOR) {
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, layout.width, layout.height);
  if (layout.gap) { ctx.fillStyle = GAP_FILL; ctx.fillRect(0, 0, layout.width, layout.height); }
  ctx.fillStyle = fallback;
  for (let i = 0; i < layout.count; i++) ctx.fillRect(layout.x(i), 0, TEXTURE, TEXTURE);
  ctx.restore();
}

function paintBaseImage(ctx, layout, index, dataUrl, onDone) {
  if (!dataUrl) { if (onDone) onDone(); return; }
  const img = new Image();
  img.onload = () => {
    try {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(img, layout.x(index), 0, TEXTURE, TEXTURE);
      ctx.restore();
    } catch (_) {}
    if (onDone) onDone();
  };
  img.onerror = () => { if (onDone) onDone(); };
  img.src = dataUrl;
}

// Paints the base texture: each panel's image when present, else the opaque
// neutral fill. `onDone` fires once every panel's image has landed (async).
function drawBase(ctx, layout, parts, onDone) {
  if (!ctx) { if (onDone) onDone(); return; }
  fillPanelBases(ctx, layout);
  let pending = 0;
  let settled = false;
  const finish = () => { if (settled) return; settled = true; if (onDone) onDone(); };
  for (let i = 0; i < layout.count; i++) {
    const url = parts && parts[i] && parts[i].imageDataUrl;
    if (!url) continue;
    pending++;
    paintBaseImage(ctx, layout, i, url, () => { if (--pending === 0) finish(); });
  }
  if (pending === 0) finish();
}
export { drawBase };

const TOOLS = ['select', 'brush', 'eraser', 'eyedropper', 'fill', 'line', 'rect', 'ellipse', 'text'];

// The Select rail icon advertises both top-level modes it owns — object select
// (mouse) and the magic wand — separated by a slash.
const SelectToolIcon = ({ size = 18 }) => (
  <span className="lp-select-icon" aria-hidden="true">
    <FaArrowPointer size={Math.max(8, size - 7)} />
    <span className="lp-select-icon-sep">/</span>
    <BsMagic size={Math.max(8, size - 7)} />
  </span>
);

// Photoshop-style left-rail tool icons + advertised keyboard shortcuts.
const TOOL_META = {
  select: { Icon: SelectToolIcon, key: 'A' },
  brush: { Icon: IoBrushOutline, key: 'B' },
  eraser: { Icon: FaEraser, key: 'E' },
  eyedropper: { Icon: IoEyedropOutline },
  fill: { Icon: IoColorFillOutline, key: 'G' },
  line: { Icon: IoRemoveOutline, key: 'U' },
  rect: { Icon: IoSquareOutline, key: 'R' },
  ellipse: { Icon: IoEllipseOutline, key: 'M' },
  text: { Icon: IoTextOutline, key: 'T' },
};

// Advertised keyboard shortcuts for the rail ACTION buttons (duplicate / flip /
// delete / undo / redo). Display-only hints for the tooltip; the canvas keydown
// handler is the source of truth.
const ACTION_KEYS = {
  importSticker: 'I', duplicate: 'Ctrl+C', flipH: 'H', flipV: 'V',
  delete: 'Del', undo: 'Ctrl+Z', redo: 'Ctrl+Y',
};
const withKey = (label, key) => (key ? `${label} (${key})` : label);

// Tools that surface a contextual options bar (only eyedropper has none;
// select offers its sub-mode + selection-combine options).
const TOOLS_WITH_OPTIONS = ['select', 'brush', 'eraser', 'fill', 'line', 'rect', 'ellipse', 'text'];

// True only for controls where a bare letter is DATA rather than a shortcut.
// Sliders must not count: the brush/eraser size is a range input, and treating
// every INPUT as text entry swallowed all tool shortcuts once the slider had
// focus (pressing A to get back to Select did nothing). Pure — exported for tests.
export function isTextEntry(el) {
  if (!el) return false;
  const tag = el.tagName || '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  const type = String(el.type || 'text').toLowerCase();
  return type !== 'range' && type !== 'checkbox' && type !== 'radio'
    && type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'color';
}

// Common fonts offered by the Text tool.
const FONT_OPTIONS = [
  'sans-serif', 'serif', 'monospace', 'Arial', 'Helvetica', 'Verdana',
  'Tahoma', 'Georgia', 'Times New Roman', 'Courier New', 'Impact',
  'Comic Sans MS', 'Microsoft YaHei', 'SimHei', 'SimSun', 'KaiTi',
];

// Continuous zoom bounds + multiplicative step (per +/- click and wheel notch).
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 10;
const ZOOM_STEP = 1.25;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const clampZoom = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

// ── Live objects ───────────────────────────────────────────
// Non-destructive, moveable overlay elements flattened onto the texture only
// at export: a sticker image (`kind: 'sticker'`, with `img`), a text box
// (`kind: 'text'`, with `text`/`font`/`size`/…), or a shape (`kind: 'line' |
// 'rect' | 'ellipse' | 'curve'`, with `color`/`width`/`filled`/`opacity`).
// They live in a stack (`objectsRef`) so every object stays selectable
// regardless of what is drawn afterwards; the active one is tracked by `id`
// (`selIdRef`). Shared fields: id, x, y, w, h, rot, flipX, flipY, plus
// `opacity` (sticker/shape/text alpha) and `stretch` (text only: the box's
// per-axis scale relative to the measured glyphs, set by a free resize).
// Shapes are centred on their bounding box; lines use `w` = length, `h` =
// thickness, `rot` = angle; curves keep `pts` (control points relative to the
// centre) and `w`/`h` = their bounding box.
const SHAPE_KINDS = ['line', 'rect', 'ellipse', 'curve'];
const liveFont = (o) => `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${o.size}px ${o.font}`;

// Reorder a live object inside the bottom→top stack. Pure (no refs) so it is
// unit-testable: 'front' moves to the top end, 'forward' swaps one step up,
// 'backward' swaps one step down, 'back' moves to the bottom start.
// Out-of-range ids and no-op moves return the input array untouched.
export function reorderObjects(objs, id, dir) {
  const idx = objs.findIndex(o => o && o.id === id);
  if (idx < 0) return objs;
  if (dir === 'front') {
    if (idx === objs.length - 1) return objs;
    const next = objs.slice();
    const [o] = next.splice(idx, 1);
    next.push(o);
    return next;
  }
  if (dir === 'back') {
    if (idx === 0) return objs;
    const next = objs.slice();
    const [o] = next.splice(idx, 1);
    next.unshift(o);
    return next;
  }
  if (dir === 'forward') {
    if (idx >= objs.length - 1) return objs;
    const next = objs.slice();
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    return next;
  }
  if (dir === 'backward') {
    if (idx <= 0) return objs;
    const next = objs.slice();
    [next[idx], next[idx - 1]] = [next[idx - 1], next[idx]];
    return next;
  }
  return objs;
}

// True when a live object has a drawable/exportable payload.
function hasLiveVisual(o) {
  if (!o) return false;
  if (o.kind === 'text') return Boolean(o.text);
  if (SHAPE_KINDS.includes(o.kind)) return o.w > 0 || o.h > 0;
  return Boolean(o.img);
}

// Select boundary of a live object in its own local (pre-flip) frame. Erasing
// never changes an object's geometry — the primitive/image still draws at w/h —
// so a part-erased object additionally carries `frame`, the local box of what
// is still visible. Select handles, hit testing and the drawn outline all use
// this box, so they hug the remainder instead of the original rectangle.
// Exported for tests.
export function frameOf(o) {
  if (o && o.frame) return o.frame;
  const hw = ((o && o.w) || 0) / 2;
  const hh = ((o && o.h) || 0) / 2;
  return { x0: -hw, y0: -hh, x1: hw, y1: hh };
}

// Scale a (deep) eraser-hole list and a boundary box about the local origin —
// used when resizing, so a part-erased object keeps its shape (half a circle
// stays half a circle) instead of the holes staying put. `ky` defaults to `k`:
// an aspect-locked resize passes one factor, a free stretch passes both axes.
// A hole's brush width is a single number, so it takes the geometric mean of
// the two (the stretched hole is drawn as a circle, its frame exact).
// Exported for tests.
export function scaleErase(k, erase, ky) {
  if (!erase) return undefined;
  const kx = k;
  const ey = ky == null ? kx : ky;
  const ks = Math.sqrt(Math.abs(kx * ey)) || 1;
  return erase.map(s => ({
    size: (s.size || 1) * ks,
    pts: (s.pts || []).map(q => ({ x: q.x * kx, y: q.y * ey })),
  }));
}
export function scaleFrame(k, frame, ky) {
  if (!frame) return undefined;
  const ey = ky == null ? k : ky;
  return { x0: frame.x0 * k, y0: frame.y0 * ey, x1: frame.x1 * k, y1: frame.y1 * ey };
}
// Scale selection-hole polygons (local frame) about the object origin, the same
// way `scaleErase` scales eraser strokes, so a rectangular-selection hole keeps
// its shape when the object is resized. Pure — exported for tests.
export function scaleErasePolys(k, polys, ky) {
  if (!polys) return undefined;
  const kx = k;
  const ey = ky == null ? k : ky;
  return polys.map(loop => (loop || []).map(q => ({ x: q.x * kx, y: q.y * ey })));
}

// Translation applied BEFORE the mirror scale, so a flip pivots on the CENTRE
// OF THE VISIBLE BOUNDARY instead of the object origin. For a whole object the
// two coincide (the frame is centred on the origin) and this is a no-op; for a
// part-erased one the remainder mirrors in place rather than jumping to the
// far side of the geometry. The frame is symmetric about its own centre, so it
// is unchanged by the flip and the boundary keeps matching what is visible.
// Render order must therefore be: translate(o.x,o.y) · rotate · translate(off)
// · scale(sx,sy). Pure — exported for tests.
export function flipOffset(o) {
  const f = frameOf(o);
  const sx = o && o.flipX ? -1 : 1;
  const sy = o && o.flipY ? -1 : 1;
  return {
    x: ((f.x0 + f.x1) / 2) * (1 - sx),
    y: ((f.y0 + f.y1) / 2) * (1 - sy),
  };
}

// Stable id per unique object image, so the eraser cache signature can detect a
// content change without stringifying a (potentially huge) data URL.
const IMAGE_IDS = new WeakMap();
let imageIdSeq = 0;
function imageId(img) {
  if (!img) return 0;
  let id = IMAGE_IDS.get(img);
  if (!id) { id = ++imageIdSeq; IMAGE_IDS.set(img, id); }
  return id;
}
// Signature of everything about an object EXCEPT its erase strokes. When it is
// unchanged the eraser's cached scratch (content + punched holes) is still
// valid and only the points added since the last frame need stroking.
function eraseCacheSig(o) {
  let pts = '';
  if (o.pts && o.pts.length) {
    for (let i = 0; i < o.pts.length; i++) pts += (i ? ';' : '') + o.pts[i].x + ',' + o.pts[i].y;
  }
  let polys = '';
  if (o.erasePolys && o.erasePolys.length) {
    for (const loop of o.erasePolys) {
      polys += '|';
      for (const q of loop || []) polys += q.x + ',' + q.y + ';';
    }
  }
  return [
    o.kind, o.x, o.y, o.rot, o.flipX ? 1 : 0, o.flipY ? 1 : 0, o.w, o.h,
    o.color || '', o.width || '', o.opacity == null ? 1 : o.opacity,
    o.filled ? 1 : 0, o.size || '', o.font || '', o.bold ? 1 : 0, o.italic ? 1 : 0,
    o.text || '', imageId(o.img), pts, polys,
  ].join('|');
}

// CSS `rgba(…)` for a brush `{ color, opacity }`. The rail colour well edits
// RGB + alpha together as one RGBA colour, so every paint path bakes the
// alpha into the style instead of relying on a lone globalAlpha. Pure —
// exported for tests.
export function brushRgba(b) {
  const [r, g, bl] = hexToRgba((b && b.color) || '#000000');
  const a = b && b.opacity != null ? b.opacity : 1;
  return `rgba(${r},${g},${bl},${a})`;
}

// Trace a smooth tangent-continuous path through control points (Catmull-Rom
// converted to Bézier segments). Two points degrade to a straight segment.
// Pure path building — the caller sets stroke/fill styles. Exported for tests.
export function traceSmoothPath(ctx, pts) {
  if (!ctx || !pts || pts.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) { ctx.lineTo(pts[1].x, pts[1].y); return; }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y,
    );
  }
}

// Paint a live object's pixels centred on the origin in the CURRENT frame
// (the caller sets translate/rotate/flip). Split out so the eraser can render
// an object into a tight local scratch (content + holes share one frame)
// without a full-canvas round-trip per object per overlay frame.
function paintLiveObjectContent(ctx, o) {
  if (!ctx || !o) return;
  if (o.kind === 'text') {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
    ctx.fillStyle = o.color || '#000000';
    ctx.font = liveFont(o);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // A free resize stretches the box without touching the font, so the glyphs
    // are scaled to fill the stored w/h (see `stretch`).
    const tx = o.stretch ? o.stretch.sx : 1;
    const ty = o.stretch ? o.stretch.sy : 1;
    if (tx !== 1 || ty !== 1) ctx.scale(tx, ty);
    ctx.fillText(o.text, 0, 0);
  } else if (o.kind === 'curve') {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
    ctx.strokeStyle = o.color || '#000000';
    ctx.lineWidth = o.width || 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    traceSmoothPath(ctx, o.pts || []);
    ctx.stroke();
  } else if (SHAPE_KINDS.includes(o.kind)) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
    ctx.strokeStyle = o.color || '#000000';
    ctx.fillStyle = o.color || '#000000';
    ctx.lineWidth = o.width || 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (o.kind === 'line') { ctx.moveTo(-o.w / 2, 0); ctx.lineTo(o.w / 2, 0); }
    else if (o.kind === 'rect') { ctx.rect(-o.w / 2, -o.h / 2, o.w, o.h); }
    else { ctx.ellipse(0, 0, o.w / 2, o.h / 2, 0, 0, Math.PI * 2); }
    if (o.kind === 'line' || !o.filled) ctx.stroke();
    else { ctx.fill(); ctx.globalAlpha = 1; ctx.stroke(); }
  } else if (o.img) {
    // Sticker alpha (Select-tool Opacity slider). Applied here so the overlay,
    // the export flatten and the duplicate stamp all carry it.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
    ctx.drawImage(o.img, -o.w / 2, -o.h / 2, o.w, o.h);
  }
}

// Paint a live object centred on its own origin (caller positions the frame).
function paintLiveObject(ctx, o) {
  if (!ctx || !o) return;
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(o.rot || 0);
  // Boundary-centre pivot BEFORE the mirror (see flipOffset).
  const f = flipOffset(o);
  if (f.x || f.y) ctx.translate(f.x, f.y);
  ctx.scale(o.flipX ? -1 : 1, o.flipY ? -1 : 1);
  paintLiveObjectContent(ctx, o);
  ctx.restore();
}

// Text box dimensions — real font metrics when the context supports them, a
// linear estimate otherwise (jsdom's context stub has no measureText).
function measureLiveText(ctx, text, o, stretch) {
  let w = 0;
  if (ctx && typeof ctx.measureText === 'function') {
    ctx.save();
    ctx.font = liveFont(o);
    const m = ctx.measureText(text);
    w = m && m.width;
    ctx.restore();
  }
  if (!w || !isFinite(w)) w = Math.max(8, String(text).length * o.size * 0.6);
  const sx = stretch && stretch.sx ? stretch.sx : 1;
  const sy = stretch && stretch.sy ? stretch.sy : 1;
  return { w: w * sx, h: o.size * 1.2 * sy };
}

// Build a live shape object from a drag (a = start, b = current). Rectangles
// and ellipses are centred on their bounding box; a line stores length as `w`,
// thickness as `h` and the angle as `rot`.
function makeShapeObject(kind, a, b, brush, opts) {
  const color = brush.color;
  const opacity = brush.opacity == null ? 1 : brush.opacity;
  const width = Math.max(1, opts.width || 1);
  if (kind === 'line') {
    const dx = b.x - a.x, dy = b.y - a.y;
    return {
      kind: 'line', color, width, opacity, filled: false,
      w: Math.hypot(dx, dy), h: width,
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
      rot: Math.atan2(dy, dx), flipX: false, flipY: false, selected: true,
    };
  }
  return {
    kind, color, width, opacity, filled: !!opts.filled,
    w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
    x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
    rot: 0, flipX: false, flipY: false, selected: true,
  };
}

// World ⇄ local transforms for a live object (translate + rotate + mirror).
// Local coordinates are pre-flip, and the mirror pivots on the visible
// boundary's centre (flipOffset) so a part-erased object flips in place.
// Pure — exported for tests.
export function worldFromLocal(o, q) {
  const sx = o.flipX ? -1 : 1;
  const sy = o.flipY ? -1 : 1;
  const f = flipOffset(o);
  const lx = q.x * sx + f.x;
  const ly = q.y * sy + f.y;
  const c = Math.cos(o.rot || 0);
  const s = Math.sin(o.rot || 0);
  return { x: o.x + lx * c - ly * s, y: o.y + lx * s + ly * c };
}
export function localFromWorld(o, p) {
  const dx = p.x - o.x;
  const dy = p.y - o.y;
  const c = Math.cos(-(o.rot || 0));
  const s = Math.sin(-(o.rot || 0));
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  const f = flipOffset(o);
  return {
    x: (lx - f.x) * (o.flipX ? -1 : 1),
    y: (ly - f.y) * (o.flipY ? -1 : 1),
  };
}

// Pointer in the object's DRAWN local frame: translate + rotate only, with no
// flip folded in — the frame the Select box, handles and hit tests live in.
// Pure — exported for tests.
export function objectLocal(o, p) {
  const dx = p.x - o.x;
  const dy = p.y - o.y;
  const c = Math.cos(-(o.rot || 0));
  const s = Math.sin(-(o.rot || 0));
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

// Per-axis resize factors for a Select corner drag, both measured about the
// object's centre. Held Shift the frame keeps its aspect ratio (one factor for
// both axes — the original behaviour); free, each axis follows the pointer so
// w/h stretch independently. Factors are positive: dragging past the centre
// shrinks to the floor instead of flipping through it. Pure — exported for
// tests.
export function resizeFactors(o, startP, p, shift) {
  if (shift) {
    const startDist = Math.max(1, Math.hypot(startP.x - o.x, startP.y - o.y));
    const k = Math.max(0.02, Math.hypot(p.x - o.x, p.y - o.y) / startDist);
    return { kx: k, ky: k };
  }
  const S = objectLocal(o, startP);
  const L = objectLocal(o, p);
  return {
    kx: Math.max(0.02, Math.abs(S.x) > 0.001 ? Math.abs(L.x / S.x) : 1),
    ky: Math.max(0.02, Math.abs(S.y) > 0.001 ? Math.abs(L.y / S.y) : 1),
  };
}

// Editable vertices of a line/curve object in local coords: the two endpoints
// for a line, the control points for a curve. Pure — exported for tests.
export function objectVertices(o) {
  if (!o) return [];
  if (o.kind === 'line') return [{ x: -o.w / 2, y: 0 }, { x: o.w / 2, y: 0 }];
  if (o.kind === 'curve') return (o.pts || []).map(q => ({ x: q.x, y: q.y }));
  return [];
}

// Build a live curve object from clicked control points (absolute texture
// coords). Points are stored relative to the bounding-box centre so move /
// rotate / flip work through the shared transform; resize scales them.
// Returns null for a degenerate draft (fewer than 2 distinct points or a
// sub-pixel smudge from an accidental double-click). Exported for tests.
export function makeCurveObject(absPts, brush, opts) {
  const pts = [];
  for (const p of absPts || []) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.5) pts.push({ x: p.x, y: p.y });
  }
  if (pts.length < 2) return null;
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX - minX < 2 && maxY - minY < 2) return null;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    kind: 'curve', color: brush.color, width: Math.max(1, opts.width || 1),
    opacity: brush.opacity == null ? 1 : brush.opacity, filled: false,
    pts: pts.map(p => ({ x: p.x - cx, y: p.y - cy })),
    x: cx, y: cy, w: maxX - minX, h: maxY - minY,
    rot: 0, flipX: false, flipY: false, selected: true,
  };
}

/**
 * LiveryCanvas — flat 2048×2048 texture painter (P2).
 * Opaque base (per-aircraft template or a neutral fill), CSS-scaled view,
 * zoom in/out/fit, space-/middle-drag pan, coalesced pointer strokes. Stickers,
 * text and shapes are live, non-destructive moveable objects stacked on the
 * overlay (select / move / scale / rotate) and flattened only on export. Every
 * object stays selectable until it is removed or the canvas is cleared.
 */

// Numeric field with a text draft, so typing never clamps mid-keystroke: blur
// or Enter commits (parsed, rounded, clamped to [min, max]; empty/garbage
// reverts to the live value), Escape discards the draft.
function NumberInput({ value, min, max, onCommit, ariaLabel, suffix }) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(String(value)); }, [value, focused]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft.trim() === '' || !isFinite(n)) { setDraft(String(value)); return; }
    const clamped = Math.max(min, Math.min(max, n));
    setDraft(String(clamped));
    onCommit(clamped);
  };
  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        className="lp-val-input"
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.target.blur();
        // Revert only: no blur here, or the blur commit would re-apply the
        // pre-keydown draft from its stale closure.
        else if (e.key === 'Escape') setDraft(String(value));
      }}
      />
      {suffix && <span className="lp-val-suffix">{suffix}</span>}
    </>
  );
}

const LiveryCanvas = forwardRef(function LiveryCanvas(
  { panels, initialParts, defaultParts, activePanel, onActivePanel, initialImageDataUrl, defaultLiveryDataUrl, onDirty },
  ref,
) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();
  // Panel layout: the aircraft type's built-in BaseMap parts (A388 → Fuselage
  // + Wing, B38M → Fuselage + Wingtip, everything else one panel). The legacy
  // single-image props keep one-panel callers (and tests) working unchanged.
  const panelNames = (Array.isArray(panels) && panels.length)
    ? panels.map(p => (typeof p === 'string' ? p : (p && p.partName) || ''))
    : ['Body'];
  const panelCount = panelNames.length;
  const layout = panelLayout(panelCount);
  const W = layout.width;
  const H = layout.height;
  const active = Math.min(Math.max(0, activePanel | 0), panelCount - 1);
  // Latest active panel, readable SYNCHRONOUSLY by canvas handlers: a left click
  // in another panel both switches the active panel and runs the tool there in
  // ONE event, but the `active` state update is async — handlers use this mirror
  // so the wand / fill / lasso target the panel just clicked, not the previous
  // one. Kept in sync every render (handlers set it before calling onActivePanel).
  const activeRef = useRef(active);
  activeRef.current = active;
  const initialPartsArr = (Array.isArray(initialParts) && initialParts.length)
    ? initialParts
    : [{ partName: panelNames[0], imageDataUrl: initialImageDataUrl || null }];
  const defaultPartsArr = (Array.isArray(defaultParts) && defaultParts.length)
    ? defaultParts
    : [{ partName: panelNames[0], imageDataUrl: defaultLiveryDataUrl || null }];
  const { bind, TooltipPortal } = useTooltip();
  // Layer stack (bottom → top): base aircraft image (locked) → raster fill
  // (`fillCanvasRef`, under every movable) → live movables (`objectCanvasRef`)
  // → raster pen/eraser (`canvasRef`, `ctxRef`) → chrome (`overlayRef`:
  // selection outline, handles, previews, interaction surface). The fill is a
  // background/underlay; the pen always renders above movables while they stay
  // live.
  const baseCanvasRef = useRef(null);
  const baseCtxRef = useRef(null);
  const fillCanvasRef = useRef(null);
  const fillCtxRef = useRef(null);
  const objectCanvasRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const wrapRef = useRef(null);
  const ctxRef = useRef(null);
  // Last captured base-image pixels, shared by undo snapshots so a snapshot
  // never copies the (static) base per step.
  const basePixelsRef = useRef(null);
  const undoRef = useRef(createUndoStack());
  const spaceRef = useRef(false);
  const panRef = useRef(null);
  const handRef = useRef(null);
  const zoomAnchorRef = useRef(null);
  const strokeRef = useRef(null);
  // Last brush/eraser point — the anchor a Shift+click draws a straight line
  // from. Set on every stroke release (a plain click sets it to the click).
  const lineAnchorRef = useRef(null);
  const shapeRef = useRef(null);
  // Curve-line draft (line tool, curve mode): { pts: [{x,y}…] absolute
  // texture coords, hover: {x,y} | null rubber-band end }. Preview only;
  // committed via Enter / double-click / tool switch as a live object.
  const curveRef = useRef(null);
  const dragRef = useRef(null);
  const rafRef = useRef(0);
  // Live objects: a non-destructive stack of moveable overlays (sticker / text
  // / shape). Every object stays selectable until exported; selection is by id.
  const objectsRef = useRef([]);
  const selIdRef = useRef(null);
  const nextIdRef = useRef(1);
  // Id of the text object currently being re-edited inline (null = creating new).
  const editingIdRef = useRef(null);
  const cursorRingRef = useRef(null);
  const toolRef = useRef('brush');
  const brushRef = useRef({ color: '#ff0000', size: 12, opacity: 1, hard: true });
  const shapeOptsRef = useRef({ width: 8, filled: true });
  // Line tool stroke mode: 'straight' (drag) or 'curve' (click points).
  const lineModeRef = useRef('straight');
  const fillTolRef = useRef(32);
  // Select-tool sub-mode: 'object' (move/scale/rotate) vs the selection-mask
  // builders 'pen' (freehand lasso) and 'wand' (tolerance flood).
  const selModeRef = useRef('object');
  // How a new selection region applies to the existing mask (default combine).
  const maskOpRef = useRef('combine');
  // Selection mask: lazily-created 2048² canvas (white-opaque = selected),
  // its dotted-line outlines (array — fallback when mask readback is
  // unavailable, e.g. tests) plus the union perimeter (single merged border
  // traced from the already-unioned mask pixels, so combined regions show one
  // border with no interior overlap),
  // the in-progress lasso ({pts}) and a scratch canvas for masked paints.
  // The mask is a working selection only — never in undo snapshots, the save
  // payload or the export; paints are clipped through it at commit time.
  const maskCanvasRef = useRef(null);
  // Immutable copy of the current selection mask, captured when a movable is
  // created under a selection and stored on the object (`clipMask`) so the shape
  // is stamped into that movable permanently — Ctrl+D / a later selection never
  // un-clips or re-clips it. Invalidated whenever the live mask changes.
  const maskCopyRef = useRef(null);
  const maskOutlineRef = useRef([]);
  const maskBorderRef = useRef([]);
  const lassoRef = useRef(null);
  const scratchRef = useRef(null);
  const wandCanvasRef = useRef(null);
  // 1×1 scratch used by the eyedropper to composite the visible pixel (base
  // raster + live objects) so movables like stickers can be picked.
  const pickCanvasRef = useRef(null);
  // Per-stroke layer for the brush: every dab lands here at FULL opacity and the
  // whole stroke is composited onto the base once per flush with the brush
  // alpha. Drawing each segment straight onto the base with `globalAlpha` makes
  // consecutive round caps overlap (alpha = 1-(1-a)^n), so a 50% brush went
  // nearly opaque on any slow drag — the alpha looked like it did nothing.
  const strokeLayerRef = useRef(null);
  // Pristine pre-stroke base, so re-compositing the dirty rect is idempotent
  // without a putImageData write (which stays reserved for fills/mask clips).
  const strokeBaseRef = useRef(null);
  const strokeBoundsRef = useRef(null);
  // Active eraser gesture: Map object id -> live stroke object in the working
  // copy (ref-local during the gesture; published to state once on release).
  const eraseActiveRef = useRef(null);
  // Recorded eraser trail for the in-progress drag: { strokes: [{ size, pts,
  // drawn }] } in texture space. Painted 50% black on the overlay as a preview;
  // punched out of the paint + into the objects in ONE pass on release.
  const erasePreviewRef = useRef(null);
  // Per-object eraser scratch cache: id -> { canvas, ctx, lx0, ly0, sw, sh,
  // sig, applied }. `applied[i]` is how many points of erase stroke i have
  // already been punched into the canvas.
  const eraseCacheRef = useRef(new Map());
  const hasMaskRef = useRef(false);
  const textOptsRef = useRef({ font: 'sans-serif', size: 120, bold: false, italic: false, color: '#000000' });
  // Clear target — the aircraft type's built-in default livery panels. Kept in
  // refs so the confirm-modal closure reads the latest value even if the
  // template finished loading after the Clear button was clicked.
  const defaultPartsRef = useRef(defaultPartsArr);
  const initialPartsRef = useRef(initialPartsArr);
  useEffect(() => { defaultPartsRef.current = defaultPartsArr; });
  useEffect(() => { initialPartsRef.current = initialPartsArr; });

  const [tool, setToolState] = useState('brush');
  const [brush, setBrushState] = useState(brushRef.current);
  const [shapeOpts, setShapeOptsState] = useState(shapeOptsRef.current);
  const [lineMode, setLineModeState] = useState('straight');
  const [fillTol, setFillTolState] = useState(32);
  const [selMode, setSelModeState] = useState('object');
  const [maskOp, setMaskOpState] = useState('combine');
  const [hasMask, setHasMaskState] = useState(false);
  const [textOpts, setTextOptsState] = useState(textOptsRef.current);
  const [zoom, setZoom] = useState('fit');
  const [fitScale, setFitScale] = useState(0.25);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [objects, setObjectsState] = useState([]);
  const [selId, setSelIdState] = useState(null);
  const [textAnchor, setTextAnchorState] = useState(null);
  const [textDraft, setTextDraftState] = useState('');
  const [dirty, setDirtyState] = useState(false);
  // Right-click layer-order menu anchor: { x, y, id } in client coords, or null.
  const [orderMenu, setOrderMenu] = useState(null);
  // Custom RGBA picker anchor ({ x, y } in client coords) while its popover is
  // open, or null. Positioned in a portal because the tool rail scrolls.
  const [colorAnchor, setColorAnchor] = useState(null);
  const colorSwatchRef = useRef(null);
  // Mirror the text-entry state in refs so commitText() can read the live
  // values from blur / tool-switch / canvas handlers without stale closures.
  const textAnchorRef = useRef(null);
  const textDraftRef = useRef('');
  const orderMenuRef = useRef(null);
  const setOrderMenuTracked = (v) => { orderMenuRef.current = v; setOrderMenu(v); };
  // Set when a right-button press is consumed as an editing gesture (curve
  // node pop / text commit) so the following contextmenu event stays
  // suppressed instead of opening the layer-order menu.
  const consumeRightRef = useRef(false);

  const setTool = (v) => { toolRef.current = v; setToolState(v); };
  const setTextAnchor = (v) => { textAnchorRef.current = v; setTextAnchorState(v); };
  const setTextDraft = (v) => { textDraftRef.current = v; setTextDraftState(v); };
  const setBrush = (v) => { brushRef.current = v; setBrushState(v); };
  const setShapeOpts = (v) => { shapeOptsRef.current = v; setShapeOptsState(v); };
  const setLineMode = (v) => { lineModeRef.current = v; setLineModeState(v); };
  const setTextOpts = (v) => { textOptsRef.current = v; setTextOptsState(v); };
  // Select-mode mirrors (refs so canvas handlers never read stale closures).
  // Leaving the single-select (object) mode drops the selected movable; the
  // pen/wand mask selection is deliberately kept when leaving either of them.
  const setSelMode = (v) => {
    if (v !== 'object' && selModeRef.current === 'object' && selIdRef.current != null) {
      syncObjects(objectsRef.current, null);
    }
    selModeRef.current = v;
    setSelModeState(v);
    scheduleOverlay();
  };
  const setMaskOp = (v) => { maskOpRef.current = v; setMaskOpState(v); };
  const setHasMask = (v) => { hasMaskRef.current = v; setHasMaskState(v); };
  const setFillTol = (v) => { fillTolRef.current = v; setFillTolState(v); };
  // Object layer helpers — refs mirror the state so canvas handlers read the
  // latest objects without stale closures.
  const syncObjects = (objs, sid) => {
    objectsRef.current = objs;
    selIdRef.current = sid;
    setObjectsState(objs);
    setSelIdState(sid);
  };
  const getSelected = () => objectsRef.current.find(o => o.id === selIdRef.current) || null;
  const targetObject = () => getSelected() || objectsRef.current[objectsRef.current.length - 1] || null;
  const addObject = (o) => {
    // A movable ADDED while a selection exists is clipped to that selection for
    // good: the mask is copied onto the object (`clipMask`) at creation, so
    // Ctrl+D / a later selection never un-clips or re-clips it. A movable placed
    // before any selection stays whole.
    const obj = {
      ...o, id: nextIdRef.current++,
      panel: o.panel != null ? o.panel : panelIndexAt(o.x),
      clipMask: hasMaskRef.current ? getMaskCopy() : null,
    };
    syncObjects([...objectsRef.current, obj], obj.id);
    return obj;
  };
  const updateObject = (id, patch) => {
    syncObjects(objectsRef.current.map(o => (o.id === id ? { ...o, ...patch } : o)), id);
  };
  const removeObject = (id) => {
    syncObjects(objectsRef.current.filter(o => o.id !== id), null);
  };
  const setDirty = (v) => {
    setDirtyState(v);
    if (onDirty) onDirty(v);
  };

  const effZoom = zoom === 'fit' ? fitScale : zoom;

  // Topmost live object under a texture point (same hit rule as Select).
  const hitObjectAt = (p) => {
    const z = effZoom || 1;
    const objs = objectsRef.current;
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (!hasLiveVisual(o)) continue;
      const lp = stickerLocal(o, p);
      // Thin strokes (line / curve) get a taller hit band; a near-horizontal
      // curve can have a ~0 bounding height. A part-erased object is picked by
      // its remaining box, so clicks on the erased-away area fall through.
      const fb = frameOf(o);
      const ex = (o.kind === 'line' || o.kind === 'curve')
        ? Math.max(0, 14 / z - (fb.y1 - fb.y0) / 2)
        : 0;
      if (lp.x < fb.x0 || lp.x > fb.x1) continue;
      if (lp.y < fb.y0 - ex || lp.y > fb.y1 + ex) continue;
      return o;
    }
    return null;
  };

  // ── Multi-image panel rendering bounds ─────────────────────
  // For a multi-image aircraft (A388/B38M) the live objects belong to the
  // ACTIVE panel only. Movement is NOT bounded — an object can be dragged off
  // the canvas (even over the other panel) — but the part outside the active
  // panel is overflow and is simply NOT rendered, on the overlay and on export.
  // Single-panel types have no clip: the object's pixels are clipped by the
  // base bitmap and its selection box still shows outside (see OVERLAY_PAD).
  const clipActivePanel = (ctx, idx = active) => {
    if (panelCount <= 1) return;
    const x0 = layout.x(idx);
    ctx.beginPath();
    ctx.rect(x0, 0, TEXTURE, TEXTURE);
    ctx.clip();
  };
  // Which panel a texture x lands in (nearest panel when in the gutter) — a
  // click anywhere in a panel makes it the active one (there is no tab strip).
  const panelIndexAt = (x) => {
    if (panelCount <= 1) return 0;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < panelCount; i++) {
      const x0 = layout.x(i);
      if (x >= x0 && x <= x0 + TEXTURE) return i;
      const d = x < x0 ? x0 - x : Math.max(0, x - (x0 + TEXTURE));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  // Which panel a movable belongs to. The object carries a persisted `panel`
  // chosen while dragging (the pointer position is the source of truth — see
  // `onCanvasMove`), so the panel it was dropped into is also the one it renders
  // and exports in. Objects created without one fall back to the panel their
  // centre is in. Single-panel types are always panel 0.
  const objectPanel = (o) => {
    if (panelCount <= 1) return 0;
    const p = o && o.panel != null ? o.panel : panelIndexAt(o ? o.x : 0);
    return Math.min(Math.max(0, p | 0), panelCount - 1);
  };

  // Move the menu-target (or selected) object one step / to an end.
  const reorderObject = (dir, id) => {
    const targetId = id ?? orderMenuRef.current?.id ?? selIdRef.current;
    if (targetId == null) return;
    const next = reorderObjects(objectsRef.current, targetId, dir);
    if (next === objectsRef.current) return;
    pushSnapshot();
    syncObjects(next, targetId);
    setDirty(true);
    setOrderMenuTracked(null);
    scheduleOverlay();
  };

  // Open the RGBA picker beside the swatch. Measured from the live rect so the
  // popover never lands under the rail (which scrolls and would clip it).
  const openColorPicker = () => {
    const POP_W = 216;
    const POP_H = 268;
    const el = colorSwatchRef.current;
    const r = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
    if (!r) { setColorAnchor({ x: 8, y: 8 }); return; }
    setColorAnchor({
      x: Math.max(8, Math.min(r.right + 8, vw - POP_W - 8)),
      y: Math.max(8, Math.min(r.bottom - POP_H, vh - POP_H - 8)),
    });
  };

  const zoomIn = () => {
    const cur = zoom === 'fit' ? fitScale : zoom;
    setZoom(clampZoom(cur * ZOOM_STEP));
  };
  const zoomOut = () => {
    const cur = zoom === 'fit' ? fitScale : zoom;
    setZoom(clampZoom(cur / ZOOM_STEP));
  };

  // ── Base init (mount only — parent remounts via key on base change) ─
  useEffect(() => {
    const canvas = canvasRef.current; // pen layer (brush/eraser)
    const fillCanvas = fillCanvasRef.current; // fill layer (under movables)
    if (!canvas) return;
    ctxRef.current = canvas.getContext('2d');
    if (fillCanvas) fillCtxRef.current = fillCanvas.getContext('2d');
    const baseCanvas = baseCanvasRef.current;
    const baseCtx = baseCanvas && baseCanvas.getContext('2d');
    baseCtxRef.current = baseCtx;
    const onBaseDone = () => {
      try {
        if (baseCtx) basePixelsRef.current = baseCtx.getImageData(0, 0, W, H);
      } catch (_) { /* stub context */ }
      scheduleOverlay();
    };
    undoRef.current = createUndoStack();
    fillPixelsRef.current = null;
    setDirty(false);
    syncObjects([], null);
    setTextAnchor(null);
    // Both raster layers start transparent; the base image lives on its own.
    for (const c of [ctxRef.current, fillCtxRef.current]) {
      if (!c) continue;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, W, H);
    }
    if (baseCtx) drawBase(baseCtx, layout, initialPartsArr, onBaseDone);
    scheduleOverlay();
    // Mount-only: the parent remounts (key) whenever the base changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fit zoom tracking ──────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth || 512;
      const h = el.clientHeight || 512;
      const fit = Math.min((w - 24) / W, (h - 24) / H);
      setFitScale(Math.max(0.05, Math.min(1, fit)));
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (ro) ro.observe(el);
    return () => { if (ro) ro.disconnect(); };
  }, []);

  // ── Wheel zoom (anchored to the cursor) ────────────────────
  // Record the content point under the cursor, change the zoom, then re-apply
  // the scroll in a layout effect so it uses the already-rendered new size
  // (a rAF could race the DOM update). The point under the cursor stays put.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const cur = zoom === 'fit' ? fitScale : zoom;
      const next = clampZoom(cur * Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY));
      if (Math.abs(next - cur) < 1e-6) return;
      const rect = el.getBoundingClientRect();
      const vx = e.clientX - rect.left;
      const vy = e.clientY - rect.top;
      zoomAnchorRef.current = {
        vx, vy,
        cx: el.scrollLeft + vx,
        cy: el.scrollTop + vy,
        k: next / cur,
      };
      setZoom(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, fitScale]);

  // Keep the cursor's content point fixed once the zoomed size has landed.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const a = zoomAnchorRef.current;
    if (!el || !a) return;
    zoomAnchorRef.current = null;
    el.scrollLeft = a.cx * a.k - a.vx;
    el.scrollTop = a.cy * a.k - a.vy;
  }, [zoom, fitScale]);

  // The fill underlay changes far less often than the pen. Cache its pixels and
  // invalidate the cache on every fill-layer mutation, so a snapshot reuses the
  // SAME ImageData object while the fill is untouched — otherwise every
  // snapshot would carry a second full-store raster (twice the undo memory).
  const fillPixelsRef = useRef(null);
  const invalidateFillPixels = () => { fillPixelsRef.current = null; };
  const captureFillPixels = () => {
    if (fillPixelsRef.current) return fillPixelsRef.current;
    const fillCtx = fillCtxRef.current;
    if (!fillCtx) return null;
    try { fillPixelsRef.current = fillCtx.getImageData(0, 0, W, H); } catch (_) { fillPixelsRef.current = null; }
    return fillPixelsRef.current;
  };

  // A snapshot captures BOTH raster layers (fill underlay + pen) *and* the
  // live-object layer, so undo restores (or removes) objects added since the
  // previous snapshot. The base image is stored by shared reference (it only
  // changes on Clear/import) and so is the fill (cached above), so a snapshot
  // never copies a static layer.
  const snapshotState = () => {
    const ctx = ctxRef.current;
    const fillCtx = fillCtxRef.current;
    if (!ctx && !fillCtx) return null;
    let img = null;
    try { if (ctx) img = ctx.getImageData(0, 0, W, H); } catch (_) {}
    return {
      img,
      fillImg: fillCtx ? captureFillPixels() : null,
      base: basePixelsRef.current,
      objects: objectsRef.current,
      selId: selIdRef.current,
    };
  };
  // Restore the base layer only when the snapshot's base differs from the live
  // one (Clear/import), avoiding a full-canvas putImageData on every undo.
  const restoreBase = (base) => {
    if (!base || base === basePixelsRef.current) return;
    const baseCtx = baseCtxRef.current;
    if (baseCtx) {
      try { baseCtx.putImageData(base, 0, 0); } catch (_) {}
    }
    basePixelsRef.current = base;
  };

  const pushSnapshot = () => {
    const snap = snapshotState();
    if (!snap) return;
    pushUndo(undoRef.current, snap);
    setDirty(true);
  };

  // A direct-manipulation gesture (move / resize / rotate / vertex drag) is one
  // undo step: the first pointermove of the drag pushes the pre-drag snapshot
  // once, so Ctrl+Z reverts the whole transform (scaling included) instead of
  // snapping back to an earlier unrelated edit.
  const ensureDragSnapshot = () => {
    const d = dragRef.current;
    if (d && !d.snapshotted) {
      pushSnapshot();
      d.snapshotted = true;
    }
  };

  // Put a snapshot's raster layers back (both, so undo restores a fill and a
  // pen stroke together), plus the base when it changed.
  const restoreRasters = (snap) => {
    if (!snap) return;
    try { if (ctxRef.current && snap.img) ctxRef.current.putImageData(snap.img, 0, 0); } catch (_) {}
    try {
      if (fillCtxRef.current && snap.fillImg) fillCtxRef.current.putImageData(snap.fillImg, 0, 0);
      // The live fill now equals the snapshot's — cache it by reference.
      fillPixelsRef.current = snap.fillImg || null;
    } catch (_) { fillPixelsRef.current = null; }
  };

  const doUndo = useCallback(() => {
    settleGesture();
    if (!ctxRef.current && !fillCtxRef.current) return;
    const prev = undoStep(undoRef.current, snapshotState());
    if (prev) {
      restoreRasters(prev);
      restoreBase(prev.base);
      syncObjects(prev.objects || [], prev.selId == null ? null : prev.selId);
      setDirty(true);
      scheduleOverlay();
    }
  }, []);

  const doRedo = useCallback(() => {
    settleGesture();
    if (!ctxRef.current && !fillCtxRef.current) return;
    const next = redoStep(undoRef.current, snapshotState());
    if (next) {
      restoreRasters(next);
      restoreBase(next.base);
      syncObjects(next.objects || [], next.selId == null ? null : next.selId);
      setDirty(true);
      scheduleOverlay();
    }
  }, []);

  // ── Selection mask (Select tool: pen / wand sub-modes) ────
  const getMaskCtx = () => {
    if (!maskCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      maskCanvasRef.current = c;
    }
    return maskCanvasRef.current.getContext('2d');
  };
  // Lazily copy the live mask once per mask version; every movable created
  // under that version shares the same immutable clip canvas.
  const getMaskCopy = () => {
    if (maskCopyRef.current) return maskCopyRef.current;
    const mask = maskCanvasRef.current;
    if (!mask) return null;
    try {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const cctx = c.getContext('2d');
      if (!cctx) return null;
      cctx.drawImage(mask, 0, 0);
      maskCopyRef.current = c;
      return c;
    } catch (_) { return null; }
  };
  const getScratch = () => {
    if (!scratchRef.current) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      scratchRef.current = c;
    }
    return scratchRef.current;
  };
  // Dedicated buffer for the wand's visible-colour sample, so it is independent
  // of the shared scratch (which `paintObjectMasked` also uses internally).
  const getWandCanvas = () => {
    if (!wandCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      wandCanvasRef.current = c;
    }
    return wandCanvasRef.current;
  };
  const getPickCanvas = () => {
    if (!pickCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      pickCanvasRef.current = c;
    }
    return pickCanvasRef.current;
  };
  // Drop the whole selection (Deselect button, Clear, erase-to-empty).
  const clearMask = () => {
    if (maskCanvasRef.current) {
      const mctx = maskCanvasRef.current.getContext('2d');
      if (mctx) {
        mctx.save();
        mctx.setTransform(1, 0, 0, 1, 0, 0);
        mctx.clearRect(0, 0, W, H);
        mctx.restore();
      }
    }
    maskOutlineRef.current = [];
    maskBorderRef.current = [];
    maskCopyRef.current = null;
    setHasMask(false);
    scheduleOverlay();
  };
  // Re-trace the single merged selection border from the already-unioned mask
  // pixels. Interior overlaps are solid in the mask, so they emit no edges —
  // the result is one border with no overlap. Segments are chained into
  // continuous loops (one subpath per loop) so the canvas dash renders DOTTED:
  // stroking 1px segments individually restarts the dash per moveTo (all "on")
  // and renders solid. On readback failure (e.g. tests with a stubbed 2d
  // context) the vector-outline fallback is left to draw.
  const rebuildUnionBorder = () => {
    try {
      const mask = maskCanvasRef.current;
      if (!mask) { maskBorderRef.current = []; return; }
      const mctx = mask.getContext('2d');
      if (!mctx || typeof mctx.getImageData !== 'function') return;
      const img = mctx.getImageData(0, 0, W, H);
      if (!img || !img.data) return;
      const segs = traceMaskBorder(img);
      // Empty readback with a live selection means a stubbed context (tests) —
      // keep the vector fallback instead of wiping a good border.
      if (segs.length === 0 && hasMaskRef.current) return;
      maskBorderRef.current = chainBorderSegments(segs);
    } catch (_) { /* keep fallback */ }
  };
  // Paint a closed lasso polygon into the mask under the active combine op.
  // Union (combine) accumulates mask pixels; the visible border is re-traced
  // from the unioned pixels as ONE border (no interior overlap). Replace
  // resets to the new region only; erase cuts pixels and re-traces (no new
  // vector outline). Vector outlines are kept only as a readback-unavailable
  // fallback.
  const applyLassoToMask = (pts) => {
    const mctx = getMaskCtx();
    if (!mctx) return;
    const { clear, composite } = maskPaintOp(maskOpRef.current);
    mctx.save();
    if (clear) { mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.clearRect(0, 0, W, H); }
    // Multi-panel: a lasso is confined to the ACTIVE panel — it can never bleed
    // across the gutter into the neighbouring panel. `activeRef` carries the
    // panel the lasso started in, even when that press also switched panels.
    clipActivePanel(mctx, activeRef.current);
    mctx.globalCompositeOperation = composite;
    mctx.globalAlpha = 1;
    mctx.fillStyle = '#ffffff';
    mctx.beginPath();
    mctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) mctx.lineTo(pts[i].x, pts[i].y);
    mctx.closePath();
    mctx.fill();
    mctx.restore();
    const outline = { kind: 'pen', pts: pts.map(p => ({ x: p.x, y: p.y })), bounds: lassoBounds(pts) };
    if (clear) maskOutlineRef.current = [outline];
    else if (maskOpRef.current !== 'erase') maskOutlineRef.current = [...(maskOutlineRef.current || []), outline];
    maskCopyRef.current = null; // mask changed: next movable captures a fresh copy
    setHasMask(true);
    rebuildUnionBorder();
    scheduleOverlay();
  };
  // Releasing the pen closes the lasso into the mask. Taps and degenerate
  // drags (<2px span, same rule as curve commits) select nothing.
  const commitLasso = (lasso) => {
    const pts = (lasso && lasso.pts) || [];
    const b = lassoBounds(pts);
    if (!b || pts.length < 3 || (b.maxX - b.minX < 2 && b.maxY - b.minY < 2)) { scheduleOverlay(); return; }
    applyLassoToMask(pts);
  };
  // Magic wand: flood the contiguous VISIBLE-colour region under `p` (fill
  // tolerance) into the mask under the active combine op. It samples exactly
  // what the screen shows — invisible geometry never contributes: selection-
  // stamped movables are clipped to their `clipMask`, eraser holes are punched,
  // and the paint layer paints over. Built in a dedicated buffer; the region
  // spans then go through the shared scratch into the mask.
  const applyWandAt = (p) => {
    const mctx = getMaskCtx();
    if (!mctx) return;
    const x = Math.max(0, Math.min(W - 1, p.x | 0));
    const y = Math.max(0, Math.min(H - 1, p.y | 0));
    // Sample ONLY what is visible: base image → fill underlay → movables in
    // their VISIBLE form (a selection-stamped `clipMask` clips them exactly
    // like the screen) → the pen layer on top. Built in its own buffer because
    // `paintObjectForDisplay` internally uses the shared scratch.
    const scene = getWandCanvas();
    const sceneCtx = scene && scene.getContext('2d');
    if (!sceneCtx) return;
    sceneCtx.save();
    sceneCtx.setTransform(1, 0, 0, 1, 0, 0);
    sceneCtx.globalCompositeOperation = 'source-over';
    sceneCtx.globalAlpha = 1;
    sceneCtx.clearRect(0, 0, W, H);
    if (baseCanvasRef.current) sceneCtx.drawImage(baseCanvasRef.current, 0, 0);
    if (fillCanvasRef.current) sceneCtx.drawImage(fillCanvasRef.current, 0, 0);
    for (const o of objectsRef.current) {
      if (hasLiveVisual(o)) paintObjectInPanel(sceneCtx, o);
    }
    if (canvasRef.current) sceneCtx.drawImage(canvasRef.current, 0, 0);
    // Multi-panel: the flood is confined to the ACTIVE panel, so it can never
    // leak across the gutter into the neighbouring panel. `activeRef` carries
    // the panel just clicked, so a click into another panel works on the first
    // press instead of the second.
    const panelRegion = panelCount > 1
      ? { x0: layout.x(activeRef.current), y0: 0, x1: layout.x(activeRef.current) + TEXTURE - 1, y1: H - 1 }
      : null;
    let region = null;
    try { region = wandRegion(sceneCtx.getImageData(0, 0, W, H), x, y, fillTolRef.current, panelRegion); }
    catch (_) { region = null; }
    sceneCtx.restore();
    if (!region || region.count === 0) return;
    // Region spans as white runs in the shared scratch, composited into the mask.
    const sc = getScratch();
    const sctx = sc.getContext('2d');
    if (!sctx) return;
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.fillStyle = '#ffffff';
    sctx.clearRect(0, 0, W, H);
    for (const s of region.spans) sctx.fillRect(s.x0, s.y, s.x1 - s.x0 + 1, 1);
    sctx.restore();
    const { clear, composite } = maskPaintOp(maskOpRef.current);
    mctx.save();
    if (clear) { mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.clearRect(0, 0, W, H); }
    // Confine the region to the active panel (belt-and-braces with the flood
    // bounds above).
    clipActivePanel(mctx, activeRef.current);
    mctx.globalCompositeOperation = composite;
    mctx.globalAlpha = 1;
    mctx.drawImage(sc, 0, 0);
    mctx.restore();
    // Erasing can empty the mask — no pixels left means no selection at all.
    if (maskOpRef.current === 'erase') {
      const m = mctx.getImageData(0, 0, W, H);
      if (isMaskEmpty(m)) { clearMask(); return; }
    }
    const outline = { kind: 'wand', bounds: region.bounds };
    if (clear) maskOutlineRef.current = [outline];
    else if (maskOpRef.current !== 'erase') maskOutlineRef.current = [...(maskOutlineRef.current || []), outline];
    maskCopyRef.current = null; // mask changed: next movable captures a fresh copy
    setHasMask(true);
    rebuildUnionBorder();
    scheduleOverlay();
  };
  // Revert every raster pixel outside the mask to the pre-gesture `before`
  // pixels on ONE layer. A raster selection clips brush, eraser and fill
  // uniformly, each layer against its own pre-gesture image.
  const constrainLayerToMask = (layerCtx, before) => {
    if (!hasMaskRef.current || !before || !layerCtx) return;
    const mask = maskCanvasRef.current;
    if (!mask) return;
    const mctx = mask.getContext('2d');
    if (!mctx) return;
    const cur = layerCtx.getImageData(0, 0, W, H);
    const m = mctx.getImageData(0, 0, W, H);
    if (constrainImageToMask(cur, before, m)) {
      layerCtx.putImageData(cur, 0, 0);
      if (layerCtx === fillCtxRef.current) invalidateFillPixels();
    }
  };
  // Clip BOTH raster layers to the live selection, using the pre-gesture images
  // from the snapshot pushed at gesture start (`pushSnapshot` runs before every
  // raster mutation). Called once at the end of a brush stroke, an eraser
  // gesture, a Shift-click segment or a fill.
  const constrainRastersToMask = () => {
    if (!hasMaskRef.current) return;
    const past = undoRef.current.past;
    const snap = past.length ? past[past.length - 1] : null;
    if (!snap) return;
    constrainLayerToMask(ctxRef.current, snap.img);
    constrainLayerToMask(fillCtxRef.current, snap.fillImg);
  };
  // Paint one live object through `mask` onto `target` (objects layer + export).
  // Used only for movables that carry a stamped `clipMask`; an object placed
  // before any selection has none and is never clipped.
  const paintObjectMasked = (target, o, mask) => {
    const m = mask || maskCanvasRef.current;
    if (!m) { paintObjectWithErase(target, o); return; }
    const sc = getScratch();
    const sctx = sc.getContext('2d');
    if (!sctx) { paintObjectWithErase(target, o); return; }
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.clearRect(0, 0, W, H);
    paintObjectWithErase(sctx, o);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(m, 0, 0);
    sctx.restore();
    target.drawImage(sc, 0, 0);
  };
  // Display/export path for a movable: clip it to its own stamped selection
  // shape (`clipMask`, captured at creation) so it stays partial forever;
  // movables without one show whole.
  const paintObjectForDisplay = (target, o) => {
    if (o && o.clipMask) paintObjectMasked(target, o, o.clipMask);
    else paintObjectWithErase(target, o);
  };
  // Paint a movable clipped to the panel it BELONGS to (`objectPanel`, persisted
  // from the drag). Used everywhere the visible object layer is reproduced —
  // the objects canvas, export, the wand/eyedropper sample — so a movable
  // dragged into another panel shows there and its overflow past the gutter is
  // clipped identically on screen, on export and when sampled.
  const paintObjectInPanel = (target, o) => {
    if (panelCount <= 1) { paintObjectForDisplay(target, o); return; }
    target.save();
    target.beginPath();
    target.rect(layout.x(objectPanel(o)), 0, TEXTURE, TEXTURE);
    target.clip();
    paintObjectForDisplay(target, o);
    target.restore();
  };
  // Paint one live object with its eraser holes punched. The object is rendered
  // into a per-object scratch (content + holes, sized to the object frame — not
  // a full-canvas clear/draw/drawImage) and blitted with the object's world
  // transform. The scratch persists across overlay frames so an erase drag only
  // strokes the points added since the last frame: re-stroking the whole trail
  // every frame was O(n²) and made long drags unusable. It is rebuilt only when
  // the object's content/transform changes or when points disappear (undo).
  // Objects without erase strokes take the fast direct path. Frame/border (w/h)
  // is untouched — an erased object keeps its nodes and moves as before.
  const ERASE_SCRATCH_STEP = 256;
  const paintObjectWithErase = (target, o) => {
    if (!o || ((!o.erase || o.erase.length === 0) && (!o.erasePolys || o.erasePolys.length === 0))) {
      paintLiveObject(target, o);
      return;
    }
    // Tight local rect: the object frame padded by the widest erase brush. The
    // hit test only records points inside frame + brush radius, so this covers
    // every point without folding the whole trail into the bounds each frame.
    const erase = o.erase || [];
    let maxESize = 0;
    for (const stroke of erase) {
      if (stroke && stroke.size > maxESize) maxESize = stroke.size;
    }
    const pad = Math.max(maxESize / 2, (o.width || 0) / 2) + 2;
    const lx0 = -o.w / 2 - pad, ly0 = -o.h / 2 - pad;
    const sw = o.w + pad * 2, sh = o.h + pad * 2;
    if (!(sw > 0 && sh > 0) || sw > W * 2 || sh > H * 2) {
      paintLiveObject(target, o);
      return;
    }
    const cache = eraseCacheRef.current;
    let entry = cache.get(o.id);
    const resized = !entry || entry.lx0 !== lx0 || entry.ly0 !== ly0
      || entry.sw !== sw || entry.sh !== sh;
    // Points may only be appended during a drag; anything else (a content or
    // transform edit, undo restoring fewer points) forces a full rebuild.
    let rebuild = !entry || entry.sig !== eraseCacheSig(o) || resized;
    if (!rebuild) {
      if (erase.length < entry.applied.length) rebuild = true;
      else {
        for (let i = 0; i < entry.applied.length; i++) {
          const pts = (erase[i] && erase[i].pts) || [];
          if (pts.length < entry.applied[i]) { rebuild = true; break; }
        }
      }
    }
    if (rebuild) {
      let c = entry && entry.canvas;
      if (!c) {
        c = document.createElement('canvas');
        c.width = ERASE_SCRATCH_STEP;
        c.height = ERASE_SCRATCH_STEP;
      }
      const needW = Math.max(1, Math.ceil(sw));
      const needH = Math.max(1, Math.ceil(sh));
      if (c.width < needW || c.height < needH) {
        c.width = Math.max(needW, Math.ceil(needW / ERASE_SCRATCH_STEP) * ERASE_SCRATCH_STEP);
        c.height = Math.max(needH, Math.ceil(needH / ERASE_SCRATCH_STEP) * ERASE_SCRATCH_STEP);
      }
      const sctx = c.getContext('2d');
      if (!sctx) { paintLiveObject(target, o); return; }
      sctx.save();
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = 'source-over';
      sctx.globalAlpha = 1;
      sctx.clearRect(0, 0, c.width, c.height);
      sctx.translate(-lx0, -ly0);
      paintLiveObjectContent(sctx, o);
      sctx.restore();
      entry = {
        canvas: c, ctx: sctx, lx0, ly0, sw, sh,
        sig: eraseCacheSig(o), applied: new Array(erase.length).fill(0),
      };
      cache.set(o.id, entry);
    }
    // Punch only the points added since the last frame. Chunked stroking with
    // round caps/joins unions to the same shape as one full-path stroke.
    const sctx = entry.ctx;
    const applied = entry.applied;
    while (applied.length < erase.length) applied.push(0);
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.translate(-entry.lx0, -entry.ly0);
    sctx.globalCompositeOperation = 'destination-out';
    sctx.globalAlpha = 1;
    sctx.lineCap = 'round';
    sctx.lineJoin = 'round';
    sctx.strokeStyle = '#000';
    for (let i = 0; i < erase.length; i++) {
      const stroke = erase[i];
      const pts = (stroke && stroke.pts) || [];
      const from = applied[i] || 0;
      if (pts.length <= from) continue;
      sctx.lineWidth = Math.max(1, stroke.size || 1);
      sctx.beginPath();
      if (from === 0) {
        sctx.moveTo(pts[0].x, pts[0].y);
        for (let j = 1; j < pts.length; j++) sctx.lineTo(pts[j].x, pts[j].y);
        if (pts.length === 1) sctx.lineTo(pts[0].x + 0.01, pts[0].y + 0.01);
      } else {
        // Re-anchor to the last drawn point so the polyline stays joined.
        sctx.moveTo(pts[from - 1].x, pts[from - 1].y);
        for (let j = from; j < pts.length; j++) sctx.lineTo(pts[j].x, pts[j].y);
      }
      sctx.stroke();
      applied[i] = pts.length;
    }
    // Selection-hole polygons (Delete-on-selection): punch every loop as one
    // even-odd path so a ring-shaped selection leaves its middle intact. Idempotent,
    // so it is safe to re-punch on each overlay frame.
    if (o.erasePolys && o.erasePolys.length) {
      sctx.fillStyle = '#000';
      sctx.beginPath();
      for (const loop of o.erasePolys) {
        if (!loop || loop.length < 3) continue;
        sctx.moveTo(loop[0].x, loop[0].y);
        for (let j = 1; j < loop.length; j++) sctx.lineTo(loop[j].x, loop[j].y);
        sctx.closePath();
      }
      sctx.fill('evenodd');
    }
    sctx.restore();
    target.save();
    target.translate(o.x, o.y);
    target.rotate(o.rot || 0);
    const fo = flipOffset(o);
    if (fo.x || fo.y) target.translate(fo.x, fo.y);
    target.scale(o.flipX ? -1 : 1, o.flipY ? -1 : 1);
    // Blit 1:1. The scratch is allocated in 256px steps, so its width/height are
    // usually LARGER than the object frame (sw/sh); passing sw/sh as dw/dh would
    // resample the whole canvas into the frame — shrinking the shape and shifting
    // it (and re-filtering a multi-MP canvas every overlay frame). The content
    // is drawn at the scratch origin, so a plain 1:1 blit at (lx0, ly0) is exact;
    // the unused bottom/right margin is transparent.
    target.drawImage(entry.canvas, entry.lx0, entry.ly0);
    target.restore();
  };
  // Render one object's content into the shared scratch — optionally with its
  // eraser holes punched — and return the local-frame box of the visible
  // pixels. Content is drawn unflipped, the same space the holes are recorded
  // in, so the box is directly comparable to w/h and to the hole points.
  const ERASED_ALPHA_FLOOR = 8;
  const measureObjectPixels = (o, withHoles) => {
    if (!o) return null;
    let maxESize = 0;
    for (const st of o.erase || []) if (st && st.size > maxESize) maxESize = st.size;
    const pad = Math.max(maxESize / 2, (o.width || 0) / 2) + 2;
    const lx0 = -o.w / 2 - pad, ly0 = -o.h / 2 - pad;
    const sw = Math.ceil(o.w + pad * 2), sh = Math.ceil(o.h + pad * 2);
    if (!(sw > 0 && sh > 0) || sw > W || sh > H) return null;
    const sctx = getScratch() && getScratch().getContext('2d');
    if (!sctx || typeof sctx.getImageData !== 'function') return null;
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.clearRect(0, 0, sw, sh);
    sctx.translate(-lx0, -ly0);
    paintLiveObjectContent(sctx, o);
    if (withHoles) {
      sctx.globalCompositeOperation = 'destination-out';
      sctx.globalAlpha = 1;
      sctx.lineCap = 'round';
      sctx.lineJoin = 'round';
      sctx.strokeStyle = '#000';
      for (const st of o.erase || []) {
        const pts = (st && st.pts) || [];
        if (pts.length === 0) continue;
        sctx.lineWidth = Math.max(1, st.size || 1);
        sctx.beginPath();
        sctx.moveTo(pts[0].x, pts[0].y);
        if (pts.length === 1) sctx.lineTo(pts[0].x + 0.01, pts[0].y + 0.01);
        for (let j = 1; j < pts.length; j++) sctx.lineTo(pts[j].x, pts[j].y);
        sctx.stroke();
      }
      if (o.erasePolys && o.erasePolys.length) {
        sctx.fillStyle = '#000';
        sctx.beginPath();
        for (const loop of o.erasePolys) {
          if (!loop || loop.length < 3) continue;
          sctx.moveTo(loop[0].x, loop[0].y);
          for (let j = 1; j < loop.length; j++) sctx.lineTo(loop[j].x, loop[j].y);
          sctx.closePath();
        }
        sctx.fill('evenodd');
      }
    }
    sctx.restore();
    let data;
    try { data = sctx.getImageData(0, 0, sw, sh).data; } catch (_) { return null; }
    if (!data || data.length < sw * sh * 4) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let y = 0; y < sh; y++) {
      const row = y * sw * 4;
      let rowMin = -1, rowMax = -1;
      for (let x = 0; x < sw; x++) {
        if (data[row + x * 4 + 3] > ERASED_ALPHA_FLOOR) {
          if (rowMin < 0) rowMin = x;
          rowMax = x;
        }
      }
      if (rowMin < 0) continue;
      if (rowMin < minX) minX = rowMin;
      if (rowMax > maxX) maxX = rowMax;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX > maxX) return { empty: true, frame: null };
    return {
      empty: false,
      frame: {
        x0: minX + lx0, y0: minY + ly0,
        x1: maxX + 1 + lx0, y1: maxY + 1 + ly0,
      },
    };
  };
  // What is left of an erased object: whether anything is still visible, and
  // the local box it occupies. Renders the object twice (clean, then with holes)
  // so a readback that cannot see the object AT ALL — a stub canvas with no real
  // rasterizer — is detected and ignored rather than reported as "nothing left"
  // (which would delete every object on first touch).
  const measureErasedObject = (o) => {
    const hasHoles = o && ((o.erase && o.erase.length) || (o.erasePolys && o.erasePolys.length));
    if (!hasHoles) return null;
    const clean = measureObjectPixels(o, false);
    if (!clean || clean.empty) return null;
    const left = measureObjectPixels(o, true);
    if (!left) return null;
    return left.empty ? { empty: true, frame: null } : { empty: false, frame: left.frame };
  };
  // True when the eraser (texture point `p`, brush diameter `size`) touches a
  // live object. Bounds are expanded by the brush radius so a wide eraser
  // clears nearby thin strokes; lines/curves keep the taller select hit band.
  const eraserHitsObject = (o, p, size, z) => {
    if (!o || !hasLiveVisual(o)) return false;
    const lp = localFromWorld(o, p);
    const ex = (size || 1) / 2;
    const hitY = (o.kind === 'line' || o.kind === 'curve')
      ? Math.max(o.h / 2, 14 / (z || 1)) + ex
      : o.h / 2 + ex;
    return Math.abs(lp.x) <= o.w / 2 + ex && Math.abs(lp.y) <= hitY;
  };
  // Minimum spacing (texture px) between recorded erase points. Coalesced
  // pointer moves are dense; without decimation a single drag records
  // thousands of points that every overlay frame then re-strokes.
  const ERASE_PT_MIN_DIST = 2;
  // Route one eraser point to every live object under it, appending the point
  // (in each object's local frame) to that object's active gesture stroke.
  // Ref-local during the gesture: NO React state per point (that re-rendered
  // the whole painter per coalesced point). Copy-on-write keeps the pushed
  // undo snapshot intact; the working copy is published once on release.
  // Returns true when a point was actually recorded (so the caller only
  // refreshes the overlay when a live object really changed).
  const erasePointToObjects = (p, size) => {
    const objs = objectsRef.current;
    if (!objs || objs.length === 0) return false;
    const z = effZoom || 1;
    if (!eraseActiveRef.current) eraseActiveRef.current = new Map();
    const active = eraseActiveRef.current;
    let arr = objs;
    let changed = false;
    for (let i = 0; i < arr.length; i++) {
      const o = arr[i];
      if (!eraserHitsObject(o, p, size, z)) continue;
      const lp = localFromWorld(o, p);
      let stroke = active.get(o.id);
      if (stroke) {
        const last = stroke.pts[stroke.pts.length - 1];
        const dx = lp.x - last.x, dy = lp.y - last.y;
        if (dx * dx + dy * dy < ERASE_PT_MIN_DIST * ERASE_PT_MIN_DIST) continue;
        if (stroke.pts.length > 4000) continue;
        stroke.pts.push({ x: lp.x, y: lp.y });
        changed = true;
      } else {
        stroke = { size, pts: [{ x: lp.x, y: lp.y }] };
        // Copy-on-write: the undo snapshot owns the old array/objects.
        const copy = { ...o, erase: [...(o.erase || []), stroke] };
        if (arr === objs) arr = objs.slice();
        arr[i] = copy;
        active.set(o.id, stroke);
        changed = true;
      }
    }
    if (arr !== objs) objectsRef.current = arr;
    return changed;
  };
  // Publish the gesture-local erase work to React state (one render) once the
  // stroke ends or is interrupted (tool switch / shortcut).
  const finalizeEraseGesture = () => {
    if (eraseActiveRef.current && eraseActiveRef.current.size > 0) {
      syncObjects(objectsRef.current, selIdRef.current);
      setDirty(true);
    }
    eraseActiveRef.current = null;
  };
  // Commit a finished eraser drag in ONE pass: punch the recorded trail out
  // of the paint layer, then route that same trail into every live object's
  // holes. The drag itself never touches the paint or the objects — it only
  // draws the dark preview — so this is the only place that does O(area)
  // work, and it runs once per gesture instead of once per frame.
  const applyEraseGesture = () => {
    const prev = erasePreviewRef.current;
    erasePreviewRef.current = null;
    if (!prev || !prev.strokes || prev.strokes.length === 0) return;
    // Punch transparency out of BOTH raster layers — the eraser is not a pen:
    // it only removes. Cutting the top pen layer alone would leave the fill
    // underlay visible, so the same trail is cut from the fill layer too. The
    // locked base is always opaque (`drawBase` fills every panel first), so it
    // shows through exactly where a background-restore would have painted,
    // without ever baking background-coloured pixels.
    {
      for (const target of [ctxRef.current, fillCtxRef.current]) {
        if (!target) continue;
        target.save();
        target.setTransform(1, 0, 0, 1, 0, 0);
        target.globalCompositeOperation = 'destination-out';
        target.globalAlpha = 1;
        target.lineCap = 'round';
        target.lineJoin = 'round';
        target.strokeStyle = '#000';
        for (const st of prev.strokes) {
          const pts = st.pts || [];
          if (pts.length === 0) continue;
          target.lineWidth = Math.max(1, st.size || 1);
          target.beginPath();
          target.moveTo(pts[0].x, pts[0].y);
          if (pts.length === 1) target.lineTo(pts[0].x + 0.01, pts[0].y + 0.01);
          for (let j = 1; j < pts.length; j++) target.lineTo(pts[j].x, pts[j].y);
          target.stroke();
        }
        target.restore();
      }
      invalidateFillPixels();
      // Holes: build each touched object's erase strokes from the same trail.
      eraseActiveRef.current = new Map();
      for (const st of prev.strokes) {
        const pts = st.pts || [];
        for (let j = 0; j < pts.length; j++) erasePointToObjects(pts[j], st.size);
      }
      // An object the eraser consumed entirely is dropped instead of being left
      // as an invisible, still-selectable frame; a part-erased one re-frames its
      // Select boundary to the box of what is left, so the handles hug the
      // remainder (a half circle gets a half-circle boundary, not its old box).
      let arr = objectsRef.current;
      let changed = false;
      for (const id of eraseActiveRef.current.keys()) {
        const idx = arr.findIndex(x => x.id === id);
        if (idx < 0) continue;
        const o = arr[idx];
        const m = measureErasedObject(o);
        if (!m) continue;
        if (m.empty) {
          if (arr === objectsRef.current) arr = arr.slice();
          arr[idx] = null;
          eraseCacheRef.current.delete(id);
          if (selIdRef.current === id) selIdRef.current = null;
          changed = true;
          continue;
        }
        // Only rectangles, ellipses and stickers take the remaining box as their
        // boundary; text keeps its measured text box and lines/curves keep their
        // vertex-driven frames.
        if (!(o.kind === 'rect' || o.kind === 'ellipse' || o.img)) continue;
        const f = m.frame;
        const cur = o.frame;
        if (cur && Math.abs(cur.x0 - f.x0) < 1 && Math.abs(cur.y0 - f.y0) < 1
          && Math.abs(cur.x1 - f.x1) < 1 && Math.abs(cur.y1 - f.y1) < 1) continue;
        if (arr === objectsRef.current) arr = arr.slice();
        arr[idx] = { ...o, frame: f };
        changed = true;
      }
      if (changed) objectsRef.current = arr.filter(Boolean);
    }
    finalizeEraseGesture();
    // Both raster layers are always rewritten, even when no live object was
    // under the trail, so the gesture is always dirty.
    setDirty(true);
  };

  // Delete-with-a-selection: the marquee equivalent of the eraser tool. Cuts
  // the selected region out of BOTH raster layers (transparency, so the locked
  // base shows through naturally) and punches the same region out of every
  // live movable it touches. Returns true when a selection was erased, so
  // Delete can fall back to removing the selected object when there is no
  // selection.
  const eraseSelectionToTransparent = () => {
    const mask = maskCanvasRef.current;
    const mctx = mask && mask.getContext('2d');
    if ((!ctxRef.current && !fillCtxRef.current) || !mask || !mctx || !hasMaskRef.current) return false;
    pushSnapshot();

    // 1) Cut the selected region out of both raster layers (punch
    //    transparency). The pen layer sits ABOVE the live movables, so opaque
    //    pixels there would bury the sticker holes punched below and bake a
    //    fake-background ghost that stays behind when the sticker moves — Del
    //    trims the sticker transparent in its own layer, with the (always
    //    opaque) base showing through. The fill layer is cut too, so a fill
    //    under the selection is removed as well.
    for (const layerCtx of [ctxRef.current, fillCtxRef.current]) {
      if (!layerCtx) continue;
      layerCtx.save();
      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerCtx.globalCompositeOperation = 'destination-out';
      layerCtx.globalAlpha = 1;
      layerCtx.drawImage(mask, 0, 0);
      layerCtx.restore();
    }
    invalidateFillPixels();

    // 2) Punch the selected region out of every live movable it touches. The
    //    mask border is traced to loops and mapped into each object's LOCAL
    //    frame (so the hole moves/scales with the object), stored as
    //    `erasePolys` and filled even-odd so holes inside the selection survive.
    //    A fully-consumed object is dropped; a part-erased rect/ellipse/sticker
    //    re-frames its boundary — exactly like the eraser tool.
    let loops = [];
    let mb = null;
    try {
      const mimg = mctx.getImageData(0, 0, W, H);
      loops = chainBorderSegments(traceMaskBorder(mimg));
      for (const loop of loops) {
        for (const q of loop || []) {
          if (!mb) mb = { x0: q[0], y0: q[1], x1: q[0], y1: q[1] };
          else {
            if (q[0] < mb.x0) mb.x0 = q[0];
            if (q[1] < mb.y0) mb.y0 = q[1];
            if (q[0] > mb.x1) mb.x1 = q[0];
            if (q[1] > mb.y1) mb.y1 = q[1];
          }
        }
      }
    } catch (_) { loops = []; mb = null; }

    let arr = objectsRef.current;
    let changed = false;
    if (loops.length && mb) {
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        if (!hasLiveVisual(o)) continue;
        // Skip objects whose world AABB does not meet the selection bounds.
        const f = frameOf(o);
        const corners = [
          worldFromLocal(o, { x: f.x0, y: f.y0 }),
          worldFromLocal(o, { x: f.x1, y: f.y0 }),
          worldFromLocal(o, { x: f.x0, y: f.y1 }),
          worldFromLocal(o, { x: f.x1, y: f.y1 }),
        ];
        const ox0 = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
        const ox1 = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
        const oy0 = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
        const oy1 = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
        if (ox1 < mb.x0 || ox0 > mb.x1 || oy1 < mb.y0 || oy0 > mb.y1) continue;
        const localLoops = loops.map(loop => (loop || []).map(q => localFromWorld(o, { x: q[0], y: q[1] })));
        let copy = { ...o, erasePolys: [...(o.erasePolys || []), ...localLoops] };
        const m = measureErasedObject(copy);
        if (m && m.empty) {
          if (arr === objectsRef.current) arr = objectsRef.current.slice();
          arr[i] = null;
          eraseCacheRef.current.delete(o.id);
          if (selIdRef.current === o.id) selIdRef.current = null;
        } else {
          if (m && m.frame && (o.kind === 'rect' || o.kind === 'ellipse' || o.img)) {
            copy = { ...copy, frame: m.frame };
          }
          if (arr === objectsRef.current) arr = objectsRef.current.slice();
          arr[i] = copy;
        }
        changed = true;
      }
    }
    if (changed) objectsRef.current = arr.filter(Boolean);
    syncObjects(objectsRef.current, selIdRef.current);
    setDirty(true);
    scheduleOverlay();
    return true;
  };

  // ── Overlay (sticker + shape preview), rAF-throttled ───────
  const drawOverlay = useCallback(() => {
    rafRef.current = 0;
    const z = effZoom || 1;
    const selIdNow = selIdRef.current;
    // Drop eraser caches for objects that no longer exist.
    const eraseCache = eraseCacheRef.current;
    if (eraseCache.size) {
      const live = new Set();
      for (const st of objectsRef.current) live.add(st.id);
      for (const id of [...eraseCache.keys()]) if (!live.has(id)) eraseCache.delete(id);
    }
    // ── Layer 2: movables on their own canvas, BELOW the paint layer. Each
    // renders in the panel its centre falls in (so an unselected movable on
    // another panel is still visible; overflow past its panel is clipped). A
    // movable placed BEFORE any selection previews in full; one ADDED while a
    // selection exists is clipped to that selection's stamped `clipMask`.
    const objCanvas = objectCanvasRef.current;
    if (objCanvas) {
      const octx = objCanvas.getContext('2d');
      if (octx) {
        octx.save();
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.clearRect(0, 0, W, H);
        for (const st of objectsRef.current) {
          if (!hasLiveVisual(st)) continue;
          paintObjectInPanel(octx, st);
        }
        octx.restore();
      }
    }
    // ── Layer 4: chrome (selection box/handles, previews, selection outline)
    // on the padded overlay, which is also the pointer interaction surface.
    const ov = overlayRef.current;
    if (!ov) return;
    const ctx = ov.getContext('2d');
    const OW = W + OVERLAY_PAD * 2;
    const OH = H + OVERLAY_PAD * 2;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, OW, OH);
    ctx.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, OVERLAY_PAD, OVERLAY_PAD);
    const gap = 40 / z;
    const hr = 7 / z;
    // The movable chrome (blue box + rotate/scale handles + vertices) belongs
    // to the single-select (object) sub-mode only — pen/wand show just their
    // selection outline, drawn after every movable so it stays on top.
    for (const st of objectsRef.current) {
      if (!hasLiveVisual(st)) continue;
      const activeSel = st.id === selIdNow && toolRef.current === 'select'
        && selModeRef.current === 'object';
      if (!activeSel) continue;
      ctx.save();
      ctx.translate(st.x, st.y);
      ctx.rotate(st.rot || 0);
      ctx.lineWidth = 2 / z;
      ctx.strokeStyle = '#6aa0ff';
      ctx.setLineDash([]);
      // The boundary hugs what is left after a part-erase (frameOf), so a half
      // circle is boxed as a half circle.
      const fb = frameOf(st);
      const fw = fb.x1 - fb.x0;
      const fh = fb.y1 - fb.y0;
      const fcx = (fb.x0 + fb.x1) / 2;
      ctx.strokeRect(fb.x0, fb.y0, fw, fh);
      // rotate handle (top-centre, on a connector) + resize handle
      // (bottom-right — omitted for lines/curves, whose end vertices own
      // the corner and reshape the stroke instead of scaling the frame)
      ctx.beginPath();
      ctx.moveTo(fcx, fb.y0);
      ctx.lineTo(fcx, fb.y0 - gap);
      ctx.stroke();
      ctx.fillStyle = '#6aa0ff';
      if (st.kind !== 'line' && st.kind !== 'curve') {
        ctx.beginPath(); ctx.arc(fb.x1, fb.y1, hr, 0, Math.PI * 2); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(fcx, fb.y0 - gap, hr, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      // Editable nodes for lines/curves: white dots with a blue ring drawn
      // in world coords (flip applied) so they sit exactly on the stroke.
      if (st.kind === 'line' || st.kind === 'curve') {
        ctx.save();
        ctx.lineWidth = 2 / z;
        ctx.strokeStyle = '#6aa0ff';
        ctx.fillStyle = '#ffffff';
        for (const q of objectVertices(st)) {
          const wpt = worldFromLocal(st, q);
          ctx.beginPath(); ctx.arc(wpt.x, wpt.y, 6 / z, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        ctx.restore();
      }
    }
    const sh = shapeRef.current;
    if (sh && sh.current) {
      ctx.save();
      clipActivePanel(ctx);
      drawShape(ctx, sh.tool, sh.start, sh.current, brushRef.current, shapeOptsRef.current, true);
      ctx.restore();
    }
    // Curve draft: smooth preview through clicked points (+ rubber-band to
    // the cursor) once 2+ points exist, plus a marker dot per clicked point.
    const cd = curveRef.current;
    if (cd && cd.pts.length > 0) {
      const trail = cd.hover ? [...cd.pts, cd.hover] : cd.pts;
      if (trail.length >= 2) {
        const b = brushRef.current;
        const s = shapeOptsRef.current;
        ctx.save();
        clipActivePanel(ctx);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.strokeStyle = brushRgba(b);
        ctx.lineWidth = s.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        traceSmoothPath(ctx, trail);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.fillStyle = '#6aa0ff';
      for (const q of cd.pts) {
        ctx.beginPath(); ctx.arc(q.x, q.y, 6 / z, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    // Multi-image layout: a divider around each panel + a blue outline on the
    // active panel so per-panel import (and where the gap is) is unambiguous.
    if (panelCount > 1) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, OVERLAY_PAD, OVERLAY_PAD);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2 / z;
      for (let i = 0; i < panelCount; i++) ctx.strokeRect(layout.x(i), 0, TEXTURE, TEXTURE);
      ctx.strokeStyle = '#6aa0ff';
      ctx.lineWidth = Math.max(2, 4 / z);
      ctx.strokeRect(layout.x(active) + 1, 1, TEXTURE - 2, H - 2);
      ctx.restore();
    }
    // Re-draw the in-progress eraser preview (full replay). Normally the drag
    // paints it incrementally and never redraws the overlay, but a redraw can
    // still land mid-gesture (e.g. a zoom change) and must not lose it.
    paintErasePreview(ctx, erasePreviewRef.current && erasePreviewRef.current.strokes, false, OVERLAY_PAD, OVERLAY_PAD);
    // Selection mask LAST so the pen/wand region always overdraws every movable
    // and every other overlay layer: ONE merged border traced from the unioned
    // mask pixels (no interior overlap), plus the live lasso draft while the
    // pen is down. Vector outlines draw only when mask readback is unavailable
    // (tests). Overlay only — the base raster is never touched here.
    const drawDashed = (trace) => {
      ctx.save();
      ctx.lineCap = 'round';
      // Marching-ants as tiny, dense round dots: a zero-length dash with a
      // round cap draws one dot per gap. Stroking a slightly wider black pass
      // under a white pass gives every dot a hairline black border.
      ctx.setLineDash([0, 3 / z]);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(1, 2 / z);
      ctx.beginPath();
      trace();
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(0.5, 1 / z);
      ctx.beginPath();
      trace();
      ctx.stroke();
      ctx.restore();
    };
    const outlines = Array.isArray(maskOutlineRef.current)
      ? maskOutlineRef.current
      : (maskOutlineRef.current ? [maskOutlineRef.current] : []);
    const border = maskBorderRef.current;
    if (hasMaskRef.current && border && border.length > 0) {
      const loops = border;
      drawDashed(() => {
        for (let i = 0; i < loops.length; i++) {
          const loop = loops[i];
          if (!loop || loop.length === 0) continue;
          ctx.moveTo(loop[0][0], loop[0][1]);
          for (let j = 1; j < loop.length; j++) ctx.lineTo(loop[j][0], loop[j][1]);
          // Close a returned-to-start loop without adding a zero-length edge.
          const first = loop[0];
          const last = loop[loop.length - 1];
          if (loop.length > 2 && last[0] === first[0] && last[1] === first[1]) ctx.closePath();
        }
      });
    } else if (hasMaskRef.current) {
      for (const mo of outlines) {
        if (mo.kind === 'pen' && mo.pts && mo.pts.length > 0) {
          const pts = mo.pts;
          drawDashed(() => {
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.closePath();
          });
        } else if (mo.bounds) {
          const b = mo.bounds;
          drawDashed(() => { ctx.rect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY); });
        }
      }
    }
    const lz = lassoRef.current;
    if (lz && lz.pts.length > 1) {
      const pts = lz.pts;
      drawDashed(() => {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      });
    }
    ctx.restore();
  }, [effZoom, active, panelCount]);

  function scheduleOverlay() {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(drawOverlay);
  }

  useEffect(() => { scheduleOverlay(); }, [objects, selId, textAnchor, scheduleOverlay]);

  // ── Sticker import (adds a live, moveable object) ──────────
  const importSticker = async () => {
    try {
      const sel = await electronAPI.selectLiveryImage();
      if (!sel || sel.canceled) return;
      const res = await electronAPI.readDiskImage(sel.filePath);
      if (!res || !res.success) {
        useAppStore.getState().showToast(res.error || 'BAD_IMAGE', 'error');
        return;
      }
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        const k = Math.min(1, 1024 / Math.max(w, h));
        pushSnapshot();
        addObject({ kind: 'sticker', img, w: w * k, h: h * k, x: layout.x(active) + TEXTURE / 2, y: TEXTURE / 2, rot: 0, flipX: false, flipY: false });
        // Hand straight back to single-select (A) so the fresh sticker is
        // selected and immediately moveable/scalable, regardless of the
        // selection sub-mode that was active before the import.
        setSelMode('object');
        setTool('select');
        setDirty(true);
        scheduleOverlay();
      };
      img.onerror = () => useAppStore.getState().showToast('BAD_IMAGE', 'error');
      img.src = res.imageDataUrl;
    } catch (err) {
      useAppStore.getState().showToast(err.message, 'error');
    }
  };

  const removeSticker = () => {
    const st = targetObject();
    if (!st) return;
    pushSnapshot();
    removeObject(st.id);
    setDirty(true);
    if (orderMenuRef.current) setOrderMenuTracked(null);
    scheduleOverlay();
  };

  const flipSticker = (axis) => {
    const st = targetObject();
    if (!st) return;
    updateObject(st.id, { [axis]: !st[axis] });
    setDirty(true);
    scheduleOverlay();
  };

  // ── Duplicate: add a nudged copy and keep the original live ─
  // A true copy — the source stays selectable and its pixels are never stamped
  // onto the (wide) base, so a multi-image copy cannot bleed into the other
  // panel. Other live objects are left untouched too.
  const duplicateSticker = () => {
    const st = targetObject();
    if (!st) return;
    pushSnapshot();
    const nudge = Math.max(st.w, st.h) * 0.15 + 20;
    const copy = {
      ...st, id: nextIdRef.current++, x: st.x + nudge, y: st.y + nudge,
      // Under a selection a duplicate is clipped to it; otherwise it inherits
      // the source's clip shape.
      clipMask: hasMaskRef.current ? getMaskCopy() : (st.clipMask || null),
    };
    // Curves own a control-point array — deep-copy it so the two objects can
    // be resized independently. Same for eraser holes.
    if (st.pts) copy.pts = st.pts.map(q => ({ x: q.x, y: q.y }));
    if (st.erase) copy.erase = st.erase.map(s => ({ size: s.size, pts: (s.pts || []).map(q => ({ x: q.x, y: q.y })) }));
    if (st.erasePolys) copy.erasePolys = st.erasePolys.map(loop => (loop || []).map(q => ({ x: q.x, y: q.y })));
    syncObjects([...objectsRef.current, copy], copy.id);
    setTool('select');
    setDirty(true);
    scheduleOverlay();
  };

  // ── Export: base image → fill → movables → pen, flattened ─
  // The layer order must match the on-screen stack (fill under the movables,
  // pen above them).
  const flattenToCanvas = () => {
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.drawImage(baseCanvasRef.current, 0, 0);
    // The fill underlay goes below every movable.
    if (fillCanvasRef.current) ctx.drawImage(fillCanvasRef.current, 0, 0);
    // Live objects are flattened at their actual coordinates, each clipped to
    // the panel it BELONGS to (`objectPanel` — the panel it was dropped into,
    // not the currently-active panel — so export never depends on which panel is
    // active and a movable on another panel is still saved). Overflow into a
    // neighbouring panel is clipped. Only movables with a stamped `clipMask` are
    // clipped to that shape; every other movable flattens in full within its panel.
    for (const o of objectsRef.current) {
      paintObjectInPanel(ctx, o);
    }
    // Pen layer last, so brush/eraser strokes sit above the movables.
    if (canvasRef.current) ctx.drawImage(canvasRef.current, 0, 0);
    return out;
  };
  useImperativeHandle(ref, () => ({
    exportPNG() {
      return flattenToCanvas().toDataURL('image/png');
    },
    // Per-panel exports: one 2048² PNG per part, in panel order. Single-image
    // types yield a one-entry list named after the part (`Body`).
    exportParts() {
      const flat = flattenToCanvas();
      const out = [];
      for (let i = 0; i < panelCount; i++) {
        const c = document.createElement('canvas');
        c.width = TEXTURE; c.height = TEXTURE;
        const cctx = c.getContext('2d');
        if (cctx) cctx.drawImage(flat, layout.x(i), 0, TEXTURE, TEXTURE, 0, 0, TEXTURE, TEXTURE);
        out.push({ partName: panelNames[i], imageDataUrl: c.toDataURL('image/png') });
      }
      return out;
    },
    importSticker,
    removeSticker,
    duplicateSticker,
    reorderObject,
    getObjectCount: () => objectsRef.current.length,
    getObjectIds: () => objectsRef.current.map(o => o.id),
    getSelectedId: () => selIdRef.current,
    getObjectInfo: () => {
      const o = targetObject();
      if (!o) return null;
      return {
        id: o.id, kind: o.kind, x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot || 0,
        flipX: Boolean(o.flipX), flipY: Boolean(o.flipY),
        opacity: o.opacity == null ? 1 : o.opacity,
        size: o.size,
        stretch: o.stretch || null,
        frame: frameOf(o), erase: o.erase || null, erasePolys: o.erasePolys || null,
        clipMask: !!o.clipMask,
        panel: objectPanel(o),
      };
    },
    isDirty: () => dirty,
  }), [dirty, active, panelCount]);

  // ── Keyboard: shortcuts + undo/redo + Del ──────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (isTextEntry(e.target)) {
        if (e.key === 'Escape' && textAnchor) { editingIdRef.current = null; setTextAnchor(null); setTextDraft(''); }
        return;
      }
      // A modal (save naming, overwrite confirm, post-save mod hint, …) owns
      // the keyboard while open: canvas shortcuts must not fire behind it.
      // Without this, Escape/Enter pressed to dismiss a save popup deselected
      // the live movable, and Delete/letter keys could even remove or mutate
      // it — so the selection was lost right after saving.
      try {
        if (useAppStore.getState().modal && useAppStore.getState().modal.open) return;
      } catch (_) {}
      if (e.key === ' ') { spaceRef.current = true; setSpaceHeld(true); e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        // Ctrl+C duplicates the selected (else topmost) object, like the rail's
        // Duplicate Sticker button. preventDefault so the browser copy is muted.
        e.preventDefault();
        duplicateSticker();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        // Ctrl+D = Deselect (same as the Deselect button, then the selected
        // object) — Photoshop's deselect shortcut.
        e.preventDefault();
        if (hasMaskRef.current) clearMask();
        else if (selIdRef.current != null) { syncObjects(objectsRef.current, null); scheduleOverlay(); }
        return;
      }
      if ((e.key === '[' || e.key === ']') && (toolRef.current === 'brush' || toolRef.current === 'eraser')) {
        // [ / ] shrink / grow the brush + eraser size by 5 (slider range 1–200).
        e.preventDefault();
        const delta = e.key === '[' ? -5 : 5;
        const size = Math.max(1, Math.min(200, (brushRef.current.size || 1) + delta));
        setBrush({ ...brushRef.current, size });
        return;
      }
      if (e.key === 'Escape') {
        // A pen lasso in progress is cancelled outright (no region applied).
        if (lassoRef.current) { lassoRef.current = null; scheduleOverlay(); return; }
        if (curveRef.current) {
          cancelCurveDraft();
          if (orderMenuRef.current) setOrderMenuTracked(null);
          return;
        }
        if (orderMenuRef.current) { setOrderMenuTracked(null); return; }
        if (selIdRef.current != null) { syncObjects(objectsRef.current, null); scheduleOverlay(); }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // With a selection mask, Del clears the selected region to the
        // background (the marquee eraser) instead of removing the object.
        if (hasMaskRef.current) { e.preventDefault(); eraseSelectionToTransparent(); return; }
        // Same action as the Remove toolbar button (selection, else topmost).
        removeSticker();
        return;
      }
      if (e.key === 'Enter') {
        // A finished curve draft commits (stays in curve mode for the next one).
        if (curveRef.current && curveRef.current.pts.length >= 2) { commitCurveDraft(); return; }
        // Enter exits the current selection (like committing a text box) instead
        // of re-opening a text editor; the object stays in the stack and can be
        // re-selected, and double-click still re-opens a text box's editor.
        if (selIdRef.current != null) { syncObjects(objectsRef.current, null); scheduleOverlay(); return; }
      }
      const k = e.key.toLowerCase();
      // H / V flip the selected (else topmost) object horizontally / vertically,
      // matching the rail buttons.
      if (k === 'h') { flipSticker('flipX'); return; }
      if (k === 'v') { flipSticker('flipY'); return; }
      // I = Import Sticker (the Eyedropper has no shortcut — right-click picks).
      if (k === 'i') { importSticker(); return; }
      // Select sub-modes are reachable from ANY tool: A=Object, L=Lasso,
      // W=Magic Wand. Pressing one switches to the Select tool first (e.g. from
      // the brush, L jumps straight to Lasso). The Line tool moved to U.
      if (k === 'a' || k === 'l' || k === 'w') {
        if (toolRef.current !== 'select') activateTool('select');
        setSelMode(k === 'a' ? 'object' : (k === 'l' ? 'pen' : 'wand'));
        return;
      }
      const map = { b: 'brush', e: 'eraser', g: 'fill', u: 'line', r: 'rect', m: 'ellipse', o: 'ellipse', t: 'text' };
      if (map[k] && TOOLS.includes(map[k])) { activateTool(map[k]); }
    };
    const onKeyUp = (e) => { if (e.key === ' ') { spaceRef.current = false; setSpaceHeld(false); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  }, [doUndo, doRedo, textAnchor]);

  // ── Coord mapping ──────────────────────────────────────────
  const toTexture = (clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (W / rect.width),
      y: (clientY - rect.top) * (H / rect.height),
    };
  };
  const coalesced = (e) => {
    const n = e.nativeEvent;
    // One layout read per event: a real mouse delivers many coalesced points
    // per move, and calling getBoundingClientRect per point stalled drags.
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = W / rect.width, sy = H / rect.height;
    const map = (cx, cy) => ({ x: (cx - rect.left) * sx, y: (cy - rect.top) * sy });
    // jsdom returns [] here; fall back to the raw event in that case.
    const list = n.getCoalescedEvents ? n.getCoalescedEvents() : null;
    if (list && list.length) {
      const out = new Array(list.length);
      for (let i = 0; i < list.length; i++) out[i] = map(list[i].clientX, list[i].clientY);
      return out;
    }
    return [map(n.clientX, n.clientY)];
  };

  // ── Per-stroke layer (uniform brush alpha) ─────────────────
  // Clear the stroke layer and keep the region it touches, so one compositing
  // pass per flush reproduces "one stroke at N% opacity" instead of N
  // overlapping dabs each at N%.
  const getStrokeCanvas = (ref) => {
    if (!ref.current) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      ref.current = c;
    }
    return ref.current;
  };
  const beginStroke = () => {
    strokeBoundsRef.current = null;
    const layer = getStrokeCanvas(strokeLayerRef);
    const base = getStrokeCanvas(strokeBaseRef);
    const lctx = layer.getContext('2d');
    const bctx = base.getContext('2d');
    if (!lctx || !bctx) return null;
    lctx.save();
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    lctx.globalAlpha = 1;
    lctx.clearRect(0, 0, W, H);
    lctx.restore();
    bctx.save();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.globalCompositeOperation = 'source-over';
    bctx.globalAlpha = 1;
    bctx.clearRect(0, 0, W, H);
    bctx.drawImage(canvasRef.current, 0, 0);
    bctx.restore();
    return lctx;
  };
  // Grow the dirty rect by the brush radius (plus shadow spread for soft
  // brushes) so the flush covers every pixel a dab can reach.
  const growStrokeBounds = (from, toPt) => {
    const pad = brushRef.current.size + 6;
    const b = strokeBoundsRef.current;
    const x0 = Math.max(0, Math.floor(Math.min(from.x, toPt.x) - pad));
    const y0 = Math.max(0, Math.floor(Math.min(from.y, toPt.y) - pad));
    const x1 = Math.min(W, Math.ceil(Math.max(from.x, toPt.x) + pad));
    const y1 = Math.min(H, Math.ceil(Math.max(from.y, toPt.y) + pad));
    strokeBoundsRef.current = b
      ? { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, y0), x1: Math.max(b.x1, x1), y1: Math.max(b.y1, y1) }
      : { x0, y0, x1, y1 };
  };
  // Deposit ONE brush dab at `p` on the stroke layer. A zero-length round-cap
  // segment paints a dot, which is what a click without any pointermove would
  // otherwise miss — so the click that switches the active panel also paints on
  // the panel it lands in (no second click needed).
  const paintBrushDab = (target, p) => {
    const b = brushRef.current;
    target.save();
    target.globalCompositeOperation = 'source-over';
    target.globalAlpha = 1;
    target.lineWidth = b.size;
    target.lineCap = 'round';
    target.lineJoin = 'round';
    target.strokeStyle = b.color;
    if (!b.hard) { target.shadowColor = b.color; target.shadowBlur = b.size / 2; }
    target.beginPath();
    target.moveTo(p.x, p.y);
    target.lineTo(p.x, p.y);
    target.stroke();
    target.restore();
    growStrokeBounds(p, p);
  };
  // Composite the stroke layer over the pristine pre-stroke base inside the
  // dirty rect, then apply the brush alpha to the layer. Every flush is
  // idempotent per rect (the base copy is never modified), so re-covering an
  // already-flushed area is harmless — no alpha pile-up at the seams.
  const flushStroke = () => {
    const ctx = ctxRef.current;
    const layer = strokeLayerRef.current;
    const base = strokeBaseRef.current;
    const bnd = strokeBoundsRef.current;
    if (!ctx || !layer || !base || !bnd) return;
    const x = bnd.x0, y = bnd.y0;
    const w = Math.max(1, bnd.x1 - x), h = Math.max(1, bnd.y1 - y);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(x, y, w, h);
    ctx.drawImage(base, x, y, w, h, x, y, w, h);
    ctx.globalAlpha = brushRef.current.opacity == null ? 1 : brushRef.current.opacity;
    ctx.drawImage(layer, x, y, w, h, x, y, w, h);
    ctx.restore();
  };
  const endStroke = () => {
    strokeLayerRef.current = null;
    strokeBaseRef.current = null;
    strokeBoundsRef.current = null;
  };

  // ── Shift-click straight segments (brush / eraser) ─────────
  // A plain click drops an anchor; each Shift+click paints a straight segment
  // from the previous anchor to the clicked point and moves the anchor there,
  // so repeated Shift+clicks chain a polyline. Each segment is one undo step.
  const drawBrushSegment = (from, to) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const b = brushRef.current;
    // Draw through the per-stroke layer so the segment composites at the brush
    // alpha in one pass, exactly like a freehand stroke.
    const layer = beginStroke() || ctx;
    layer.save();
    layer.globalCompositeOperation = 'source-over';
    layer.globalAlpha = 1;
    layer.lineWidth = b.size;
    layer.lineCap = 'round';
    layer.lineJoin = 'round';
    layer.strokeStyle = b.color;
    if (!b.hard) { layer.shadowColor = b.color; layer.shadowBlur = b.size / 2; }
    layer.beginPath();
    layer.moveTo(from.x, from.y);
    layer.lineTo(to.x, to.y);
    layer.stroke();
    layer.restore();
    if (layer !== ctx) {
      growStrokeBounds(from, to);
      flushStroke();
      endStroke();
    }
  };
  const drawEraserSegment = (from, to) => {
    // Reuse the release-time erase pass with a two-point trail: it restores the
    // background along the segment and punches the same line into live objects.
    erasePreviewRef.current = {
      strokes: [{ size: brushRef.current.size, pts: [from, to], drawn: 0 }],
    };
    applyEraseGesture();
  };
  const commitSegment = (from, to, isErase) => {
    pushSnapshot();
    if (isErase) drawEraserSegment(from, to);
    else drawBrushSegment(from, to);
    constrainRastersToMask();
    scheduleOverlay();
  };

  // ── Sticker hit-testing (local frame) ──────────────────────
  // Select box, handles and every hit test work in the drawn (unflipped)
  // frame — see objectLocal.
  const stickerLocal = objectLocal;

  // Eyedropper shared by the Eyedropper tool and the right-click shortcut:
  // read the VISIBLE pixel under `p` (base image → movables → paint) and make
  // it the current brush colour, so a colour can be picked off movables/paint.
  const pickColorAt = (p) => {
    const x = Math.max(0, Math.min(W - 1, p.x | 0));
    const y = Math.max(0, Math.min(H - 1, p.y | 0));
    let picked = null;
    const sctx = getPickCanvas().getContext('2d');
    if (sctx) {
      sctx.save();
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = 'source-over';
      sctx.globalAlpha = 1;
      sctx.clearRect(0, 0, 1, 1);
      sctx.translate(-x, -y);
      if (baseCanvasRef.current) sctx.drawImage(baseCanvasRef.current, 0, 0);
      if (fillCanvasRef.current) sctx.drawImage(fillCanvasRef.current, 0, 0);
      for (const o of objectsRef.current) {
        if (hasLiveVisual(o)) paintObjectInPanel(sctx, o);
      }
      if (canvasRef.current) sctx.drawImage(canvasRef.current, 0, 0);
      sctx.restore();
      const d = sctx.getImageData(0, 0, 1, 1).data;
      if (d[3] > 0) picked = rgbaToHex(d[0], d[1], d[2]);
    }
    if (picked == null) {
      const ctx = baseCtxRef.current || ctxRef.current;
      if (!ctx) return;
      const d = ctx.getImageData(x, y, 1, 1).data;
      picked = rgbaToHex(d[0], d[1], d[2]);
    }
    setBrush({ ...brushRef.current, color: picked });
  };

  // ── Canvas pointer handlers ────────────────────────────────
  const onCanvasDown = (e) => {
    if (e.button === 1 || spaceRef.current) return; // pan handled by wrapper
    if (e.button !== 2) consumeRightRef.current = false;
    const ctx = ctxRef.current;
    if (!ctx) return;
    const p = toTexture(e.clientX, e.clientY);
    // No tab strip: a left click anywhere in a panel makes it the active one
    // for every tool (the active panel is the only editable region and the
    // only place a live object is rendered).
    if (e.button === 0 && panelCount > 1) {
      const idx = panelIndexAt(p.x);
      if (idx !== active && onActivePanel) {
        // Mirror the switch synchronously so THIS press already targets the new
        // panel (wand / fill / lasso read `activeRef`), matching the pen which
        // paints where it is clicked.
        activeRef.current = idx;
        onActivePanel(idx);
      }
    }
    // Right-button press arms the movable's layer-order target only in the
    // Select tool's object sub-mode; every other tool (pen/wand/shapes/...) and
    // empty canvas picks the pixel colour instead. The layer-order menu itself
    // opens on contextmenu (a full right-click, press + release) so it stays
    // open without holding the button.
    // Two tools consume the press as an editing gesture instead:
    // - line tool (curve mode) with a draft: pop the last control point
    //   (a lone point cancels the draft outright);
    // - text tool with an open box: commit it, exactly like Enter.
    if (e.button === 2) {
      if (toolRef.current === 'line' && lineModeRef.current === 'curve' &&
        curveRef.current && curveRef.current.pts.length > 0) {
        const d = curveRef.current;
        d.pts = d.pts.slice(0, -1);
        if (d.pts.length === 0) curveRef.current = null;
        else { d.hover = null; curveRef.current = d; }
        consumeRightRef.current = true;
        scheduleOverlay();
        return;
      }
      if (toolRef.current === 'text' && textAnchorRef.current) {
        commitText();
        setTool('select');
        consumeRightRef.current = true;
        return;
      }
      if (toolRef.current === 'select' && selModeRef.current === 'object') {
        const hit = hitObjectAt(p);
        if (hit) {
          if (selIdRef.current !== hit.id) syncObjects(objectsRef.current, hit.id);
          scheduleOverlay();
          return;
        }
      }
      setOrderMenuTracked(null);
      pickColorAt(p);
      return;
    }
    if (orderMenuRef.current) setOrderMenuTracked(null);
    const t = toolRef.current;
    // Capture on the element that received the event (the chrome interaction
    // surface) so subsequent pointermove/up keep reaching the tool handlers.
    const capture = () => {
      const el = e.target || overlayRef.current;
      if (el && el.setPointerCapture) el.setPointerCapture(e.pointerId);
    };

    // Live-object interactions (Select tool): click to select / move, drag the
    // handles to scale / rotate, click away to deselect. Lines and curves get
    // a taller hit band since their box is only the stroke thickness. The
    // topmost (last-drawn) object under the cursor wins.
    if (t === 'select') {
      // Selection sub-modes build the mask instead of touching objects: the
      // pen starts a freehand lasso, the wand floods the clicked region.
      if (selModeRef.current === 'pen') {
        lassoRef.current = { pts: [p] };
        capture();
        scheduleOverlay();
        return;
      }
      if (selModeRef.current === 'wand') {
        applyWandAt(p);
        return;
      }
      const z = effZoom || 1;
      const gap = 40 / z;
      const grab = 22 / z;
      const objs = objectsRef.current;
      const sel = getSelected();
      if (sel) {
        const lp = stickerLocal(sel, p);
        const fb = frameOf(sel);
        const fcx = (fb.x0 + fb.x1) / 2;
        // The box + handles are drawn in the UNFLIPPED frame (see drawOverlay),
        // and stickerLocal maps the pointer into that same frame — so the grab
        // points are the drawn ones, mirror or not. Mirroring them (the old
        // flipLocal) put the hit zones on the opposite corner, so a flipped
        // sticker/shape could not be scaled and its rotate dot never grabbed.
        const resizeAt = { x: fb.x1, y: fb.y1 };
        const rotateAt = { x: fcx, y: fb.y0 - gap };
        // Lines/curves have no corner resize: their end vertices sit on (or
        // next to) the box corner, so the grab must reshape the stroke via
        // vertex mode instead of scaling the frame.
        const canResize = sel.kind !== 'line' && sel.kind !== 'curve';
        if (canResize && Math.hypot(lp.x - resizeAt.x, lp.y - resizeAt.y) < grab) {
          dragRef.current = {
            mode: 'resize', id: sel.id, startW: sel.w, startH: sel.h,
            startSize: sel.size, startP: p, startPts: sel.pts,
            startStretch: sel.stretch || null,
            // Holes + boundary scale with the frame, so a part-erased object
            // keeps its shape while being resized.
            startErase: scaleErase(1, sel.erase), startFrame: sel.frame || null,
            startErasePolys: scaleErasePolys(1, sel.erasePolys),
          };
          capture(); return;
        }
        if (Math.hypot(lp.x - rotateAt.x, lp.y - rotateAt.y) < grab) {
          dragRef.current = { mode: 'rotate', id: sel.id };
          capture(); return;
        }
      }
      // Vertex grab for lines/curves: dragging a node reshapes the stroke.
      // The selected object's nodes win; otherwise the topmost line/curve
      // with a node under the cursor is selected and grabbed.
      const vertexIndexAt = (o) => {
        const qs = objectVertices(o);
        for (let vi = 0; vi < qs.length; vi++) {
          const wpt = worldFromLocal(o, qs[vi]);
          if (Math.hypot(p.x - wpt.x, p.y - wpt.y) < grab) return vi;
        }
        return -1;
      };
      let vHit = null;
      if (sel && (sel.kind === 'line' || sel.kind === 'curve')) {
        const vi = vertexIndexAt(sel);
        if (vi >= 0) vHit = { o: sel, vi };
      }
      if (!vHit) {
        for (let i = objs.length - 1; i >= 0; i--) {
          const o = objs[i];
          if (o.kind !== 'line' && o.kind !== 'curve') continue;
          if (!hasLiveVisual(o)) continue;
          const vi = vertexIndexAt(o);
          if (vi >= 0) { vHit = { o, vi }; break; }
        }
      }
      if (vHit) {
        if (selIdRef.current !== vHit.o.id) syncObjects(objs, vHit.o.id);
        dragRef.current = { mode: 'vertex', id: vHit.o.id, vi: vHit.vi };
        capture(); scheduleOverlay(); return;
      }
      let hit = null;
      for (let i = objs.length - 1; i >= 0; i--) {
        const o = objs[i];
        const lp = stickerLocal(o, p);
        const hitY = (o.kind === 'line' || o.kind === 'curve') ? Math.max(o.h / 2, 14 / z) : o.h / 2;
        if (Math.abs(lp.x) <= o.w / 2 && Math.abs(lp.y) <= hitY) { hit = o; break; }
      }
      if (hit) {
        if (selIdRef.current !== hit.id) syncObjects(objs, hit.id);
        dragRef.current = { mode: 'move', id: hit.id, dx: hit.x - p.x, dy: hit.y - p.y };
        capture(); scheduleOverlay(); return;
      }
      if (sel) syncObjects(objs, null);
    }

    if (t === 'brush' || t === 'eraser') {
      const isErase = t === 'eraser';
      // Shift+click draws a straight segment from the previous anchor to the
      // click, then re-anchors there (a third Shift+click chains the next line).
      if (e.shiftKey && lineAnchorRef.current) {
        const from = lineAnchorRef.current;
        lineAnchorRef.current = p;
        commitSegment(from, p, isErase);
        return;
      }
      pushSnapshot();
      strokeRef.current = { last: p, erase: isErase };
      // The brush paints into its own layer (composited with the alpha once);
      // the eraser only records its trail and shows a dark preview until the
      // pointer is released (see applyEraseGesture).
      if (t === 'brush') strokeRef.current.layer = beginStroke();
      else {
        erasePreviewRef.current = { strokes: [{ size: brushRef.current.size, pts: [p], drawn: 0 }] };
        const ov = overlayRef.current;
        if (ov) paintErasePreview(ov.getContext('2d'), erasePreviewRef.current.strokes, true, OVERLAY_PAD, OVERLAY_PAD);
      }
      capture();
    } else if (t === 'eyedropper') {
      pickColorAt(p);
      setTool('brush');
    } else if (t === 'fill') {
      // The fill lives on its OWN layer UNDER every movable, so a flood fill
      // never lands on top of a sticker/shape/text — a later pen stroke still
      // covers the fill, and movables sit above it.
      //
      // The fill LAYER itself is mostly transparent, so flooding it directly
      // would always see one uniform colour and fill the whole panel (tolerance
      // did nothing). Instead the region is computed from the VISIBLE composite
      // (base → fill → movables → pen), exactly like the wand, and only the
      // resulting spans are written into the fill layer. Tolerance and the
      // active-panel bound therefore behave the same for fill and wand.
      const fillCtx = fillCtxRef.current;
      if (!fillCtx) return;
      const scene = getWandCanvas();
      const sceneCtx = scene && scene.getContext('2d');
      if (!sceneCtx) return;
      sceneCtx.save();
      sceneCtx.setTransform(1, 0, 0, 1, 0, 0);
      sceneCtx.globalCompositeOperation = 'source-over';
      sceneCtx.globalAlpha = 1;
      sceneCtx.clearRect(0, 0, W, H);
      if (baseCanvasRef.current) sceneCtx.drawImage(baseCanvasRef.current, 0, 0);
      if (fillCanvasRef.current) sceneCtx.drawImage(fillCanvasRef.current, 0, 0);
      for (const o of objectsRef.current) {
        if (hasLiveVisual(o)) paintObjectForDisplay(sceneCtx, o);
      }
      if (canvasRef.current) sceneCtx.drawImage(canvasRef.current, 0, 0);
      // Confine the flood to the panel just clicked (a press into another panel
      // switches panels AND fills there in one go — see `activeRef`).
      const panelRegion = panelCount > 1
        ? { x0: layout.x(activeRef.current), y0: 0, x1: layout.x(activeRef.current) + TEXTURE - 1, y1: H - 1 }
        : null;
      let region = null;
      try { region = wandRegion(sceneCtx.getImageData(0, 0, W, H), p.x | 0, p.y | 0, fillTolRef.current, panelRegion); }
      catch (_) { region = null; }
      sceneCtx.restore();
      if (!region || region.count === 0) return;
      pushSnapshot();
      const bc = brushRef.current;
      const rgb = hexToRgba(bc.color);
      const alpha = Math.round((bc.opacity ?? 1) * 255);
      // Replace the region: cut the old fill out, then paint the new colour at
      // the brush alpha — matching the per-pixel write the old flood fill did.
      fillCtx.save();
      fillCtx.setTransform(1, 0, 0, 1, 0, 0);
      fillCtx.globalAlpha = 1;
      fillCtx.globalCompositeOperation = 'destination-out';
      fillCtx.fillStyle = '#000';
      for (const s of region.spans) fillCtx.fillRect(s.x0, s.y, s.x1 - s.x0 + 1, 1);
      fillCtx.globalCompositeOperation = 'source-over';
      fillCtx.globalAlpha = alpha / 255;
      fillCtx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      for (const s of region.spans) fillCtx.fillRect(s.x0, s.y, s.x1 - s.x0 + 1, 1);
      fillCtx.restore();
      invalidateFillPixels();
      constrainRastersToMask();
    } else if (t === 'line' || t === 'rect' || t === 'ellipse') {
      // Curve mode appends a control point per click (the smooth preview
      // appears from the second point on); every other shape drags.
      if (t === 'line' && lineModeRef.current === 'curve') {
        const d = curveRef.current || { pts: [], hover: null };
        d.pts = [...d.pts, p];
        curveRef.current = d;
        scheduleOverlay();
      } else {
        shapeRef.current = { tool: t, start: p, current: p };
        capture();
      }
    } else if (t === 'text') {
      // Clicking away from a pending box commits it (treated as Enter) and
      // hands over to Select; a click with no pending draft starts a new box.
      if (textAnchorRef.current && String(textDraftRef.current || '').trim()) {
        commitText();
        setTool('select');
      } else {
        setTextAnchor(p);
        setTextDraft('');
      }
    }
  };

  // Full right-click (press + release, any tool): a movable object under the
  // cursor gets selected and pinned with the layer-order menu; empty canvas
  // just dismisses the menu (the colour pick already ran on pointerdown).
  const onCanvasContextMenu = (e) => {
    e.preventDefault();
    // A press consumed as an editing gesture (curve node pop / text commit)
    // swallows its release too — no order menu, no colour pick.
    if (consumeRightRef.current) { consumeRightRef.current = false; return; }
    if (!ctxRef.current || typeof e.clientX !== 'number') return;
    // The movable layer-order menu is a Select-tool (object sub-mode) affordance
    // only — every other tool's right-click is a colour pick (handled on the
    // press), so never open the menu here.
    if (toolRef.current !== 'select' || selModeRef.current !== 'object') {
      if (orderMenuRef.current) setOrderMenuTracked(null);
      return;
    }
    const p = toTexture(e.clientX, e.clientY);
    const hit = hitObjectAt(p);
    if (hit) {
      if (selIdRef.current !== hit.id) syncObjects(objectsRef.current, hit.id);
      setOrderMenuTracked({ x: e.clientX, y: e.clientY, id: hit.id });
      scheduleOverlay();
      return;
    }
    if (orderMenuRef.current) setOrderMenuTracked(null);
  };

  const onCanvasMove = (e) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (strokeRef.current) {
      const isErase = strokeRef.current.erase;
      const b = brushRef.current;
      const points = coalesced(e);
      // ── Eraser: record the trail, darken it, and nothing else ──
      // No base restore and no object rebuild/punch/blit here: those are O(area)
      // and ran per frame, which is what made the eraser trail the cursor. The
      // whole gesture is applied once on release (applyEraseGesture).
      if (isErase) {
        const prev = erasePreviewRef.current;
        if (prev && prev.strokes.length) {
          const cur = prev.strokes[prev.strokes.length - 1];
          for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const last = cur.pts[cur.pts.length - 1];
            const dx = p.x - last.x, dy = p.y - last.y;
            if (dx * dx + dy * dy < ERASE_PT_MIN_DIST * ERASE_PT_MIN_DIST) continue;
            cur.pts.push(p);
          }
          const ov = overlayRef.current;
          if (ov) paintErasePreview(ov.getContext('2d'), prev.strokes, true, OVERLAY_PAD, OVERLAY_PAD);
        }
        strokeRef.current.last = points[points.length - 1];
        return;
      }
      // Brush dabs go to the stroke layer (flushed once per event with the
      // brush alpha).
      const target = strokeRef.current.layer || ctx;
      // Paint state is set ONCE per event (not per coalesced point).
      target.save();
      target.globalCompositeOperation = 'source-over';
      target.globalAlpha = 1;
      target.lineWidth = b.size;
      target.lineCap = 'round';
      target.lineJoin = 'round';
      target.strokeStyle = b.color;
      if (!b.hard) { target.shadowColor = b.color; target.shadowBlur = b.size / 2; }
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        target.beginPath();
        target.moveTo(strokeRef.current.last.x, strokeRef.current.last.y);
        target.lineTo(p.x, p.y);
        target.stroke();
        growStrokeBounds(strokeRef.current.last, p);
        strokeRef.current.last = p;
      }
      target.restore();
      flushStroke();
      return;
    }
    // Freehand lasso: collect the trail, previewed dotted on the overlay.
    if (lassoRef.current) {
      for (const p of coalesced(e)) lassoRef.current.pts.push(p);
      scheduleOverlay();
      return;
    }
    if (shapeRef.current) {
      shapeRef.current.current = toTexture(e.clientX, e.clientY);
      scheduleOverlay();
      return;
    }
    // Curve rubber-band: track the cursor as the tentative next point once at
    // least one control point exists (the preview needs 2+ points to draw).
    if (curveRef.current && curveRef.current.pts.length > 0) {
      curveRef.current.hover = toTexture(e.clientX, e.clientY);
      scheduleOverlay();
      return;
    }
    if (dragRef.current) {
      const st = objectsRef.current.find(o => o.id === dragRef.current.id);
      if (st) {
        const p = toTexture(e.clientX, e.clientY);
        ensureDragSnapshot();
        const mode = dragRef.current.mode;
        if (mode === 'move') {
          // The panel the movable belongs to follows the POINTER, not the
          // object's own centre: a big sticker grabbed by its edge would
          // otherwise keep rendering in the old panel (and vanish at the gutter)
          // until its centre crossed. The chosen panel is persisted on the
          // object, so the panel it is dropped into is also the one it renders
          // and exports in.
          updateObject(st.id, {
            x: p.x + dragRef.current.dx,
            y: p.y + dragRef.current.dy,
            panel: panelIndexAt(p.x),
          });
        }
        else if (mode === 'resize') {
          const d = dragRef.current;
          // Shift keeps the aspect ratio (one factor); free, each axis follows
          // the pointer so the object stretches. Both scale about the centre.
          const { kx, ky } = resizeFactors(st, d.startP, p, e.shiftKey);
          const patch = { w: Math.max(8, d.startW * kx), h: Math.max(8, d.startH * ky) };
          if (st.kind === 'text' && d.startSize) {
            if (e.shiftKey) {
              // Aspect-locked: the font follows the box, so the glyphs match.
              patch.size = Math.max(4, d.startSize * kx);
            } else {
              // Free stretch keeps the font and stretches the glyphs to the
              // box, so the box keeps hugging them.
              const s0 = d.startStretch || { sx: 1, sy: 1 };
              patch.stretch = { sx: Math.max(0.01, s0.sx * kx), sy: Math.max(0.01, s0.sy * ky) };
            }
          }
          // Curves scale their control points with the box so the shape holds.
          if (st.kind === 'curve' && d.startPts) {
            patch.pts = d.startPts.map(q => ({ x: q.x * kx, y: q.y * ky }));
          }
          // Eraser holes and the part-erase boundary scale too: without this the
          // holes stayed put while the content grew, so a half circle turned
          // into a lopsided blob instead of staying a half circle.
          if (d.startErase) patch.erase = scaleErase(kx, d.startErase, ky);
          if (d.startErasePolys) patch.erasePolys = scaleErasePolys(kx, d.startErasePolys, ky);
          if (d.startFrame) patch.frame = scaleFrame(kx, d.startFrame, ky);
          updateObject(st.id, patch);
        } else if (mode === 'rotate') {
          updateObject(st.id, { rot: Math.atan2(p.y - st.y, p.x - st.x) + Math.PI / 2 });
        } else if (mode === 'vertex') {
          // Drag one node in the object's local frame, then re-derive the
          // frame: the world centre shifts by the dragged local offset, and
          // a line additionally folds the new direction into `rot`.
          const d = dragRef.current;
          const L = localFromWorld(st, p);
          if (st.kind === 'line') {
            const A = { x: -st.w / 2, y: 0 };
            const B = { x: st.w / 2, y: 0 };
            if (d.vi === 0) { A.x = L.x; A.y = L.y; } else { B.x = L.x; B.y = L.y; }
            const dx = B.x - A.x;
            const dy = B.y - A.y;
            const len = Math.hypot(dx, dy);
            if (len > 2) {
              const wc = worldFromLocal(st, { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 });
              updateObject(st.id, {
                x: wc.x, y: wc.y, w: len,
                rot: (st.rot || 0) + Math.atan2(dy, dx),
              });
            }
          } else if (st.kind === 'curve' && st.pts) {
            const moved = st.pts.map((q, i) => (i === d.vi ? { x: L.x, y: L.y } : { x: q.x, y: q.y }));
            const xs = moved.map(q => q.x);
            const ys = moved.map(q => q.y);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            if (maxX - minX >= 2 || maxY - minY >= 2) {
              const cx = (minX + maxX) / 2;
              const cy = (minY + maxY) / 2;
              const wc = worldFromLocal(st, { x: cx, y: cy });
              updateObject(st.id, {
                x: wc.x, y: wc.y, w: maxX - minX, h: maxY - minY,
                pts: moved.map(q => ({ x: q.x - cx, y: q.y - cy })),
              });
            }
          }
        }
        setDirty(true);
        scheduleOverlay();
      }
    }
  };

  const onCanvasUp = () => {
    // Releasing the pen closes the lasso into the mask under the combine op.
    if (lassoRef.current) {
      const l = lassoRef.current;
      lassoRef.current = null;
      commitLasso(l);
      return;
    }
    // Ending a stroke clips it back to the selection (pre-stroke pixels come
    // from the snapshot pushed on pointer-down).
    if (strokeRef.current) {
      const wasErase = strokeRef.current.erase;
      const last = strokeRef.current.last;
      const layer = strokeRef.current.layer;
      strokeRef.current = null;
      if (wasErase) applyEraseGesture();
      else {
        // A click with no drag still deposits one dab, so the same click that
        // activates a panel paints on it instead of needing a second click.
        if (last && layer && !strokeBoundsRef.current) paintBrushDab(layer, last);
        flushStroke();
      }
      endStroke();
      // Re-anchor at the stroke end so a following Shift+click continues from
      // where this stroke finished (a plain click continues from the click).
      if (last) lineAnchorRef.current = last;
      constrainRastersToMask();
      scheduleOverlay();
      return;
    }
    if (shapeRef.current) {
      const sh = shapeRef.current;
      shapeRef.current = null;
      commitShape(sh);
      return;
    }
    dragRef.current = null;
  };

  // Double-click finishes a curve draft (line tool, curve mode), or re-opens
  // a text object with the Select tool.
  const onCanvasDoubleClick = (e) => {
    if (curveRef.current && curveRef.current.pts.length >= 2) { commitCurveDraft(); return; }
    // Text re-editing is an object-mode gesture; the pen/wand own the canvas.
    if (toolRef.current !== 'select' || selModeRef.current !== 'object') return;
    const p = toTexture(e.clientX, e.clientY);
    const objs = objectsRef.current;
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (o.kind !== 'text') continue;
      const lp = stickerLocal(o, p);
      if (Math.abs(lp.x) <= o.w / 2 && Math.abs(lp.y) <= o.h / 2) { startTextEdit(o); return; }
    }
  };

  // ── Shape preview (drawn on the overlay while dragging) ────
  function drawShape(ctx, shapeTool, a, b, brushOpts, sOpts, preview) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const saw = brushRgba(brushOpts);
    ctx.strokeStyle = saw;
    ctx.fillStyle = saw;
    ctx.lineWidth = sOpts.width;
    ctx.beginPath();
    if (shapeTool === 'line') { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    else if (shapeTool === 'rect') { ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); }
    else { ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2); }
    if (shapeTool === 'line' || !sOpts.filled) ctx.stroke();
    else { ctx.fill(); if (preview) ctx.stroke(); else { ctx.globalAlpha = 1; ctx.stroke(); } }
    ctx.restore();
  }

  // ── Shape commit — becomes a selectable live object (not rasterised) ──
  // Keeps the active shape tool so several shapes can be drawn in a row; the
  // committer stays live/selectable (switch to Select to move or resize it).
  const commitShape = (sh) => {
    const o = makeShapeObject(sh.tool, sh.start, sh.current, brushRef.current, shapeOptsRef.current);
    // Ignore an accidental click (no drag) — nothing to select or move.
    const tooSmall = sh.tool === 'line' ? o.w < 2 : (o.w < 2 && o.h < 2);
    if (tooSmall) { scheduleOverlay(); return; }
    pushSnapshot();
    addObject(o);
    setDirty(true);
    scheduleOverlay();
  };

  // ── Curve commit — clicked points become a selectable live object ──
  // Keeps the line tool in curve mode so several curves can be drawn in a row
  // (switch to Select to move or resize the committed curve). A degenerate
  // draft (fewer than 2 distinct points) is silently discarded.
  const commitCurveDraft = () => {
    const d = curveRef.current;
    curveRef.current = null;
    if (!d || d.pts.length < 2) { scheduleOverlay(); return; }
    const o = makeCurveObject(d.pts, brushRef.current, shapeOptsRef.current);
    if (!o) { scheduleOverlay(); return; }
    pushSnapshot();
    addObject(o);
    setDirty(true);
    scheduleOverlay();
  };

  const cancelCurveDraft = () => {
    if (!curveRef.current) return;
    curveRef.current = null;
    scheduleOverlay();
  };

  // ── Text commit — becomes a selectable live object (not rasterised) ──
  // Reads the ref-mirrored draft so pressing Enter, clicking away (blur) and
  // switching tools all funnel through the same commit. Does NOT change the
  // active tool; callers decide (Enter/deselect → select, tool switch → the
  // picked tool, canvas click → stays on text for a fresh box). When
  // `editingIdRef` is set the draft updates that existing text object instead of
  // creating a new one (content only; position/rotation/flip are preserved).
  const commitText = () => {
    const anchor = textAnchorRef.current;
    const raw = String(textDraftRef.current || '').trim();
    const editId = editingIdRef.current;
    editingIdRef.current = null;
    if (!anchor) { setTextAnchor(null); setTextDraft(''); return; }
    if (editId != null) {
      const target = objectsRef.current.find(o => o.id === editId);
      if (target && raw) {
        const opts = { font: target.font, size: target.size, bold: !!target.bold, italic: !!target.italic };
        const { w, h } = measureLiveText(ctxRef.current, raw, opts, target.stretch);
        pushSnapshot();
        updateObject(editId, { text: raw, w, h });
        setDirty(true);
      }
      setTextAnchor(null);
      setTextDraft('');
      scheduleOverlay();
      return;
    }
    if (!raw) { setTextAnchor(null); setTextDraft(''); return; }
    const o = textOptsRef.current;
    const { w, h } = measureLiveText(ctxRef.current, raw, o);
    pushSnapshot();
    // Keep the clicked point as the top-left corner of the text box.
    addObject({
      kind: 'text', text: raw, font: o.font, size: o.size, bold: o.bold, italic: o.italic,
      color: brushRef.current.color, opacity: brushRef.current.opacity ?? 1, w, h,
      x: anchor.x + w / 2, y: anchor.y + h / 2,
      rot: 0, flipX: false, flipY: false,
    });
    setTextAnchor(null);
    setTextDraft('');
    setDirty(true);
    scheduleOverlay();
  };

  // ── Re-edit an existing text object (Select tool: double-click / Enter) ──
  const startTextEdit = (o) => {
    if (!o || o.kind !== 'text') return;
    editingIdRef.current = o.id;
    setTextOpts({ ...textOptsRef.current, font: o.font, size: o.size, bold: !!o.bold, italic: !!o.italic });
    // Anchor the inline input at the box's top-left (unrotated frame).
    setTextAnchor({ x: o.x - o.w / 2, y: o.y - o.h / 2 });
    setTextDraft(o.text);
    syncObjects(objectsRef.current, o.id);
    scheduleOverlay();
  };

  // ── Apply an option-bar change to the selected text object and new-text
  // defaults. With the Select tool the change edits the selected text in place
  // (box re-measured), otherwise it just updates the next box's defaults. ──
  const applyTextOpt = (patch) => {
    setTextOpts({ ...textOptsRef.current, ...patch });
    if (toolRef.current !== 'select') return;
    const sel = getSelected();
    if (!sel || sel.kind !== 'text') return;
    const opts = { font: sel.font, size: sel.size, bold: !!sel.bold, italic: !!sel.italic, ...patch };
    // A stretched box keeps its stretch across a font/size/bold change.
    const { w, h } = measureLiveText(ctxRef.current, sel.text, opts, sel.stretch);
    updateObject(sel.id, { ...patch, w, h });
    setDirty(true);
    scheduleOverlay();
  };

  // ── Gesture settling (keyboard parity) ───────────────────
  // A mouse click on a toolbar button can never land mid-gesture (pointer
  // capture forces a release first), but a keyboard shortcut can. Settle any
  // in-progress gesture exactly as releasing the pointer would — end the
  // stroke, commit the shape preview, end the object drag, commit the text
  // draft — and dismiss the order menu, so shortcuts act on a stable canvas
  // identically to clicking the matching button. Everything touched is a ref
  // or a stable setter, so early-captured closures stay valid.
  const settleGesture = () => {
    // An interrupted stroke still clips to the selection before it settles.
    if (strokeRef.current) {
      const wasErase = strokeRef.current.erase;
      const last = strokeRef.current.last;
      const layer = strokeRef.current.layer;
      strokeRef.current = null;
      if (wasErase) applyEraseGesture();
      else {
        if (last && layer && !strokeBoundsRef.current) paintBrushDab(layer, last);
        flushStroke();
      }
      endStroke();
      constrainRastersToMask();
    }
    // An interrupted lasso commits like a pointer release would.
    if (lassoRef.current) {
      const l = lassoRef.current;
      lassoRef.current = null;
      commitLasso(l);
    }
    if (shapeRef.current) {
      const sh = shapeRef.current;
      shapeRef.current = null;
      commitShape(sh);
    }
    if (dragRef.current) dragRef.current = null;
    commitText();
    commitCurveDraft();
    if (orderMenuRef.current) setOrderMenuTracked(null);
  };

  // Shared tool activation for the rail buttons and the letter shortcuts.
  const activateTool = (name) => {
    settleGesture();
    // Leaving the Select tool while in single-select (object) mode drops the
    // selected movable; a pen/wand mask selection survives the switch.
    if (name !== 'select' && toolRef.current === 'select'
      && selModeRef.current === 'object' && selIdRef.current != null) {
      syncObjects(objectsRef.current, null);
    }
    setTool(name);
  };

  // ── Clear / reset (confirm modal) ──────────────────────────
  // Always resets to the selected aircraft type's built-in default livery
  // (whether editing a saved livery, a new one, or an imported image). Falls
  // back to the opened base image, then the neutral fill, when the type's
  // template is unavailable.
  const handleClear = () => {
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      () => t('livery_paint_clear_confirm_title'),
      () => <p>{t('livery_paint_clear_confirm_body')}</p>,
      () => (
        <>
          <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
          <button className="btn-danger" onClick={() => {
            hideModal();
            pushSnapshot();
            endStroke();
            const clearParts = defaultPartsRef.current.some(p => p && p.imageDataUrl)
              ? defaultPartsRef.current
              : initialPartsRef.current;
            // Reset the base layer, wipe both raster layers, drop the movables.
            for (const layerCtx of [ctxRef.current, fillCtxRef.current]) {
              if (!layerCtx) continue;
              layerCtx.setTransform(1, 0, 0, 1, 0, 0);
              layerCtx.clearRect(0, 0, W, H);
            }
            invalidateFillPixels();
            const baseCtx = baseCtxRef.current;
            if (baseCtx) {
              drawBase(baseCtx, layout, clearParts, () => {
                try { basePixelsRef.current = baseCtx.getImageData(0, 0, W, H); } catch (_) {}
                scheduleOverlay();
              });
            }
            syncObjects([], null);
            setTextAnchor(null);
            // A cleared canvas carries no selection either.
            lassoRef.current = null;
            clearMask();
            scheduleOverlay();
          }}>{t('livery_paint_clear')}</button>
        </>
      )
    );
  };

  // ── Brush/eraser true-size cursor ring (ref-driven, no re-render) ─
  const moveCursorRing = (e) => {
    const ring = cursorRingRef.current;
    if (!ring) return;
    if (e.target && e.target.tagName === 'INPUT') { ring.style.display = 'none'; return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    ring.style.display = 'block';
    ring.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  };
  const hideCursorRing = () => {
    if (cursorRingRef.current) cursorRingRef.current.style.display = 'none';
  };
  const showBrushRing = tool === 'brush' || tool === 'eraser';
  // Screen diameter of the brush (texture px × zoom), clamped so tiny
  // brushes still show a usable ring.
  const ringDiameter = Math.max(5, brush.size * effZoom);

  // ── Wrapper pan (space-drag + middle-drag) ─────────────────
  // The hand icon follows the pointer while Space is held (view-port fixed).
  const moveHand = (clientX, clientY) => {
    const el = handRef.current;
    if (!el) return;
    el.style.transform = `translate(${clientX}px, ${clientY}px) translate(-50%, -50%)`;
  };
  const onWrapDown = (e) => {
    if (e.button === 1 || spaceRef.current) {
      e.preventDefault();
      panRef.current = { sx: e.clientX, sy: e.clientY, sl: wrapRef.current.scrollLeft, st: wrapRef.current.scrollTop };
      e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId);
    }
  };
  const onWrapMove = (e) => {
    if (spaceRef.current) moveHand(e.clientX, e.clientY);
    if (!panRef.current) return;
    wrapRef.current.scrollLeft = panRef.current.sl - (e.clientX - panRef.current.sx);
    wrapRef.current.scrollTop = panRef.current.st - (e.clientY - panRef.current.sy);
  };
  const onWrapUp = () => { panRef.current = null; };

  const ActiveIcon = (TOOL_META[tool] || {}).Icon;
  // With Select, a selected text object exposes the text options (edit in place).
  const selectedText = (() => {
    if (tool !== 'select') return null;
    const sel = getSelected();
    return sel && sel.kind === 'text' ? sel : null;
  })();
  const shownText = selectedText
    ? { font: selectedText.font, size: selectedText.size, bold: !!selectedText.bold, italic: !!selectedText.italic }
    : textOpts;
  // With Select, a selected sticker exposes an opacity (alpha) slider on the
  // options bar. Stored on the object (`opacity`), so the overlay, the export
  // flatten and a duplicate stamp all read the same value.
  const selectedSticker = (() => {
    if (tool !== 'select') return null;
    const sel = getSelected();
    return sel && sel.kind === 'sticker' ? sel : null;
  })();
  const stickerOpacityPct = selectedSticker
    ? Math.round((selectedSticker.opacity == null ? 1 : selectedSticker.opacity) * 100)
    : 100;
  const setStickerOpacity = (pct) => {
    const sel = getSelected();
    if (!sel || sel.kind !== 'sticker') return;
    updateObject(sel.id, { opacity: Math.max(0, Math.min(100, pct)) / 100 });
    setDirty(true);
    scheduleOverlay();
  };

  return (
    <div className="lp-workspace">
      {/* ── Options bar — fixed height, always visible so the canvas never shifts ── */}
      <div className="lp-optionsbar">
        <span className="lp-options-tool">
          {ActiveIcon && <ActiveIcon size={15} />}
          <span>{t('livery_paint_' + tool)}</span>
        </span>
        {(TOOLS_WITH_OPTIONS.includes(tool) || selectedText) && (
          <>
            <span className="lp-sep" />
          {(tool === 'brush' || tool === 'eraser') && (
            <label className="lp-field">{t('livery_paint_size')}
              <input type="range" min={1} max={200} value={brush.size} onChange={(e) => setBrush({ ...brush, size: Number(e.target.value) })} />
              <NumberInput value={brush.size} min={1} max={200} onCommit={(v) => setBrush({ ...brush, size: v })} ariaLabel={t('livery_paint_size')} />
            </label>
          )}
          {tool === 'brush' && (
            <span className="lp-seg">
              <button className={brush.hard ? 'lp-on' : ''} {...bind(t('livery_paint_hard'))} aria-label={t('livery_paint_hard')} aria-pressed={brush.hard} onClick={() => setBrush({ ...brush, hard: true })}><FaPencil size={15} /></button>
              <button className={!brush.hard ? 'lp-on' : ''} {...bind(t('livery_paint_soft'))} aria-label={t('livery_paint_soft')} aria-pressed={!brush.hard} onClick={() => setBrush({ ...brush, hard: false })}><FaPaintBrush size={15} /></button>
            </span>
          )}
          {tool === 'select' && (
            <>
              <span className="lp-seg" role="group" aria-label={t('livery_paint_select_mode')}>
                {/* Tooltips advertise the sub-mode shortcuts (A / L / W). */}
                <button className={selMode === 'object' ? 'lp-on' : ''} {...bind(withKey(t('livery_paint_select_object'), 'A'))} aria-label={t('livery_paint_select_object')} aria-pressed={selMode === 'object'} onClick={() => setSelMode('object')}><FaArrowPointer size={15} /></button>
                <button className={selMode === 'pen' ? 'lp-on' : ''} {...bind(withKey(t('livery_paint_select_pen'), 'L'))} aria-label={t('livery_paint_select_pen')} aria-pressed={selMode === 'pen'} onClick={() => setSelMode('pen')}><LuLasso size={15} /></button>
                <button className={selMode === 'wand' ? 'lp-on' : ''} {...bind(withKey(t('livery_paint_select_wand'), 'W'))} aria-label={t('livery_paint_select_wand')} aria-pressed={selMode === 'wand'} onClick={() => setSelMode('wand')}><BsMagic size={15} /></button>
              </span>
              {selMode !== 'object' && (
                <span className="lp-seg" role="group" aria-label={t('livery_paint_mask_mode')}>
                  <button className={maskOp === 'combine' ? 'lp-on' : ''} {...bind(t('livery_paint_mask_combine'))} aria-label={t('livery_paint_mask_combine')} aria-pressed={maskOp === 'combine'} onClick={() => setMaskOp('combine')}><TbLayersUnion size={15} /></button>
                  <button className={maskOp === 'erase' ? 'lp-on' : ''} {...bind(t('livery_paint_mask_erase'))} aria-label={t('livery_paint_mask_erase')} aria-pressed={maskOp === 'erase'} onClick={() => setMaskOp('erase')}><TbLayersDifference size={15} /></button>
                  <button className={maskOp === 'replace' ? 'lp-on' : ''} {...bind(t('livery_paint_mask_replace'))} aria-label={t('livery_paint_mask_replace')} aria-pressed={maskOp === 'replace'} onClick={() => setMaskOp('replace')}><TbLayersSelected size={15} /></button>
                </span>
              )}
              {selMode === 'wand' && (
                <label className="lp-field">{t('livery_paint_tolerance')}
                  <input type="range" min={0} max={255} value={fillTol} onChange={(e) => setFillTol(Number(e.target.value))} />
                  <NumberInput value={fillTol} min={0} max={255} onCommit={setFillTol} ariaLabel={t('livery_paint_tolerance')} />
                </label>
              )}
              <span className="lp-seg">
                {/* Tooltip lives on the wrapper with the disabled button made
                    pointer-events:none, so it still shows before a selection. */}
                <span {...bind(withKey(t('livery_paint_deselect'), 'Ctrl+D'))} style={{ display: 'inline-flex' }}>
                  <button aria-label={t('livery_paint_deselect')} disabled={!hasMask} onClick={clearMask} style={!hasMask ? { pointerEvents: 'none' } : undefined}><MdOutlineLayersClear size={15} /></button>
                </span>
              </span>
              {selectedSticker && (
                <label className="lp-field">{t('livery_paint_opacity')}
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={stickerOpacityPct}
                    onChange={(e) => setStickerOpacity(Number(e.target.value))}
                  />
                  <NumberInput value={stickerOpacityPct} min={0} max={100} onCommit={setStickerOpacity} ariaLabel={t('livery_paint_opacity')} suffix="%" />
                </label>
              )}
            </>
          )}
          {tool === 'fill' && (
            <>
              <label className="lp-field">{t('livery_paint_tolerance')}
                <input type="range" min={0} max={255} value={fillTol} onChange={(e) => setFillTol(Number(e.target.value))} />
                <NumberInput value={fillTol} min={0} max={255} onCommit={setFillTol} ariaLabel={t('livery_paint_tolerance')} />
              </label>
            </>
          )}
          {(tool === 'line' || tool === 'rect' || tool === 'ellipse') && (
            <>
              {tool === 'line' && (
                <span className="lp-seg" role="group" aria-label={t('livery_paint_line_mode')}>
                  <button className={lineMode === 'straight' ? 'lp-on' : ''} {...bind(t('livery_paint_line_straight'))} aria-label={t('livery_paint_line_straight')} aria-pressed={lineMode === 'straight'} onClick={() => setLineMode('straight')}><IoRemoveOutline size={15} /></button>
                  <button className={lineMode === 'curve' ? 'lp-on' : ''} {...bind(t('livery_paint_line_curve'))} aria-label={t('livery_paint_line_curve')} aria-pressed={lineMode === 'curve'} onClick={() => setLineMode('curve')}><TbVectorSpline size={15} /></button>
                </span>
              )}
              <label className="lp-field">{t('livery_paint_width')}
                <input type="range" min={1} max={200} value={shapeOpts.width} onChange={(e) => setShapeOpts({ ...shapeOpts, width: Number(e.target.value) })} />
                <NumberInput value={shapeOpts.width} min={1} max={200} onCommit={(v) => setShapeOpts({ ...shapeOpts, width: v })} ariaLabel={t('livery_paint_width')} />
              </label>
              {tool !== 'line' && (
                <span className="lp-seg">
                  <button className={shapeOpts.filled ? 'lp-on' : ''} {...bind(t('livery_paint_fill_toggle'))} aria-label={t('livery_paint_fill_toggle')} aria-pressed={shapeOpts.filled} onClick={() => setShapeOpts({ ...shapeOpts, filled: !shapeOpts.filled })}><IoColorFill size={15} /></button>
                </span>
              )}
            </>
          )}
          {(tool === 'text' || selectedText) && (
            <>
              <label className="lp-field">{t('livery_paint_font')}
                <select
                  className="lp-font"
                  aria-label={t('livery_paint_font')}
                  value={shownText.font}
                  onChange={(e) => applyTextOpt({ font: e.target.value })}
                >
                  {FONT_OPTIONS.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                  {!FONT_OPTIONS.includes(shownText.font) && <option value={shownText.font}>{shownText.font}</option>}
                </select>
              </label>
              <label className="lp-field">{t('livery_paint_size')}
                <input type="range" min={8} max={400} value={shownText.size} onChange={(e) => applyTextOpt({ size: Number(e.target.value) })} />
                <NumberInput value={shownText.size} min={8} max={400} onCommit={(v) => applyTextOpt({ size: v })} ariaLabel={t('livery_paint_size')} />
              </label>
              <span className="lp-seg">
                <button className={shownText.bold ? 'lp-on' : ''} {...bind(t('livery_paint_bold'))} aria-label={t('livery_paint_bold')} aria-pressed={shownText.bold} onClick={() => applyTextOpt({ bold: !shownText.bold })}><strong>B</strong></button>
                <button className={shownText.italic ? 'lp-on' : ''} {...bind(t('livery_paint_italic'))} aria-label={t('livery_paint_italic')} aria-pressed={shownText.italic} onClick={() => applyTextOpt({ italic: !shownText.italic })}><em>I</em></button>
              </span>
            </>
          )}
          </>
        )}
      </div>

      {/* ── Main area — left tool rail + canvas viewport ── */}
      <div className="lp-main">
        <div className="lp-rail">
          <div className="lp-rail-group">
            {TOOLS.map(name => {
              const meta = TOOL_META[name] || {};
              const Icon = meta.Icon;
              const tip = t('livery_paint_' + name) + (meta.key ? ` (${meta.key})` : '');
              return (
                <button
                  key={name}
                  className={'lp-tool' + (tool === name ? ' lp-active' : '')}
                  {...bind(tip)}
                  aria-label={t('livery_paint_' + name)}
                  aria-pressed={tool === name}
                  onClick={() => activateTool(name)}
                >
                  {Icon ? <Icon size={18} /> : t('livery_paint_' + name)}
                </button>
              );
            })}
          </div>
          <div className="lp-rail-sep" />
          <div className="lp-rail-group">
            <button className="lp-tool" {...bind(withKey(t('livery_paint_import_sticker'), ACTION_KEYS.importSticker))} aria-label={t('livery_paint_import_sticker')} onClick={importSticker}><TbSticker2 size={18} /></button>
            <button className="lp-tool" {...bind(withKey(t('livery_paint_duplicate_sticker'), ACTION_KEYS.duplicate))} aria-label={t('livery_paint_duplicate_sticker')} disabled={objects.length === 0} onClick={duplicateSticker}><HiDocumentDuplicate size={18} /></button>
            <button className="lp-tool" {...bind(withKey(t('livery_paint_flip_h'), ACTION_KEYS.flipH))} aria-label={t('livery_paint_flip_h')} disabled={objects.length === 0} onClick={() => flipSticker('flipX')}><LuFlipHorizontal size={18} /></button>
            <button className="lp-tool" {...bind(withKey(t('livery_paint_flip_v'), ACTION_KEYS.flipV))} aria-label={t('livery_paint_flip_v')} disabled={objects.length === 0} onClick={() => flipSticker('flipY')}><LuFlipVertical size={18} /></button>
            <button className="lp-tool lp-danger" {...bind(withKey(t('livery_paint_delete_sticker'), ACTION_KEYS.delete))} aria-label={t('livery_paint_delete_sticker')} disabled={objects.length === 0} onClick={removeSticker}><CiBookmarkRemove size={18} /></button>
          </div>
          <div className="lp-rail-sep" />
          <div className="lp-rail-group">
            <button className="lp-tool" {...bind(withKey(t('livery_paint_undo'), ACTION_KEYS.undo))} aria-label={t('livery_paint_undo')} onClick={doUndo} disabled={undoRef.current.past.length === 0}><IoArrowUndoOutline size={18} /></button>
            <button className="lp-tool" {...bind(withKey(t('livery_paint_redo'), ACTION_KEYS.redo))} aria-label={t('livery_paint_redo')} onClick={doRedo} disabled={undoRef.current.future.length === 0}><IoArrowRedoOutline size={18} /></button>
            <button className="lp-tool lp-danger" {...bind(t('livery_paint_clear'))} aria-label={t('livery_paint_clear')} onClick={handleClear}><AiOutlineClear size={18} /></button>
          </div>
          <div className="lp-rail-sep" />
          <div className="lp-rail-group lp-rail-color-group">
            <button
              type="button"
              ref={colorSwatchRef}
              className="lp-rail-color"
              aria-label={t('livery_paint_color')}
              aria-haspopup="dialog"
              aria-expanded={!!colorAnchor}
              data-color={brush.color}
              data-alpha={brush.opacity ?? 1}
              {...bind(t('livery_paint_color'))}
              onClick={() => (colorAnchor ? setColorAnchor(null) : openColorPicker())}
            >
              <span
                className="lp-rail-color-fill"
                style={{ background: brush.color, opacity: brush.opacity ?? 1 }}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        <div
          ref={wrapRef}
          className="livery-canvas-wrap"
          tabIndex={0}
          onPointerDown={onWrapDown}
          onPointerMove={onWrapMove}
          onPointerUp={onWrapUp}
        >
          <div ref={handRef} className="lp-hand-cursor" style={{ display: spaceHeld ? 'block' : 'none' }} aria-hidden="true">
            <FaRegHandPaper size={22} />
          </div>
          <div className="lp-canvas-stage" data-active-panel={active} style={{ width: W * effZoom, height: H * effZoom }} onPointerMove={showBrushRing ? moveCursorRing : undefined} onPointerDown={showBrushRing ? moveCursorRing : undefined} onPointerLeave={showBrushRing ? hideCursorRing : undefined}>
            {/* Layer 1 — locked base aircraft image. */}
            <canvas
              ref={baseCanvasRef}
              data-layer="base"
              width={W}
              height={H}
              style={{ position: 'absolute', left: 0, top: 0, width: W * effZoom, height: H * effZoom, pointerEvents: 'none' }}
              aria-hidden="true"
            />
            {/* Layer 2 — raster fill underlay, below every movable. */}
            <canvas
              ref={fillCanvasRef}
              data-layer="fill"
              width={W}
              height={H}
              style={{ position: 'absolute', left: 0, top: 0, width: W * effZoom, height: H * effZoom, pointerEvents: 'none' }}
              aria-hidden="true"
            />
            {/* Layer 3 — live movables (stickers/shapes/text). */}
            <canvas
              ref={objectCanvasRef}
              data-layer="objects"
              width={W}
              height={H}
              style={{ position: 'absolute', left: 0, top: 0, width: W * effZoom, height: H * effZoom, pointerEvents: 'none' }}
              aria-hidden="true"
            />
            {/* Layer 4 — raster pen (brush/eraser), above movables. */}
            <canvas
              ref={canvasRef}
              data-layer="paint"
              width={W}
              height={H}
              style={{ position: 'absolute', left: 0, top: 0, width: W * effZoom, height: H * effZoom, pointerEvents: 'none' }}
              aria-hidden="true"
            />
            {/* Layer 5 — chrome + interaction surface. Extends OVERLAY_PAD past
                the bitmap so a scale/rotate knob drawn outside the 2048 square
                can still be grabbed and the drag keeps registering out there
                (pointer capture stays on this element). */}
            <canvas
              ref={overlayRef}
              data-layer="chrome"
              width={W + OVERLAY_PAD * 2}
              height={H + OVERLAY_PAD * 2}
              style={{
                position: 'absolute',
                left: -OVERLAY_PAD * effZoom,
                top: -OVERLAY_PAD * effZoom,
                width: (W + OVERLAY_PAD * 2) * effZoom,
                height: (H + OVERLAY_PAD * 2) * effZoom,
                cursor: spaceHeld ? 'none' : (tool === 'text' ? 'text' : (tool === 'select' ? (selMode === 'object' ? 'default' : 'crosshair') : (showBrushRing ? 'none' : 'crosshair'))),
                touchAction: 'none',
              }}
              onPointerDown={onCanvasDown}
              onPointerMove={onCanvasMove}
              onPointerUp={onCanvasUp}
              onDoubleClick={onCanvasDoubleClick}
              // Keep clicks from moving focus to the focusable wrapper: the
              // text box is mounted+focused on pointerdown, and the mousedown
              // default (focus on .livery-canvas-wrap) would blur it instantly.
              onMouseDown={(e) => e.preventDefault()}
              onContextMenu={onCanvasContextMenu}
            />
            {showBrushRing && (
              <div
                ref={cursorRingRef}
                className="lp-cursor-ring"
                style={{ width: ringDiameter, height: ringDiameter }}
              >
                <div className="lp-cursor-dot" />
              </div>
            )}
            {textAnchor && (
              <input
                autoFocus
                value={textDraft}
                placeholder={t('livery_paint_text_placeholder')}
                onChange={(e) => setTextDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { commitText(); setTool('select'); }
                  if (e.key === 'Escape') { editingIdRef.current = null; setTextAnchor(null); setTextDraft(''); }
                  e.stopPropagation();
                }}
                onBlur={() => commitText()}
                style={{
                  position: 'absolute',
                  left: textAnchor.x * effZoom,
                  top: textAnchor.y * effZoom,
                  fontSize: Math.max(10, textOpts.size * effZoom),
                  color: brushRgba(brush),
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Status bar — zoom ── */}
      <div className="lp-statusbar">
        <div className="lp-zoom">
          <button {...bind(t('livery_paint_zoom_out'))} aria-label={t('livery_paint_zoom_out')} onClick={zoomOut}><IoRemove size={16} /></button>
          <span className="lp-zoom-pct">{Math.round(effZoom * 100)}%</span>
          <button {...bind(t('livery_paint_zoom_in'))} aria-label={t('livery_paint_zoom_in')} onClick={zoomIn}><IoAddOutline size={16} /></button>
          <button className={zoom === 'fit' ? 'lp-active' : ''} {...bind(t('livery_paint_fit'))} aria-label={t('livery_paint_fit')} onClick={() => setZoom('fit')}><IoScanOutline size={16} /></button>
        </div>
      </div>
      {/* ── Right-click layer-order menu for movable objects ── */}
      {orderMenu && (() => {
        const idx = objects.findIndex(o => o && o.id === orderMenu.id);
        const atTop = idx < 0 || idx >= objects.length - 1;
        const atBottom = idx <= 0;
        const items = [
          { dir: 'front', label: t('livery_paint_to_front'), Icon: FaAnglesUp, disabled: atTop },
          { dir: 'forward', label: t('livery_paint_forward'), Icon: FaAngleUp, disabled: atTop },
          { dir: 'backward', label: t('livery_paint_backward'), Icon: FaAngleDown, disabled: atBottom },
          { dir: 'back', label: t('livery_paint_to_back'), Icon: FaAnglesDown, disabled: atBottom },
        ];
        return (
          <>
            <div
              className="lp-order-backdrop"
              onPointerDown={() => setOrderMenuTracked(null)}
              onContextMenu={(e) => { e.preventDefault(); setOrderMenuTracked(null); }}
            />
            <div
              className="lp-order-menu"
              role="menu"
              style={{ left: orderMenu.x, top: orderMenu.y }}
              onPointerDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              {items.map(({ dir, label, Icon, disabled }) => (
                <button
                  key={dir}
                  role="menuitem"
                  className="lp-order-btn"
                  aria-label={label}
                  title={label}
                  disabled={disabled}
                  onClick={(e) => { e.stopPropagation(); reorderObject(dir); }}
                >
                  <Icon size={16} />
                  <span className="lp-order-label">{label}</span>
                </button>
              ))}
            </div>
          </>
        );
      })()}
      {/* ── RGBA colour picker popover (portal, anchored to the swatch) ── */}
      {colorAnchor && (
        <LiveryColorPicker
          color={brush.color}
          opacity={brush.opacity ?? 1}
          anchor={colorAnchor}
          onChange={(patch) => setBrush({ ...brush, ...patch })}
          onClose={() => setColorAnchor(null)}
        />
      )}
      {TooltipPortal}
    </div>
  );
});

export default LiveryCanvas;
