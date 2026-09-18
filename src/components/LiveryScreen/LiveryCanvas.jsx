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
  floodFill,
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
import { TbSticker2, TbCircleDotted, TbLayersUnion, TbLayersDifference, TbLayersSelected, TbVectorSpline } from 'react-icons/tb';
import { BsMagic } from 'react-icons/bs';
import { HiDocumentDuplicate } from 'react-icons/hi';
import { MdOutlineLayersClear } from 'react-icons/md';
import { CiBookmarkRemove } from 'react-icons/ci';
import { LuFlipHorizontal, LuFlipVertical } from 'react-icons/lu';
import useTooltip from '../BrowserScreen/useTooltip';
import LiveryColorPicker from './LiveryColorPicker';
import { PANEL_GAP } from '../../utils/constants/livery';

export const TEXTURE = 2048;

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
function paintErasePreview(ctx, strokes, onlyNew) {
  if (!ctx || !strokes || strokes.length === 0) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
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

// Photoshop-style left-rail tool icons + advertised keyboard shortcuts.
const TOOL_META = {
  select: { Icon: FaArrowPointer, key: 'A' },
  brush: { Icon: IoBrushOutline, key: 'B' },
  eraser: { Icon: FaEraser, key: 'E' },
  eyedropper: { Icon: IoEyedropOutline, key: 'I' },
  fill: { Icon: IoColorFillOutline, key: 'G' },
  line: { Icon: IoRemoveOutline, key: 'L' },
  rect: { Icon: IoSquareOutline, key: 'R' },
  ellipse: { Icon: IoEllipseOutline, key: 'O' },
  text: { Icon: IoTextOutline, key: 'T' },
};

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

// Zoom ladder for the +/- buttons.
const ZOOM_STEPS = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2];

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
  return [
    o.kind, o.x, o.y, o.rot, o.flipX ? 1 : 0, o.flipY ? 1 : 0, o.w, o.h,
    o.color || '', o.width || '', o.opacity == null ? 1 : o.opacity,
    o.filled ? 1 : 0, o.size || '', o.font || '', o.bold ? 1 : 0, o.italic ? 1 : 0,
    o.text || '', imageId(o.img), pts,
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
  const initialPartsArr = (Array.isArray(initialParts) && initialParts.length)
    ? initialParts
    : [{ partName: panelNames[0], imageDataUrl: initialImageDataUrl || null }];
  const defaultPartsArr = (Array.isArray(defaultParts) && defaultParts.length)
    ? defaultParts
    : [{ partName: panelNames[0], imageDataUrl: defaultLiveryDataUrl || null }];
  const { bind, TooltipPortal } = useTooltip();
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const wrapRef = useRef(null);
  const ctxRef = useRef(null);
  const undoRef = useRef(createUndoStack());
  const spaceRef = useRef(false);
  const panRef = useRef(null);
  const handRef = useRef(null);
  const zoomAnchorRef = useRef(null);
  const strokeRef = useRef(null);
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
  const maskOutlineRef = useRef([]);
  const maskBorderRef = useRef([]);
  const lassoRef = useRef(null);
  const scratchRef = useRef(null);
  // 1×1 scratch used by the eyedropper to composite the visible pixel (base
  // raster + live objects) so movables like stickers can be picked.
  const pickCanvasRef = useRef(null);
  // Default-background image for the eraser (aircraft template, else the
  // opened base). Erasing restores these pixels — never transparent, because
  // the BaseMap replaces the model's texture (transparent = holes in-game).
  // Normalized onto a TEXTURE-sized canvas so the restore pattern aligns 1:1
  // even when the source image isn't 2048².
  const bgImgRef = useRef(null);
  const bgCanvasRef = useRef(null);
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
  // replayed onto the base + into the objects in ONE pass on release.
  const erasePreviewRef = useRef(null);
  // Per-object eraser scratch cache: id -> { canvas, ctx, lx0, ly0, sw, sh,
  // sig, applied }. `applied[i]` is how many points of erase stroke i have
  // already been punched into the canvas.
  const eraseCacheRef = useRef(new Map());
  // Cached background-restore pattern (creating a pattern per stroke segment
  // is a major erase-drag cost; the pattern is reused while ctx+canvas match).
  const bgPatternRef = useRef({ ctx: null, canvas: null, pattern: null });
  const hasMaskRef = useRef(false);
  const textOptsRef = useRef({ font: 'sans-serif', size: 120, bold: false, italic: false, color: '#000000' });
  // Clear target — the aircraft type's built-in default livery panels. Kept in
  // refs so the confirm-modal closure reads the latest value even if the
  // template finished loading after the Clear button was clicked.
  const defaultPartsRef = useRef(defaultPartsArr);
  const initialPartsRef = useRef(initialPartsArr);
  useEffect(() => { defaultPartsRef.current = defaultPartsArr; });
  useEffect(() => { initialPartsRef.current = initialPartsArr; });

  // Keep the eraser's background source loaded (template preferred, else the
  // opened base — same priority as Clear). Composed onto a canvas the size of
  // the whole multi-panel backing store so the restore pattern aligns 1:1 with
  // each panel. Defensive for stubbed Image/canvas (tests).
  useEffect(() => {
    const src = defaultPartsArr.some(p => p && p.imageDataUrl) ? defaultPartsArr : initialPartsArr;
    if (!src.some(p => p && p.imageDataUrl)) { bgImgRef.current = null; bgCanvasRef.current = null; return; }
    let cancelled = false;
    // The background canvas is created lazily on the first image load (not up
    // front) so it is not the first 2d context created — the main canvas owns
    // the base fill and callers may assume that ordering.
    let bgCanvas = null;
    const ensureCanvas = () => {
      if (bgCanvas) return bgCanvas;
      try {
        bgCanvas = document.createElement('canvas');
        bgCanvas.width = W; bgCanvas.height = H;
        const cctx = bgCanvas.getContext('2d');
        if (!cctx) { bgCanvas = null; return null; }
        fillPanelBases(cctx, layout);
        bgCanvasRef.current = bgCanvas;
      } catch (_) { bgCanvas = null; bgCanvasRef.current = null; }
      return bgCanvas;
    };
    for (let i = 0; i < panelCount; i++) {
      const url = src[i] && src[i].imageDataUrl;
      if (!url) continue;
      const idx = i;
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const c = ensureCanvas();
        if (!c) return;
        try {
          const cctx = c.getContext('2d');
          cctx.save();
          cctx.setTransform(1, 0, 0, 1, 0, 0);
          cctx.globalCompositeOperation = 'source-over';
          cctx.globalAlpha = 1;
          cctx.drawImage(img, layout.x(idx), 0, TEXTURE, TEXTURE);
          cctx.restore();
        } catch (_) {}
      };
      img.onerror = () => {};
      img.src = url;
    }
    return () => { cancelled = true; };
    // Mount-only: the parent remounts (key) whenever the base panels change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [W, H, panelCount]);

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
  const setSelMode = (v) => { selModeRef.current = v; setSelModeState(v); };
  const setMaskOp = (v) => { maskOpRef.current = v; setMaskOpState(v); };
  const setHasMask = (v) => { hasMaskRef.current = v; setHasMaskState(v); };
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
    const obj = { ...o, id: nextIdRef.current++ };
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
    const next = ZOOM_STEPS.find(z => z > cur + 1e-4);
    setZoom(next != null ? next : ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  };
  const zoomOut = () => {
    const cur = zoom === 'fit' ? fitScale : zoom;
    const next = [...ZOOM_STEPS].reverse().find(z => z < cur - 1e-4);
    setZoom(next != null ? next : ZOOM_STEPS[0]);
  };

  // ── Base init (mount only — parent remounts via key on base change) ─
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctxRef.current = ctx;
    undoRef.current = createUndoStack();
    setDirty(false);
    syncObjects([], null);
    setTextAnchor(null);
    drawBase(ctx, layout, initialPartsArr, scheduleOverlay);
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
      const dir = e.deltaY < 0 ? 1 : -1;
      const next = dir > 0
        ? (ZOOM_STEPS.find(z => z > cur + 1e-4) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
        : ([...ZOOM_STEPS].reverse().find(z => z < cur - 1e-4) ?? ZOOM_STEPS[0]);
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

  // A snapshot captures the base raster *and* the live-object layer, so undo
  // restores (or removes) objects added since the previous snapshot.
  const snapshotState = () => {
    const ctx = ctxRef.current;
    if (!ctx) return null;
    return {
      img: ctx.getImageData(0, 0, W, H),
      objects: objectsRef.current,
      selId: selIdRef.current,
    };
  };

  const pushSnapshot = () => {
    const snap = snapshotState();
    if (!snap) return;
    pushUndo(undoRef.current, snap);
    setDirty(true);
  };

  const doUndo = useCallback(() => {
    settleGesture();
    const ctx = ctxRef.current;
    if (!ctx) return;
    const prev = undoStep(undoRef.current, snapshotState());
    if (prev) {
      ctx.putImageData(prev.img, 0, 0);
      syncObjects(prev.objects || [], prev.selId == null ? null : prev.selId);
      setDirty(true);
      scheduleOverlay();
    }
  }, []);

  const doRedo = useCallback(() => {
    settleGesture();
    const ctx = ctxRef.current;
    if (!ctx) return;
    const next = redoStep(undoRef.current, snapshotState());
    if (next) {
      ctx.putImageData(next.img, 0, 0);
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
  const getScratch = () => {
    if (!scratchRef.current) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      scratchRef.current = c;
    }
    return scratchRef.current;
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
  // Magic wand: flood the contiguous base region under `p` (fill tolerance)
  // into the mask under the active combine op. The wand samples the base
  // raster (live objects are clipped separately at paint time).
  const applyWandAt = (p) => {
    const ctx = ctxRef.current;
    const mctx = getMaskCtx();
    if (!ctx || !mctx) return;
    const x = Math.max(0, Math.min(W - 1, p.x | 0));
    const y = Math.max(0, Math.min(H - 1, p.y | 0));
    const region = wandRegion(ctx.getImageData(0, 0, W, H), x, y, fillTolRef.current);
    if (!region || region.count === 0) return;
    const sc = getScratch();
    const sctx = sc.getContext('2d');
    if (!sctx) return;
    // Region spans as white runs, then composited into the mask in one shot.
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
    setHasMask(true);
    rebuildUnionBorder();
    scheduleOverlay();
  };
  // Revert every base pixel outside the mask to the pre-gesture `before`
  // pixels. All direct-to-base paints funnel here so a selection clips brush,
  // eraser, fill and duplicate stamps uniformly.
  const constrainBaseToMask = (before) => {
    if (!hasMaskRef.current || !before) return;
    const ctx = ctxRef.current;
    const mask = maskCanvasRef.current;
    if (!ctx || !mask) return;
    const mctx = mask.getContext('2d');
    if (!mctx) return;
    const cur = ctx.getImageData(0, 0, W, H);
    const m = mctx.getImageData(0, 0, W, H);
    if (constrainImageToMask(cur, before, m)) ctx.putImageData(cur, 0, 0);
  };
  // Paint one live object through the mask onto `target` (overlay + export).
  const paintObjectMasked = (target, o) => {
    const mask = maskCanvasRef.current;
    if (!mask) { paintObjectWithErase(target, o); return; }
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
    sctx.drawImage(mask, 0, 0);
    sctx.restore();
    target.drawImage(sc, 0, 0);
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
    if (!o || !o.erase || o.erase.length === 0) { paintLiveObject(target, o); return; }
    // Tight local rect: the object frame padded by the widest erase brush. The
    // hit test only records points inside frame + brush radius, so this covers
    // every point without folding the whole trail into the bounds each frame.
    let maxESize = 0;
    for (const stroke of o.erase) {
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
      if (o.erase.length < entry.applied.length) rebuild = true;
      else {
        for (let i = 0; i < entry.applied.length; i++) {
          const pts = (o.erase[i] && o.erase[i].pts) || [];
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
        sig: eraseCacheSig(o), applied: new Array(o.erase.length).fill(0),
      };
      cache.set(o.id, entry);
    }
    // Punch only the points added since the last frame. Chunked stroking with
    // round caps/joins unions to the same shape as one full-path stroke.
    const sctx = entry.ctx;
    const applied = entry.applied;
    while (applied.length < o.erase.length) applied.push(0);
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.translate(-entry.lx0, -entry.ly0);
    sctx.globalCompositeOperation = 'destination-out';
    sctx.globalAlpha = 1;
    sctx.lineCap = 'round';
    sctx.lineJoin = 'round';
    sctx.strokeStyle = '#000';
    for (let i = 0; i < o.erase.length; i++) {
      const stroke = o.erase[i];
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
    if (!o || !o.erase || o.erase.length === 0) return null;
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
  // Commit a finished eraser drag in ONE pass: restore the background along the
  // recorded trail, then route that same trail into every live object's holes.
  // The drag itself never touches the base or the objects — it only draws the
  // dark preview — so this is the only place that does O(area) work, and it
  // runs once per gesture instead of once per frame.
  const applyEraseGesture = () => {
    const prev = erasePreviewRef.current;
    erasePreviewRef.current = null;
    if (!prev || !prev.strokes || prev.strokes.length === 0) return;
    const ctx = ctxRef.current;
    if (ctx) {
      // Restore the background (default livery / white) rather than punching
      // transparent holes — a transparent BaseMap renders as holes in-game.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = eraserStrokeStyle(ctx);
      for (const st of prev.strokes) {
        const pts = st.pts || [];
        if (pts.length === 0) continue;
        ctx.lineWidth = Math.max(1, st.size || 1);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y + 0.01);
        for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
        ctx.stroke();
      }
      ctx.restore();
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
    // The base is always rewritten, even when no live object was under the
    // trail, so the gesture is always dirty.
    setDirty(true);
  };

  // ── Overlay (sticker + shape preview), rAF-throttled ───────
  const drawOverlay = useCallback(() => {
    rafRef.current = 0;
    const ov = overlayRef.current;
    if (!ov) return;
    const ctx = ov.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.restore();
    const z = effZoom || 1;
    const gap = 40 / z;
    const hr = 7 / z;
    const selIdNow = selIdRef.current;
    // Drop eraser caches for objects that no longer exist.
    const eraseCache = eraseCacheRef.current;
    if (eraseCache.size) {
      const live = new Set();
      for (const st of objectsRef.current) live.add(st.id);
      for (const id of [...eraseCache.keys()]) if (!live.has(id)) eraseCache.delete(id);
    }
    for (const st of objectsRef.current) {
      if (!hasLiveVisual(st)) continue;
      // The visual (flip applied); the selection box below is drawn in the
      // unflipped frame so its handles stay put when mirrored. With an active
      // selection the object only shows inside the mask (the object itself
      // stays whole — clipping is presentational, cleared with Deselect).
      if (hasMaskRef.current) paintObjectMasked(ctx, st);
      else paintObjectWithErase(ctx, st);
      const active = st.id === selIdNow && toolRef.current === 'select';
      if (!active) continue;
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
      drawShape(ctx, sh.tool, sh.start, sh.current, brushRef.current, shapeOptsRef.current, true);
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
    // Selection mask: ONE merged border traced from the unioned mask pixels
    // (no interior overlap), plus the live lasso draft while the pen is down.
    // Vector outlines draw only when mask readback is unavailable (tests).
    // Overlay only — the base raster is never touched here.
    const drawDashed = (trace) => {
      ctx.save();
      ctx.strokeStyle = '#6aa0ff';
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([10 / z, 8 / z]);
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
    // Multi-image layout: a divider around each panel + a blue outline on the
    // active panel so per-panel import (and where the gap is) is unambiguous.
    if (panelCount > 1) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
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
    paintErasePreview(ctx, erasePreviewRef.current && erasePreviewRef.current.strokes, false);
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

  // ── Duplicate: stamp the source onto the base, keep a nudged copy ─
  // Other live objects are left untouched (still selectable).
  const duplicateSticker = () => {
    const st = targetObject();
    const ctx = ctxRef.current;
    if (!st || !ctx) return;
    pushSnapshot();
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    paintObjectWithErase(ctx, st);
    ctx.restore();
    // A stamp is a base paint like a stroke — clip it to the selection.
    constrainBaseToMask(undoRef.current.past.length > 0
      ? undoRef.current.past[undoRef.current.past.length - 1].img
      : null);
    const nudge = Math.max(st.w, st.h) * 0.15 + 20;
    const copy = { ...st, id: nextIdRef.current++, x: st.x + nudge, y: st.y + nudge };
    // Curves own a control-point array — deep-copy it so the two objects can
    // be resized independently. Same for eraser holes.
    if (st.pts) copy.pts = st.pts.map(q => ({ x: q.x, y: q.y }));
    if (st.erase) copy.erase = st.erase.map(s => ({ size: s.size, pts: (s.pts || []).map(q => ({ x: q.x, y: q.y })) }));
    syncObjects([...objectsRef.current.filter(o => o.id !== st.id), copy], copy.id);
    setTool('select');
    setDirty(true);
    scheduleOverlay();
  };

  // ── Export (opaque base + every live object flattened) ─────
  // Flatten the base raster and the live-object layer into one canvas the size
  // of the whole backing store (with the gutter between panels).
  const flattenToCanvas = () => {
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.drawImage(canvasRef.current, 0, 0);
    // The base is already clipped at commit time; live objects are clipped
    // here so the export matches the dotted-line selection on screen.
    if (hasMaskRef.current) {
      for (const o of objectsRef.current) paintObjectMasked(ctx, o);
    } else {
      for (const o of objectsRef.current) paintObjectWithErase(ctx, o);
    }
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
    getObjectInfo: () => {
      const o = targetObject();
      if (!o) return null;
      return {
        id: o.id, kind: o.kind, x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot || 0,
        flipX: Boolean(o.flipX), flipY: Boolean(o.flipY),
        opacity: o.opacity == null ? 1 : o.opacity,
        size: o.size,
        stretch: o.stretch || null,
        frame: frameOf(o), erase: o.erase || null,
      };
    },
    isDirty: () => dirty,
  }), [dirty]);

  // ── Keyboard: shortcuts + undo/redo + Del ──────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (isTextEntry(e.target)) {
        if (e.key === 'Escape' && textAnchor) { editingIdRef.current = null; setTextAnchor(null); setTextDraft(''); }
        return;
      }
      if (e.key === ' ') { spaceRef.current = true; setSpaceHeld(true); e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        // Ctrl+D = Deselect (same as the Deselect button, then the selected
        // object) — Photoshop's deselect shortcut.
        e.preventDefault();
        if (hasMaskRef.current) clearMask();
        else if (selIdRef.current != null) { syncObjects(objectsRef.current, null); scheduleOverlay(); }
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
        // Same action as the Remove toolbar button (selection, else topmost).
        removeSticker();
        return;
      }
      if (e.key === 'Enter') {
        // A finished curve draft commits (stays in curve mode for the next one).
        if (curveRef.current && curveRef.current.pts.length >= 2) { commitCurveDraft(); return; }
        const st = getSelected();
        if (st && st.kind === 'text') { startTextEdit(st); return; }
      }
      const k = e.key.toLowerCase();
      const map = { a: 'select', b: 'brush', e: 'eraser', i: 'eyedropper', g: 'fill', l: 'line', r: 'rect', o: 'ellipse', t: 'text' };
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

  // ── Brush strokes ──────────────────────────────────────────
  // Erasing restores the default background (template/base image, else opaque
  // white) via a no-repeat pattern aligned to the texture origin — never
  // destination-out, because a transparent BaseMap renders as holes in-game.
  // The pattern is cached and resolved once per pointer event, not per
  // coalesced point: rebuilding/assigning it per segment was the erase cost.
  const eraserStrokeStyle = (ctx) => {
    const bgC = bgCanvasRef.current;
    try {
      if (typeof ctx.createPattern === 'function') {
        if (bgC) {
          const cached = bgPatternRef.current;
          if (cached.ctx !== ctx || cached.canvas !== bgC || !cached.pattern) {
            cached.ctx = ctx;
            cached.canvas = bgC;
            try { cached.pattern = ctx.createPattern(bgC, 'no-repeat'); }
            catch (_) { cached.pattern = null; }
          }
          if (cached.pattern) return cached.pattern;
        } else {
          const bg = bgImgRef.current;
          if (bg && bg.complete !== false && (bg.naturalWidth || bg.width)) {
            const p = ctx.createPattern(bg, 'no-repeat');
            if (p) return p;
          }
        }
      }
    } catch (_) { /* fall through to the flat default */ }
    return DEFAULT_BASE_COLOR;
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

  // ── Sticker hit-testing (local frame) ──────────────────────
  // Select box, handles and every hit test work in the drawn (unflipped)
  // frame — see objectLocal.
  const stickerLocal = objectLocal;

  // Eyedropper shared by the Eyedropper tool and the right-click shortcut:
  // read the visible pixel under `p` and make it the current brush colour.
  // The base raster is composited with every live object first, so the pick
  // works on movables (stickers / shapes / text) — not just the base.
  const pickColorAt = (p) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const x = Math.max(0, Math.min(W - 1, p.x | 0));
    const y = Math.max(0, Math.min(H - 1, p.y | 0));
    const objs = objectsRef.current;
    let picked = null;
    if (objs.length > 0) {
      const sctx = getPickCanvas().getContext('2d');
      if (sctx) {
        sctx.save();
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.globalCompositeOperation = 'source-over';
        sctx.globalAlpha = 1;
        sctx.clearRect(0, 0, 1, 1);
        sctx.translate(-x, -y);
        sctx.drawImage(ctx.canvas, 0, 0);
        for (const o of objs) {
          if (!hasLiveVisual(o)) continue;
          // Mirror the overlay presentation: clipped inside a selection,
          // eraser holes punched otherwise.
          if (hasMaskRef.current) paintObjectMasked(sctx, o);
          else paintObjectWithErase(sctx, o);
        }
        sctx.restore();
        const d = sctx.getImageData(0, 0, 1, 1).data;
        if (d[3] > 0) picked = rgbaToHex(d[0], d[1], d[2]);
      }
    }
    if (picked == null) {
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
    // Right-button press only selects the object under the cursor (any tool);
    // the layer-order menu itself opens on contextmenu (a full right-click,
    // press + release) so it stays open without holding the button.
    // Right-click on empty canvas keeps the old pick-pixel-colour shortcut.
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
      const hit = hitObjectAt(p);
      if (hit) {
        if (selIdRef.current !== hit.id) syncObjects(objectsRef.current, hit.id);
        scheduleOverlay();
        return;
      }
      setOrderMenuTracked(null);
      pickColorAt(p);
      return;
    }
    if (orderMenuRef.current) setOrderMenuTracked(null);
    const t = toolRef.current;
    const capture = () => { canvasRef.current.setPointerCapture && e.target.setPointerCapture(e.pointerId); };

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
      pushSnapshot();
      strokeRef.current = { last: p, erase: t === 'eraser' };
      // The brush paints into its own layer (composited with the alpha once);
      // the eraser only records its trail and shows a dark preview until the
      // pointer is released (see applyEraseGesture).
      if (t === 'brush') strokeRef.current.layer = beginStroke();
      else {
        erasePreviewRef.current = { strokes: [{ size: brushRef.current.size, pts: [p], drawn: 0 }] };
        const ov = overlayRef.current;
        if (ov) paintErasePreview(ov.getContext('2d'), erasePreviewRef.current.strokes, true);
      }
      capture();
    } else if (t === 'eyedropper') {
      pickColorAt(p);
      setTool('brush');
    } else if (t === 'fill') {
      pushSnapshot();
      const img = ctx.getImageData(0, 0, W, H);
      // Keep a pre-fill copy: the fill paints the whole connected region and
      // is clipped back to the selection afterwards.
      const before = hasMaskRef.current
        ? { width: img.width, height: img.height, data: img.data.slice() }
        : null;
      const bc = brushRef.current;
      const rgb = hexToRgba(bc.color);
      const fillCol = [rgb[0], rgb[1], rgb[2], Math.round((bc.opacity ?? 1) * 255)];
      const changed = floodFill(img, p.x | 0, p.y | 0, fillCol, fillTolRef.current);
      if (changed) { ctx.putImageData(img, 0, 0); constrainBaseToMask(before); }
      else { undoRef.current.past.pop(); }
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
          if (ov) paintErasePreview(ov.getContext('2d'), prev.strokes, true);
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
        const mode = dragRef.current.mode;
        if (mode === 'move') updateObject(st.id, { x: p.x + dragRef.current.dx, y: p.y + dragRef.current.dy });
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
      strokeRef.current = null;
      if (wasErase) applyEraseGesture();
      else flushStroke();
      endStroke();
      constrainBaseToMask(undoRef.current.past.length > 0
        ? undoRef.current.past[undoRef.current.past.length - 1].img
        : null);
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
      strokeRef.current = null;
      if (wasErase) applyEraseGesture();
      else flushStroke();
      endStroke();
      constrainBaseToMask(undoRef.current.past.length > 0
        ? undoRef.current.past[undoRef.current.past.length - 1].img
        : null);
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
            drawBase(ctxRef.current, layout, clearParts, scheduleOverlay);
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
              <span className="lp-val">{brush.size}</span>
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
                <button className={selMode === 'object' ? 'lp-on' : ''} {...bind(t('livery_paint_select_object'))} aria-label={t('livery_paint_select_object')} aria-pressed={selMode === 'object'} onClick={() => setSelMode('object')}><FaArrowPointer size={15} /></button>
                <button className={selMode === 'pen' ? 'lp-on' : ''} {...bind(t('livery_paint_select_pen'))} aria-label={t('livery_paint_select_pen')} aria-pressed={selMode === 'pen'} onClick={() => setSelMode('pen')}><TbCircleDotted size={15} /></button>
                <button className={selMode === 'wand' ? 'lp-on' : ''} {...bind(t('livery_paint_select_wand'))} aria-label={t('livery_paint_select_wand')} aria-pressed={selMode === 'wand'} onClick={() => setSelMode('wand')}><BsMagic size={15} /></button>
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
                  <input type="range" min={0} max={255} value={fillTol} onChange={(e) => { fillTolRef.current = Number(e.target.value); setFillTolState(fillTolRef.current); }} />
                  <span className="lp-val">{fillTol}</span>
                </label>
              )}
              <span className="lp-seg">
                <button {...bind(t('livery_paint_deselect'))} aria-label={t('livery_paint_deselect')} disabled={!hasMask} onClick={clearMask}><MdOutlineLayersClear size={15} /></button>
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
                  <span className="lp-val">{stickerOpacityPct}%</span>
                </label>
              )}
            </>
          )}
          {tool === 'fill' && (
            <>
              <label className="lp-field">{t('livery_paint_tolerance')}
                <input type="range" min={0} max={255} value={fillTol} onChange={(e) => { fillTolRef.current = Number(e.target.value); setFillTolState(fillTolRef.current); }} />
                <span className="lp-val">{fillTol}</span>
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
                <span className="lp-val">{shapeOpts.width}</span>
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
                <span className="lp-val">{shownText.size}</span>
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

      {/* ── Panel strip — picks the active part (multi-image types only) ── */}
      {panelCount > 1 && (
        <div className="lp-panels" role="tablist" aria-label={t('livery_paint_panels')}>
          {panelNames.map((name, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === active}
              className={'lp-panel-tab' + (i === active ? ' lp-on' : '')}
              onClick={() => { if (onActivePanel) onActivePanel(i); }}
            >{name || `#${i + 1}`}</button>
          ))}
        </div>
      )}

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
            <button className="lp-tool" {...bind(t('livery_paint_import_sticker'))} aria-label={t('livery_paint_import_sticker')} onClick={importSticker}><TbSticker2 size={18} /></button>
            <button className="lp-tool" {...bind(t('livery_paint_duplicate_sticker'))} aria-label={t('livery_paint_duplicate_sticker')} disabled={objects.length === 0} onClick={duplicateSticker}><HiDocumentDuplicate size={18} /></button>
            <button className="lp-tool" {...bind(t('livery_paint_flip_h'))} aria-label={t('livery_paint_flip_h')} disabled={objects.length === 0} onClick={() => flipSticker('flipX')}><LuFlipHorizontal size={18} /></button>
            <button className="lp-tool" {...bind(t('livery_paint_flip_v'))} aria-label={t('livery_paint_flip_v')} disabled={objects.length === 0} onClick={() => flipSticker('flipY')}><LuFlipVertical size={18} /></button>
            <button className="lp-tool lp-danger" {...bind(t('livery_paint_delete_sticker'))} aria-label={t('livery_paint_delete_sticker')} disabled={objects.length === 0} onClick={removeSticker}><CiBookmarkRemove size={18} /></button>
          </div>
          <div className="lp-rail-sep" />
          <div className="lp-rail-group">
            <button className="lp-tool" {...bind(t('livery_paint_undo'))} aria-label={t('livery_paint_undo')} onClick={doUndo} disabled={undoRef.current.past.length === 0}><IoArrowUndoOutline size={18} /></button>
            <button className="lp-tool" {...bind(t('livery_paint_redo'))} aria-label={t('livery_paint_redo')} onClick={doRedo} disabled={undoRef.current.future.length === 0}><IoArrowRedoOutline size={18} /></button>
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
          <div className="lp-canvas-stage" style={{ width: W * effZoom, height: H * effZoom }} onPointerMove={showBrushRing ? moveCursorRing : undefined} onPointerDown={showBrushRing ? moveCursorRing : undefined} onPointerLeave={showBrushRing ? hideCursorRing : undefined}>
            <canvas
              ref={canvasRef}
              width={W}
              height={H}
              style={{ width: W * effZoom, height: H * effZoom, cursor: spaceHeld ? 'none' : (tool === 'text' ? 'text' : (tool === 'select' ? (selMode === 'object' ? 'default' : 'crosshair') : (showBrushRing ? 'none' : 'crosshair'))), touchAction: 'none' }}
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
            <canvas
              ref={overlayRef}
              width={W}
              height={H}
              style={{ position: 'absolute', left: 0, top: 0, width: W * effZoom, height: H * effZoom, pointerEvents: 'none' }}
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
