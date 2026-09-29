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
  regionMask,
  maskToImageData,
  UV_GROW_PX,
} from '../../utils/liveryUv';
import { objectAABB, collectSnapLines, snapBox, snapPoint } from '../../utils/liverySnap';
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
  IoEyeOutline,
  IoEyeOffOutline,
  IoChevronForwardOutline,
  IoChevronDownOutline,
  IoTrashOutline,
  IoPencilOutline,
  IoFolderOutline,
  IoLockClosed,
  IoLinkOutline,
  IoUnlinkOutline,
} from 'react-icons/io5';
import { AiOutlineClear } from 'react-icons/ai';
import { FaEraser, FaRegHandPaper } from 'react-icons/fa';
import { FaArrowPointer } from 'react-icons/fa6';
import { TbSticker2, TbLayersUnion, TbLayersDifference, TbLayersSelected, TbVectorSpline } from 'react-icons/tb';
import { BsMagic } from 'react-icons/bs';
import { HiDocumentDuplicate } from 'react-icons/hi';
import { MdOutlineLayersClear, MdBlurOn } from 'react-icons/md';
import { CiBookmarkRemove } from 'react-icons/ci';
import { LuFlipHorizontal, LuFlipVertical, LuLasso } from 'react-icons/lu';
import useTooltip from '../BrowserScreen/useTooltip';
import LiveryColorPicker from './LiveryColorPicker';
import { PANEL_GAP } from '../../utils/constants/livery';

export const TEXTURE = 2048;

// Sentinel clip base: the locked base aircraft image. A clipped layer with no
// editable layer beneath it is masked by the base texture's alpha.
export const CLIP_BASE_ROOT = '__base__';

// Per-layer opacity (0..1, default 1), independent of the binary visible flag.
// Opacity only affects COMPOSITING (screen CSS opacity + export/sampling
// globalAlpha blits) — the layer's own rasters/objects are never modified, so
// fading to 0 and back to 100% restores the original shape pixel-identically.
export function normalizeLayerOpacity(v) {
  const n = Number(v);
  if (!isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

// Brush edge hardness (0..1, default 1 = fully hard). A single continuous value
// drives both brush modes: the paint brush maps it to a proportional shadow blur
// (a soft halo past the stroke), the Blur pen to the width of its solid core
// before the radial falloff. 1 = crisp edge, 0 = fully feathered.
export function normalizeBrushHardness(v) {
  const n = Number(v);
  if (!isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

// Apply the brush edge softness to a 2D context about to stroke the paint
// brush. A hard brush (hardness 1) gets no shadow; softer brushes get a
// proportional shadow halo (0 = the old fully-soft brush, `size/2`). A no-op at
// hardness 1 keeps the crisp-edge output pixel-identical to before.
export function applyBrushEdge(c, b) {
  if (!c || !b) return;
  const soft = (1 - normalizeBrushHardness(b.hardness)) * ((b.size || 0) / 2);
  if (soft > 0) { c.shadowColor = b.color; c.shadowBlur = soft; }
}

// Layer-preview thumbnail size (CSS px + backing store) and its refresh cadence
// — a deliberately low sample rate so live painting never pays for it.
export const LAYER_THUMB_SIZE = 50;
export const LAYER_THUMB_INTERVAL_MS = 2000;

// The overlay canvas is padded beyond the backing store so a live object's
// selection box + handles stay visible once the object is dragged off the
// canvas edge — the object's own pixels are clipped to the base bitmap, the
// selection chrome is not.
export const OVERLAY_PAD = 256;

// Movable snapping aperture, in SCREEN pixels. Converted to texture units with
// the live zoom (`SNAP_SCREEN_PX / z`) so the snap feels the same whether the
// canvas is zoomed in or out. Guides are the canvas boundary/mid lines plus
// every other movable's box edges and mid lines (see utils/liverySnap).
export const SNAP_SCREEN_PX = 8;

// Movable rotation soft-snap aperture: free rotation, but angles within this
// distance of a 90° multiple suggest-snap onto it (Alt bypasses entirely).
export const ROT_SNAP_DEG = 5;

// Opaque fallback base for a new/cleared canvas. The BaseMap replaces the
// model's own texture, so a transparent background would render as holes.
export const DEFAULT_BASE_COLOR = '#ffffff';

// Neutral gutter painted between the panels of a multi-image aircraft so the
// gap reads as "not part of either texture" and is obviously unexported.
export const GAP_FILL = '#2a2f36';

// Dim painted over texels the mesh never samples (dead UV space) and over every
// inactive panel while the UV-region lock is on, so the editable island reads at
// a glance. Purely an overlay tint — the base/rasters are never touched.
export const UV_DIM_COLOR = 'rgba(16,20,26,0.55)';

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

// The Brush rail icon advertises its two modes the same way: paint and the
// colour-mixing Blur pen.
const BrushToolIcon = ({ size = 18 }) => (
  <span className="lp-select-icon" aria-hidden="true">
    <IoBrushOutline size={Math.max(8, size - 7)} />
    <span className="lp-select-icon-sep">/</span>
    <MdBlurOn size={Math.max(8, size - 7)} />
  </span>
);

// Photoshop-style left-rail tool icons + advertised keyboard shortcuts.
const TOOL_META = {
  select: { Icon: SelectToolIcon, key: 'A' },
  brush: { Icon: BrushToolIcon, key: 'B' },
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

// True when a live object has a drawable/exportable payload.
function hasLiveVisual(o) {
  if (!o) return false;
  if (o.kind === 'text') return Boolean(o.text);
  if (SHAPE_KINDS.includes(o.kind)) return o.w > 0 || o.h > 0;
  return Boolean(o.img);
}

// ── Layer sidecar (de)serialization ────────────────────────
// A live object is persisted as plain JSON; its bitmap `img` and stamped
// selection `clipMask` canvas are carried as data URLs so a livery round-trips
// losslessly across Save → reopen. `id`s are dropped (reassigned on load).
export function serializeLayerObject(o) {
  if (!o) return null;
  const { img, clipMask, id, ...rest } = o;
  const out = { ...rest };
  if (kindHasImage(o) && img && img.src) out.imageDataUrl = img.src;
  if (clipMask && typeof clipMask.toDataURL === 'function') {
    try { out.clipMaskDataUrl = clipMask.toDataURL('image/png'); } catch (_) { /* ignore */ }
  }
  return out;
}
function kindHasImage(o) {
  return o.kind !== 'text' && !SHAPE_KINDS.includes(o.kind);
}
// Rebuild a live object from its serialized form. `assignId` hands out a fresh
// live-object id; `makeCanvas(w,h)` creates the clip-mask canvas lazily.
export function deserializeLayerObject(raw, assignId, W, H) {
  if (!raw || typeof raw !== 'object') return null;
  const { imageDataUrl, clipMaskDataUrl, ...rest } = raw;
  const o = { ...rest, id: assignId() };
  if (imageDataUrl) {
    const img = new Image();
    img.src = imageDataUrl;
    o.img = img;
  }
  if (clipMaskDataUrl) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const cc = c.getContext('2d');
    const im = new Image();
    im.onload = () => { try { if (cc) cc.drawImage(im, 0, 0); } catch (_) { /* ignore */ } };
    im.src = clipMaskDataUrl;
    o.clipMask = c;
  }
  return o;
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
//
// The pivot is captured on the object at flip time (`flipPivot`) rather than
// read from the LIVE frame: erasing re-frames the boundary, so a flipped object
// that is then erased would otherwise have its mirror axis move under it and
// the visible remainder would jump (a small shift for a partial erase). Objects
// flipped before the pivot was stored fall back to the live frame centre.
export function flipOffset(o) {
  const f = frameOf(o);
  const sx = o && o.flipX ? -1 : 1;
  const sy = o && o.flipY ? -1 : 1;
  const px = o && o.flipPivot ? o.flipPivot.x : (f.x0 + f.x1) / 2;
  const py = o && o.flipPivot ? o.flipPivot.y : (f.y0 + f.y1) / 2;
  return {
    x: px * (1 - sx),
    y: py * (1 - sy),
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

// Per-axis resize factors for a Select corner drag, measured about the box's
// TOP-LEFT corner (the anchor). The top-left is pinned while the bottom-right
// handle is dragged, so a scale only grows the object toward the right/down —
// the anchor never moves. Held Shift keeps the aspect ratio (one factor for
// both axes); free, each axis follows the pointer so w/h stretch independently.
// Factors are clamped to a small positive floor: dragging back past the anchor
// collapses to the floor instead of mirroring through it. `o` must be the
// object as it was when the drag STARTED (its x/y/rot/frame are the fixed
// reference frame — the live object's origin moves during the drag). Pure —
// exported for tests.
export function resizeFactors(o, startP, p, shift) {
  const f = frameOf(o);
  const A = { x: f.x0, y: f.y0 };
  const S = objectLocal(o, startP);
  const L = objectLocal(o, p);
  const dx0 = S.x - A.x, dy0 = S.y - A.y;
  const dx1 = L.x - A.x, dy1 = L.y - A.y;
  if (shift) {
    const startDist = Math.max(1, Math.hypot(dx0, dy0));
    const k = Math.max(0.02, Math.hypot(dx1, dy1) / startDist);
    return { kx: k, ky: k };
  }
  return {
    kx: Math.max(0.02, Math.abs(dx0) > 0.001 ? dx1 / dx0 : 1),
    ky: Math.max(0.02, Math.abs(dy0) > 0.001 ? dy1 / dy0 : 1),
  };
}

// World position of the object's origin after a top-left-anchored scale by
// (kx, ky). Scaling the stored local geometry by those factors keeps the origin
// put; pinning the box's top-left instead shifts the origin by the anchor's
// own scaled displacement (`A · (1 − k)`, rotated into world). `o` is the
// START object (see resizeFactors). Pure — exported for tests.
export function resizeOrigin(o, kx, ky) {
  const f = frameOf(o);
  const c = { x: f.x0 * (1 - kx), y: f.y0 * (1 - ky) };
  const cos = Math.cos(o.rot || 0);
  const sin = Math.sin(o.rot || 0);
  return { x: o.x + c.x * cos - c.y * sin, y: o.y + c.x * sin + c.y * cos };
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
  { panels, initialParts, defaultParts, activePanel, onActivePanel, initialImageDataUrl, defaultLiveryDataUrl, initialLayers = null, onDirty, inputDisabled = false,
    uvLock = false, uvRegions = null, uvGlow = null },
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
  // Layer stack (bottom → top): base aircraft image (locked) → one editable
  // LAYER per stack entry → chrome (`overlayRef`: selection outline, handles,
  // previews, interaction surface). Each editable layer owns its own raster
  // fill (`fillCtxRef`, under its movables), live movables (`objectsCanvas`) and
  // raster pen/eraser (`canvasRef`/`ctxRef`, above its movables). `ctxRef`,
  // `fillCtxRef`, `canvasRef` and `fillCanvasRef` always alias the ACTIVE
  // layer, so every paint/selection path stays bounded to it.
  const baseCanvasRef = useRef(null);
  const baseCtxRef = useRef(null);
  const fillCanvasRef = useRef(null);
  const fillCtxRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const wrapRef = useRef(null);
  const ctxRef = useRef(null);
  // ── Layer model ──────────────────────────────────────────────
  // `layersRef` is the ordered (bottom → top) source of truth: each record owns
  // its serializable metadata, its live object list and the offscreen DOM canvas
  // elements + 2d contexts for its fill / objects / paint rasters. `layersView`
  // mirrors only the metadata into React state so the layer panel re-renders on
  // rename / hide / group / reorder without touching the canvases. `activeId`
  // selects which layer edits + selection target.
  const layerIdSeqRef = useRef(1);
  const folderIdSeqRef = useRef(1);
  const makeLayer = (name) => ({
    id: `ly${layerIdSeqRef.current++}`,
    name: name || `Layer ${layerIdSeqRef.current - 1}`,
    visible: true,
    opacity: 1,
    // A clipped layer is masked by the alpha of the first NON-clipped layer
    // below it (or the locked base) — Photoshop-style clipping mask. The
    // layer's own rasters/objects are always preserved, so unclipping brings
    // every edit back untouched.
    clipped: false,
    objects: [],
    paintImg: null,
    fillImg: null,
  });
  const layersRef = useRef(null);
  if (!layersRef.current || layersRef.current.length === 0) layersRef.current = [makeLayer('Layer 1')];
  const activeIdRef = useRef(layersRef.current[0].id);
  // `panelRef` is the ordered panel tree (top→bottom): each node is either
  // `{type:'layer', id}` or `{type:'folder', id, name, children:[layerId,...]}`.
  // Folders are first-class and keep their position when layers move in/out.
  // `layersRef` is the flat bottom→top z-order derived from the tree.
  const panelRef = useRef(null);
  if (!panelRef.current || panelRef.current.length === 0) panelRef.current = [{ type: 'layer', id: layersRef.current[0].id }];
  const panelSnapshot = () => panelRef.current.map(n => (n.type === 'layer'
    ? { type: 'layer', id: n.id }
    : { type: 'folder', id: n.id, name: n.name, visible: n.visible !== false, children: [...n.children] }));
  const [layersView, setLayersView] = useState(() => layersRef.current.map(l => ({ id: l.id, name: l.name, visible: l.visible, opacity: normalizeLayerOpacity(l.opacity), clipped: l.clipped })));
  const [panelView, setPanelView] = useState(() => panelSnapshot());
  const [activeId, setActiveIdState] = useState(activeIdRef.current);
  const setActiveId = (id) => { activeIdRef.current = id; setActiveIdState(id); };
  const syncLayersView = () => {
    setLayersView(layersRef.current.map(l => ({ id: l.id, name: l.name, visible: l.visible, opacity: normalizeLayerOpacity(l.opacity), clipped: l.clipped })));
    setPanelView(panelSnapshot());
  };
  // Rebuild the flat bottom→top z-order from the panel tree (top→bottom).
  const syncLayerOrder = () => {
    const topDown = [];
    for (const n of panelRef.current) {
      if (n.type === 'layer') topDown.push(n.id);
      else for (const cid of n.children) topDown.push(cid);
    }
    const byId = new Map(layersRef.current.map(l => [l.id, l]));
    layersRef.current = topDown.slice().reverse().map(id => byId.get(id)).filter(Boolean);
  };
  const folderNodeById = (id) => panelRef.current.find(n => n.type === 'folder' && n.id === id) || null;
  // Locate a layer node: at root or inside a folder. Returns its container
  // (array) + index so it can be moved without disturbing other folders.
  const findLayerSlot = (id) => {
    for (let i = 0; i < panelRef.current.length; i++) {
      const n = panelRef.current[i];
      if (n.type === 'layer' && n.id === id) return { container: panelRef.current, index: i, folder: null };
      if (n.type === 'folder') {
        const ci = n.children.indexOf(id);
        if (ci >= 0) return { container: n.children, index: ci, folder: n };
      }
    }
    return null;
  };
  // A layer is effectively visible only when its own flag AND its folder's flag
  // are on. Every render / export / sample path uses this.
  const layerEffectiveVisible = (id) => {
    const l = layerById(id);
    if (!l || !l.visible) return false;
    const slot = findLayerSlot(id);
    return !(slot && slot.folder && slot.folder.visible === false);
  };
  const folderVisible = (node) => !(node && node.visible === false);
  // Clip base resolution in flat bottom→top z-order: the nearest layer BELOW
  // `id` that is not itself clipped. When there is none (a clipped bottom
  // layer) the locked base image is the mask source. Returns null when `id` is
  // not clipped (no mask).
  const clipBaseFor = (id) => {
    const layer = layerById(id);
    if (!layer || !layer.clipped) return null;
    const i = layersRef.current.indexOf(layer);
    for (let j = i - 1; j >= 0; j--) {
      if (!layersRef.current[j].clipped) return layersRef.current[j].id;
    }
    return CLIP_BASE_ROOT;
  };
  // 50×50 layer previews, keyed by layer id via callback refs.
  const thumbElsRef = useRef(new Map());
  const bindThumbEl = (id) => (el) => {
    if (el) thumbElsRef.current.set(id, el);
    else thumbElsRef.current.delete(id);
  };
  // Canvas elements + contexts per layer, keyed by layer id. Contexts are
  // acquired once per canvas (the same stub every read) so incremental drawing
  // and the tests' first-context lookup agree.
  const layerElsRef = useRef(new Map());
  const layerCtxsRef = useRef(new Map());
  const pendingLayersRef = useRef(null);
  // A structural undo/redo whose snapshot recreated a layer leaves that layer's
  // rasters to paint into the canvas AFTER React mounts it (next commit). Set by
  // `applySnapshot`, drained by the active-layer layout effect.
  const pendingRestoreRef = useRef(null);
  const layerEl = (id, kind) => {
    const rec = layerElsRef.current.get(id);
    return rec ? rec[kind] || null : null;
  };
  const bindLayerEl = (id, kind) => (el) => {
    const rec = layerElsRef.current.get(id) || {};
    rec[kind] = el;
    layerElsRef.current.set(id, rec);
  };
  const ctxFor = (id, kind) => {
    let rec = layerCtxsRef.current.get(id);
    if (!rec) { rec = {}; layerCtxsRef.current.set(id, rec); }
    if (rec[kind]) return rec[kind];
    const el = layerEl(id, kind);
    if (!el) return null;
    rec[kind] = el.getContext('2d');
    return rec[kind];
  };
  const layerById = (id) => layersRef.current.find(l => l.id === id) || null;
  const activeLayer = () => layerById(activeIdRef.current) || layersRef.current[0] || null;
  // A layer is paintable/selectable only while visible (its own flag AND its
  // folder's); hidden layers are shown in the panel but excluded from render,
  // export and sampling.
  const visibleLayers = () => layersRef.current.filter(l => layerEffectiveVisible(l.id));
  const anyVisibleLayer = () => layersRef.current.some(l => layerEffectiveVisible(l.id));
  // The object list shown/edited is the ACTIVE layer's; a change writes straight
  // back into that layer's record.
  const setActiveLayerObjects = (objs) => {
    const layer = activeLayer();
    if (!layer) return;
    layer.objects = objs;
    objectsRef.current = objs;
  };
  // Point the active-layer aliases (`ctxRef`/`fillCtxRef`/`canvasRef`/
  // `fillCanvasRef`) at the active layer's canvases + contexts.
  const bindActiveLayerRefs = () => {
    const id = activeIdRef.current;
    canvasRef.current = layerEl(id, 'paint');
    fillCanvasRef.current = layerEl(id, 'fill');
    ctxRef.current = ctxFor(id, 'paint');
    fillCtxRef.current = ctxFor(id, 'fill');
  };
  // Per-layer raster snapshots. Cached by reference until the layer is mutated
  // so consecutive undo snapshots share an unchanged layer's ImageData.
  const captureLayerPixels = (layer) => {
    if (!layer) return { paintImg: null, fillImg: null };
    if (!layer.paintImg) {
      const c = ctxFor(layer.id, 'paint');
      if (c) { try { layer.paintImg = c.getImageData(0, 0, W, H); } catch (_) { /* stub */ } }
    }
    if (!layer.fillImg) {
      const c = ctxFor(layer.id, 'fill');
      if (c) { try { layer.fillImg = c.getImageData(0, 0, W, H); } catch (_) { /* stub */ } }
    }
    return { paintImg: layer.paintImg, fillImg: layer.fillImg };
  };
  const invalidateLayerPixels = (layer) => {
    if (!layer) return;
    layer.paintImg = null;
    layer.fillImg = null;
  };
  const invalidateActivePixels = () => invalidateLayerPixels(activeLayer());
  // Last captured base-image pixels, shared by undo snapshots so a snapshot
  // never copies the (static) base per step.
  const basePixelsRef = useRef(null);
  const undoRef = useRef(createUndoStack());
  const spaceRef = useRef(false);
  const panRef = useRef(null);
  // Mirrors `inputDisabled` for handlers/effects captured before a re-render.
  // While the Workshop upload dialog owns the screen NOTHING the painter owns
  // may react — pointer, wheel or keyboard.
  const inputDisabledRef = useRef(inputDisabled);
  inputDisabledRef.current = inputDisabled;
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
  // Guide lines the active move/scale gesture is snapped to ({x, y} world
  // coords, null per axis). Overlay-only feedback; cleared when the drag ends.
  const snapGuidesRef = useRef(null);
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
  const brushRef = useRef({ color: '#ff0000', size: 12, opacity: 1, hardness: 1 });
  const shapeOptsRef = useRef({ width: 8, filled: true });
  // Line tool stroke mode: 'straight' (drag) or 'curve' (click points).
  const lineModeRef = useRef('straight');
  const fillTolRef = useRef(32);
  // Select-tool sub-mode: 'object' (move/scale/rotate) vs the selection-mask
  // builders 'pen' (freehand lasso) and 'wand' (tolerance flood).
  const selModeRef = useRef('object');
  // Brush sub-mode: 'paint' (normal colour brush) vs 'blur' (the colour-mixing
  // Blur pen, which samples the visible stack and paints only the average).
  const brushModeRef = useRef('paint');
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
  // Bound-to-the-brush scratch for the Blur (colour-mix) pen: it composites the
  // visible stack around one dab so the disc average can be read back. Sized to
  // the current brush box and reused across dabs.
  const blurCanvasRef = useRef(null);
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
  // ── UV regions ─────────────────────────────────────────────
  // The mesh UV coverage is passed in per BaseMap panel (`uvRegions`). The lock
  // clips raster edits to the ACTIVE panel's mapped texels (dead space locked).
  // A 3D-preview click sets `uvGlow` ({ panel, id }) and we tint that atlas
  // region on the overlay — informational only, never an edit restriction.
  const uvLockRef = useRef(uvLock);
  uvLockRef.current = uvLock;
  const uvRegionsRef = useRef(uvRegions);
  uvRegionsRef.current = uvRegions;
  const uvGlowRef = useRef(uvGlow);
  uvGlowRef.current = uvGlow;
  const uvMaskCanvasRef = useRef(null);
  const uvCoverageCanvasRef = useRef(null);
  const uvDimCanvasRef = useRef(null);
  const uvGlowOutlineRef = useRef([]);
  const uvConstraintRef = useRef(false);
  // Coverage masks are expensive (a 2048² scan) and don't change while a region
  // object is alive, so cache them by region. A new `uvRegions` array produces
  // new region objects and lets the old ones GC.
  const uvCoverageCacheRef = useRef(new WeakMap());
  const textOptsRef = useRef({ font: 'sans-serif', size: 120, bold: false, italic: false, color: '#000000' });
  // Clear target — the aircraft type's built-in default livery panels. Kept in
  // refs so the confirm-modal closure reads the latest value even if the
  // template finished loading after the Clear button was clicked.
  const defaultPartsRef = useRef(defaultPartsArr);
  const initialPartsRef = useRef(initialPartsArr);
  useEffect(() => { defaultPartsRef.current = defaultPartsArr; });
  useEffect(() => { initialPartsRef.current = initialPartsArr; });

  const [tool, setToolState] = useState('brush');  const [brush, setBrushState] = useState(brushRef.current);
  const [shapeOpts, setShapeOptsState] = useState(shapeOptsRef.current);
  const [lineMode, setLineModeState] = useState('straight');
  const [fillTol, setFillTolState] = useState(32);
  const [selMode, setSelModeState] = useState('object');
  const [brushMode, setBrushModeState] = useState('paint');
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
  // ── Layer panel UI state ───────────────────────────────────
  // `layersView`/`foldersView` (declared with the layer model) drive the panel;
  // these track transient inline-edit, folder-collapse and drag state.
  const [editingLayerId, setEditingLayerId] = useState(null);
  const [layerNameDraft, setLayerNameDraft] = useState('');
  const [editingFolderId, setEditingFolderId] = useState(null);
  const [folderNameDraft, setFolderNameDraft] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set());
  // Drag-and-drop: `dragItemRef` holds the dragged `{kind:'layer'|'folder',id}`
  // and `dragOverKey` pins the visual drop indicator (`${kind}:${id}:${pos}`).
  const dragItemRef = useRef(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  // The locked base texture preview canvas.
  const baseThumbRef = useRef(null);
  const binderCacheRef = useRef(new Map());
  // Custom RGBA picker anchor ({ x, y } in client coords) while its popover is
  // open, or null. Positioned in a portal because the tool rail scrolls.
  const [colorAnchor, setColorAnchor] = useState(null);
  const colorSwatchRef = useRef(null);
  // Mirror the text-entry state in refs so commitText() can read the live
  // values from blur / tool-switch / canvas handlers without stale closures.
  const textAnchorRef = useRef(null);
  const textDraftRef = useRef('');

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
  // Brush-mode mirrors (ref so canvas handlers never read a stale closure).
  const setBrushMode = (v) => { brushModeRef.current = v; setBrushModeState(v); };
  const setMaskOp = (v) => { maskOpRef.current = v; setMaskOpState(v); };
  const setHasMask = (v) => { hasMaskRef.current = v; setHasMaskState(v); };
  const setFillTol = (v) => { fillTolRef.current = v; setFillTolState(v); };
  // Object layer helpers — refs mirror the state so canvas handlers read the
  // latest objects without stale closures. The list belongs to the ACTIVE layer.
  const syncObjects = (objs, sid) => {
    setActiveLayerObjects(objs);
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
  // Live mirror of `effZoom`, read by `drawOverlay`. A rAF scheduled before a
  // fit-scale/zoom change would otherwise run the previous `drawOverlay` closure
  // and paint the chrome (handle-dot radius `7/z`, rotate gap `40/z`) at the old
  // zoom while the canvas has already been CSS-scaled to the new one — the
  // selection box still lands right but the handle dots come out the wrong size
  // until the next redraw. Reading the ref makes any pending frame use the
  // current zoom.
  const effZoomRef = useRef(effZoom);
  effZoomRef.current = effZoom;

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

  // ── Movable snapping ───────────────────────────────────────
  // The canvas guides: each panel's left/centre/right edges for the vertical
  // lines, plus the texture top/middle/bottom for the horizontal ones. A
  // single-image canvas is just 0 / 1024 / 2048.
  const canvasSnapLines = () => {
    const xs = [];
    for (let i = 0; i < panelCount; i++) {
      const x0 = layout.x(i);
      xs.push(x0, x0 + TEXTURE / 2, x0 + TEXTURE);
    }
    return { xs, ys: [0, H / 2, H] };
  };
  // Screen-constant aperture expressed in texture units at the live zoom.
  const snapThreshold = () => SNAP_SCREEN_PX / (effZoomRef.current || 1);
  // Guide lines for the gesture: every other movable's box edges + mid lines,
  // plus the canvas lines. Snapping is bypassed while Alt is held.
  const snapLinesFor = (excludeId) => {
    const base = canvasSnapLines();
    return collectSnapLines(objectsRef.current, excludeId, base.xs, base.ys);
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
    // Point the active-layer aliases at the freshly mounted canvases. The first
    // getContext must be the active layer's paint canvas (incremental drawing
    // and the canvas lookups then agree).
    bindActiveLayerRefs();
    if (!canvasRef.current && !fillCanvasRef.current) return;
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
    setDirty(false);
    // Every layer starts empty on a fresh mount (the base image lives on its own).
    for (const l of layersRef.current) {
      l.objects = [];
      invalidateLayerPixels(l);
      for (const c of [ctxFor(l.id, 'paint'), ctxFor(l.id, 'fill')]) {
        if (!c) continue;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, W, H);
      }
    }
    syncObjects(activeLayer().objects, null);
    setTextAnchor(null);
    // With a persisted layer sidecar the base texture is restored from it (see
    // the initial-layers effect) — never paint the saved flattened BaseMap over
    // it, which would double-composite the layers.
    const hasInitialLayers = Boolean(initialLayers && Array.isArray(initialLayers.layers) && initialLayers.layers.length);
    if (baseCtx && !hasInitialLayers) drawBase(baseCtx, layout, initialPartsArr, onBaseDone);
    scheduleOverlay();
    // Mount-only: the parent remounts (key) whenever the base changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Active layer / structural changes ──────────────────────
  // Re-point the active-layer aliases (ctxRef/fillCtxRef/canvasRef) and mirror
  // the active layer's object list into state whenever the active layer or the
  // layer set changes (add / delete / reorder / visibility). Runs after every
  // commit so freshly mounted layer canvases are already bound.
  useLayoutEffect(() => {
    const layer = layerById(activeIdRef.current);
    if (!layer) return;
    bindActiveLayerRefs();
    objectsRef.current = layer.objects;
    setObjectsState(layer.objects);
    // A just-loaded sidecar's rasters/base are applied now that every layer's
    // canvases are mounted and bound.
    const pending = pendingLayersRef.current;
    if (pending) {
      pendingLayersRef.current = null;
      applyLoadedLayers(pending);
    }
    // A structural undo/redo that recreated layer(s): their canvases are mounted
    // now, so paint the snapshot's rasters into them.
    const pendingRestore = pendingRestoreRef.current;
    if (pendingRestore) {
      pendingRestoreRef.current = null;
      for (const ls of pendingRestore.layers) {
        const l = layerById(ls.id);
        if (l) writeLayerPixels(l, ls.paintImg, ls.fillImg);
      }
    }
    scheduleOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, layersView]);

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
      if (inputDisabledRef.current) return;
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

  // Per-layer raster snapshots are cached on the layer record (see
  // `captureLayerPixels`). `invalidateFillPixels` is the name every raster
  // mutation already calls; it now clears the ACTIVE layer's cached paint + fill
  // so the next snapshot re-reads the changed pixels (and untouched layers keep
  // sharing their ImageData across snapshots).
  const invalidateFillPixels = () => invalidateLayerPixels(activeLayer());

  // A snapshot captures the WHOLE document: every layer's metadata (name,
  // visibility, opacity, clip), object list and raster pixels (paint + fill), plus the
  // panel tree (folders + order) and the active layer. So Ctrl+Z rebuilds
  // content AND structure — new/deleted layers, folder moves, reordering,
  // clipping and hiding all round-trip. The base image is stored by shared
  // reference (it only changes on Clear/import) and unchanged layers share their
  // cached ImageData, so a snapshot never copies a static layer.
  const snapshotState = () => {
    if (!ctxRef.current && !fillCtxRef.current) return null;
    const layers = layersRef.current.map(l => ({
      id: l.id, name: l.name, visible: l.visible, opacity: normalizeLayerOpacity(l.opacity), clipped: !!l.clipped,
      objects: l.objects, ...captureLayerPixels(l),
    }));
    return {
      base: basePixelsRef.current,
      activeId: activeIdRef.current,
      layers,
      panel: panelSnapshot(),
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

  // Write one layer's raster pixels into its canvases (when mounted) and keep
  // its caches aligned with what is now live. A freshly recreated layer's
  // canvases mount on the NEXT commit, so its pixels are applied by the layout
  // effect via `pendingRestoreRef`.
  const writeLayerPixels = (layer, paintImg, fillImg) => {
    if (paintImg) {
      const c = ctxFor(layer.id, 'paint');
      try { if (c) c.putImageData(paintImg, 0, 0); } catch (_) {}
    }
    if (fillImg) {
      const c = ctxFor(layer.id, 'fill');
      try { if (c) c.putImageData(fillImg, 0, 0); } catch (_) {}
    }
    layer.paintImg = paintImg || null;
    layer.fillImg = fillImg || null;
  };

  // Rebuild the layer set, panel tree and active layer from a snapshot. Layers
  // that still exist are reused (canvases stay bound); missing ones are
  // recreated (a deleted layer comes back with its rasters + objects) and extra
  // ones discarded.
  const applySnapshot = (snap) => {
    if (!snap || !Array.isArray(snap.layers)) return;
    const byId = new Map(layersRef.current.map(l => [l.id, l]));
    const wanted = new Set(snap.layers.map(l => l.id));
    for (const l of [...layersRef.current]) {
      if (!wanted.has(l.id)) discardLayerRecord(l.id);
    }
    const recs = snap.layers.map(ls => {
      let rec = byId.get(ls.id);
      if (!rec || !layersRef.current.includes(rec)) {
        rec = { id: ls.id, name: ls.name, visible: ls.visible !== false, opacity: normalizeLayerOpacity(ls.opacity), clipped: !!ls.clipped, objects: [], paintImg: null, fillImg: null };
      }
      rec.name = ls.name;
      rec.visible = ls.visible !== false;
      rec.opacity = normalizeLayerOpacity(ls.opacity);
      rec.clipped = !!ls.clipped;
      rec.objects = ls.objects || [];
      return rec;
    });
    layersRef.current = recs;
    panelRef.current = (Array.isArray(snap.panel) && snap.panel.length)
      ? snap.panel.map(n => (n.type === 'folder'
        ? { type: 'folder', id: n.id, name: n.name, visible: n.visible !== false, children: [...n.children] }
        : { type: 'layer', id: n.id }))
      : recs.map(r => ({ type: 'layer', id: r.id }));
    syncLayerOrder();
    restoreBase(snap.base);
    // Existing layers restore immediately; recreated ones (canvases not mounted
    // yet) are re-applied by the layout effect after the commit.
    for (const ls of snap.layers) {
      const l = layerById(ls.id);
      if (l) writeLayerPixels(l, ls.paintImg, ls.fillImg);
    }
    pendingRestoreRef.current = snap;
    const active = (snap.activeId && layerById(snap.activeId))
      ? snap.activeId
      : ((layersRef.current[layersRef.current.length - 1] || {}).id || null);
    if (active) { activeIdRef.current = active; setActiveIdState(active); }
    bindActiveLayerRefs();
    const activeRec = activeLayer();
    syncObjects(activeRec ? activeRec.objects : [], snap.selId == null ? null : snap.selId);
    syncLayersView();
    setDirty(true);
    scheduleOverlay();
  };

  const doUndo = useCallback(() => {
    settleGesture();
    if (!ctxRef.current && !fillCtxRef.current) return;
    const prev = undoStep(undoRef.current, snapshotState());
    if (prev) applySnapshot(prev);
  }, []);

  const doRedo = useCallback(() => {
    settleGesture();
    if (!ctxRef.current && !fillCtxRef.current) return;
    const next = redoStep(undoRef.current, snapshotState());
    if (next) applySnapshot(next);
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
  // of the shared scratch (which `paintObjectThroughMasks` also uses internally).
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
  // Blur-pen sample buffer. Only ever read over the brush box, so it grows to
  // the largest box seen instead of the whole W×H store.
  const getBlurCanvas = (w = 1, h = 1) => {
    if (!blurCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, w); c.height = Math.max(1, h);
      blurCanvasRef.current = c;
    }
    const c = blurCanvasRef.current;
    if (c.width < w || c.height < h) {
      c.width = Math.max(c.width, w);
      c.height = Math.max(c.height, h);
    }
    return c;
  };
  // ── UV region lock helpers ─────────────────────────────────
  const getUvMaskCanvas = () => {
    if (!uvMaskCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      uvMaskCanvasRef.current = c;
    }
    return uvMaskCanvasRef.current;
  };
  const getUvDimCanvas = () => {
    if (!uvDimCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      uvDimCanvasRef.current = c;
    }
    return uvDimCanvasRef.current;
  };
  const getUvCoverageCanvas = () => {
    if (!uvCoverageCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      uvCoverageCanvasRef.current = c;
    }
    return uvCoverageCanvasRef.current;
  };
  // ImageData for a Uint8 mask (white = editable), preferring the context's own
  // createImageData so putImageData accepts it.
  const uvMaskImage = (ctx, size, mask) => {
    try {
      const src = maskToImageData(mask, size);
      const img = ctx && typeof ctx.createImageData === 'function' ? ctx.createImageData(size, size) : null;
      if (img && img.data) { img.data.set(src.data); return img; }
      return src;
    } catch (_) { return null; }
  };
  // Cached full-coverage mask for a region (all panels, grown).
  const uvCoverageMaskFor = (r) => {
    if (!r || !r.idMap) return null;
    const cache = uvCoverageCacheRef.current;
    if (cache.has(r)) return cache.get(r);
    let m = null;
    try { m = regionMask(r, { island: -1, grow: UV_GROW_PX }); } catch (_) { m = null; }
    cache.set(r, m);
    return m;
  };
  // Rebuild the white editable mask + the dim tint for the ACTIVE panel. The
  // lock allows edits only on mapped texels of the active BaseMap panel. Called
  // whenever the lock, regions or active panel changes — never per stroke.
  const rebuildUvConstraint = () => {
    uvConstraintRef.current = false;
    if (!uvLockRef.current) {
      uvCoverageCanvasRef.current = null;
      return;
    }
    const regions = Array.isArray(uvRegionsRef.current) ? uvRegionsRef.current : null;
    if (!regions || !regions.length) {
      uvCoverageCanvasRef.current = null;
      return;
    }
    const panel = activeRef.current;

    // 1. Coverage canvas (all panels, all islands): white where mapped, used to
    //    keep live objects out of dead UV space. Unknown panels stay white
    //    (fully editable) rather than vanishing.
    const coverage = getUvCoverageCanvas();
    const cctx = coverage ? coverage.getContext('2d') : null;
    let anyRegion = false;
    let activeCoverageMask = null;
    if (cctx) {
      cctx.save();
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.globalCompositeOperation = 'source-over';
      cctx.clearRect(0, 0, W, H);
      for (let i = 0; i < panelCount; i++) {
        const r = regions[i];
        if (!r || !r.idMap) {
          cctx.fillStyle = '#ffffff';
          cctx.fillRect(layout.x(i), 0, TEXTURE, TEXTURE);
          continue;
        }
        anyRegion = true;
        const rm = uvCoverageMaskFor(r);
        if (!rm) continue;
        if (i === panel) activeCoverageMask = rm;
        const rimg = uvMaskImage(cctx, r.size, rm);
        if (rimg && typeof cctx.putImageData === 'function') {
          try { cctx.putImageData(rimg, layout.x(i), 0); } catch (_) { /* stubbed ctx */ }
        }
      }
      cctx.restore();
      if (!anyRegion) uvCoverageCanvasRef.current = null; // nothing to clip against
    }

    // 2. Editable mask for the ACTIVE panel = its full coverage.
    const region = regions[panel];
    const activeMask = region && region.idMap ? activeCoverageMask : null;
    if (activeMask) {
      const m = getUvMaskCanvas();
      const mctx = m.getContext('2d');
      if (mctx) {
        const img = uvMaskImage(mctx, region.size, activeMask);
        mctx.save();
        mctx.setTransform(1, 0, 0, 1, 0, 0);
        mctx.clearRect(0, 0, W, H);
        if (img && typeof mctx.putImageData === 'function') {
          try { mctx.putImageData(img, layout.x(panel), 0); } catch (_) { /* stubbed ctx */ }
        }
        mctx.restore();
        uvConstraintRef.current = true;
      }
    }

    // 3. Dim tint every panel, punch the editable region clear, then stroke every
    //    island border so the paintable panels read at a glance (step 1).
    const dim = getUvDimCanvas();
    const dctx = dim.getContext('2d');
    if (dctx) {
      dctx.save();
      dctx.setTransform(1, 0, 0, 1, 0, 0);
      dctx.globalCompositeOperation = 'source-over';
      dctx.clearRect(0, 0, W, H);
      dctx.fillStyle = UV_DIM_COLOR;
      for (let i = 0; i < panelCount; i++) dctx.fillRect(layout.x(i), 0, TEXTURE, TEXTURE);
      if (uvConstraintRef.current) {
        dctx.globalCompositeOperation = 'destination-out';
        try { dctx.drawImage(uvMaskCanvasRef.current, 0, 0); } catch (_) {}
        dctx.globalCompositeOperation = 'source-over';
      }
      dctx.restore();
    }
  };

  // Rebuild the 3D→flat glow outline: trace the boundary of the atlas region a
  // 3D click landed on (the connected coverage component under the hit UV). Only
  // the boundary is drawn — the art underneath is never covered — and it is a
  // pure highlight, never an edit constraint.
  const rebuildUvGlow = () => {
    uvGlowOutlineRef.current = [];
    const glow = uvGlowRef.current;
    if (!glow) return;
    const regions = Array.isArray(uvRegionsRef.current) ? uvRegionsRef.current : null;
    const region = regions && regions[glow.panel];
    if (!region || !region.idMap) return;
    let mask = null;
    try { mask = regionMask(region, { island: glow.id, grow: UV_GROW_PX }); } catch (_) { mask = null; }
    if (!mask) return;
    try {
      const src = uvMaskImage(null, region.size, mask);
      uvGlowOutlineRef.current = chainBorderSegments(traceMaskBorder(src));
    } catch (_) { uvGlowOutlineRef.current = []; }
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
    paintVisibleComposite(sceneCtx);
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
  // uniformly, each layer against its own pre-gesture image. When the UV lock is
  // on, the active panel's editable mask is applied the same way, so paint can
  // never land on dead UV space or a different island.
  const constrainLayerToMask = (layerCtx, before) => {
    if (!before || !layerCtx) return;
    const uvOn = uvLockRef.current && uvConstraintRef.current && uvMaskCanvasRef.current;
    if (!hasMaskRef.current && !uvOn) return;
    const cur = layerCtx.getImageData(0, 0, W, H);
    let changed = false;
    if (hasMaskRef.current && maskCanvasRef.current) {
      const mctx = maskCanvasRef.current.getContext('2d');
      if (mctx) {
        const m = mctx.getImageData(0, 0, W, H);
        if (constrainImageToMask(cur, before, m)) changed = true;
      }
    }
    if (uvOn) {
      const uctx = uvMaskCanvasRef.current.getContext('2d');
      if (uctx) {
        const m = uctx.getImageData(0, 0, W, H);
        if (constrainImageToMask(cur, before, m)) changed = true;
      }
    }
    if (changed) {
      layerCtx.putImageData(cur, 0, 0);
      // The active layer's cached pixels are now stale (paint AND fill caches
      // are cleared; only one layer is constrained per call).
      invalidateLayerPixels(activeLayer());
    }
  };
  // Clip BOTH raster layers of the ACTIVE layer to the live selection and/or the
  // UV region, using the pre-gesture images from the snapshot pushed at gesture
  // start (`pushSnapshot` runs before every raster mutation). Called once at the
  // end of a brush stroke, an eraser gesture, a Shift-click segment or a fill.
  const constrainRastersToMask = () => {
    const uvOn = uvLockRef.current && uvConstraintRef.current;
    if (!hasMaskRef.current && !uvOn) return;
    const past = undoRef.current.past;
    const snap = past.length ? past[past.length - 1] : null;
    const ls = snap && Array.isArray(snap.layers) ? snap.layers.find(x => x.id === activeIdRef.current) : null;
    if (!ls) return;
    constrainLayerToMask(ctxRef.current, ls.paintImg);
    constrainLayerToMask(fillCtxRef.current, ls.fillImg);
  };
  // Paint one live object through one or more masks onto `target` (objects
  // layer + export). Masks are applied as successive `destination-in` passes, so
  // two masks intersect. Used by stamped selection clips and the UV lock.
  const paintObjectThroughMasks = (target, o, masks) => {
    const list = (masks || []).filter(Boolean);
    if (!list.length) { paintObjectWithErase(target, o); return; }
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
    for (const m of list) { try { sctx.drawImage(m, 0, 0); } catch (_) {} }
    sctx.restore();
    target.drawImage(sc, 0, 0);
  };
  // Display/export path for a movable: clip it to its own stamped selection
  // shape (`clipMask`, captured at creation) so it stays partial forever; and,
  // while the UV lock is on, to the mapped texels (all panels) so a sticker /
  // shape / text can never occupy dead UV space.
  const paintObjectForDisplay = (target, o) => {
    const masks = [];
    if (o && o.clipMask) masks.push(o.clipMask);
    if (uvLockRef.current && uvCoverageCanvasRef.current) masks.push(uvCoverageCanvasRef.current);
    if (!masks.length) { paintObjectWithErase(target, o); return; }
    paintObjectThroughMasks(target, o, masks);
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
  // ── Layer clipping (Photoshop-style clipping mask) ─────────
  // A clipped layer's content is intersected with the ALPHA of its clip base:
  // the nearest non-clipped layer below it in the flat z-order, or the locked
  // base image when there is none. The layer's own rasters/objects are never
  // modified, so unclipping restores every edit.
  //
  // Persistent W×H canvases holding a clip base's content, keyed by base id
  // (layer id or `CLIP_BASE_ROOT`). Reused across frames so painting the base
  // refreshes its mask every overlay frame with no allocation.
  const clipMaskElsRef = useRef(new Map());
  // W×H scratch that assembles a clipped layer's content before masking —
  // shared by the screen, export and sampling paths.
  const clipScratchRef = useRef(null);
  const getClipScratch = () => {
    if (!clipScratchRef.current) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      clipScratchRef.current = c;
    }
    return clipScratchRef.current;
  };
  // Effective compositing opacity of a layer (0..1, defaults to 1).
  const layerOpacityOf = (layer) => normalizeLayerOpacity(layer && layer.opacity);
  // Scratch that assembles one layer's full-opacity content before it is blitted
  // with the layer opacity. Separate from the clip scratch (which
  // `paintObjectThroughMasks` also borrows via `getScratch`) so assembling a
  // layer never clobbers an in-progress mask or clip composite.
  const layerScratchRef = useRef(null);
  const getLayerScratch = () => {
    if (!layerScratchRef.current) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      layerScratchRef.current = c;
    }
    return layerScratchRef.current;
  };
  // Blit one layer's content at its own opacity: full-opacity layers draw
  // directly; translucent ones are assembled in the layer scratch first (so the
  // per-object alpha baked inside multiplies with the layer alpha instead of
  // being overridden by it) and then blitted with globalAlpha. Opacity 0 draws
  // nothing. The layer's own rasters/objects are never touched.
  const drawLayerContentWithOpacity = (target, layer) => {
    const op = layerOpacityOf(layer);
    if (!(op > 0)) return;
    if (op >= 1) { drawLayerContent(target, layer); return; }
    const sc = getLayerScratch();
    const sctx = sc.getContext('2d');
    if (!sctx) { drawLayerContent(target, layer); return; }
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.clearRect(0, 0, W, H);
    drawLayerContent(sctx, layer);
    sctx.restore();
    target.save();
    target.globalAlpha = op;
    try { target.drawImage(sc, 0, 0); } catch (_) { /* stub */ }
    target.restore();
  };
  // A layer's own content (fill underlay → movables → pen) into `target`.
  const drawLayerContent = (target, layer) => {
    const fc = layerEl(layer.id, 'fill');
    if (fc) target.drawImage(fc, 0, 0);
    for (const o of layer.objects) {
      if (hasLiveVisual(o)) paintObjectInPanel(target, o);
    }
    const pc = layerEl(layer.id, 'paint');
    if (pc) target.drawImage(pc, 0, 0);
  };
  // The mask source for a clip base (its rendered alpha). Content is used even
  // when the base layer is hidden so a clipped layer keeps its shape.
  const buildClipMask = (baseId) => {
    const store = clipMaskElsRef.current;
    let c = store.get(baseId);
    if (!c) {
      c = document.createElement('canvas');
      c.width = W; c.height = H;
      store.set(baseId, c);
    }
    const cc = c.getContext('2d');
    if (!cc) return c;
    cc.setTransform(1, 0, 0, 1, 0, 0);
    cc.globalCompositeOperation = 'source-over';
    cc.globalAlpha = 1;
    cc.clearRect(0, 0, W, H);
    if (baseId === CLIP_BASE_ROOT) {
      if (baseCanvasRef.current) cc.drawImage(baseCanvasRef.current, 0, 0);
    } else {
      const b = layerById(baseId);
      if (b) drawLayerContent(cc, b);
    }
    return c;
  };
  // Composite a clipped layer into the W×H scratch `target`: its content,
  // then `destination-in` against the base mask. Callers blit `target` (or, for
  // the display canvas, use it directly).
  const paintClippedLayer = (target, layer, maskCanvas) => {
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalCompositeOperation = 'source-over';
    target.globalAlpha = 1;
    target.clearRect(0, 0, W, H);
    drawLayerContent(target, layer);
    target.globalCompositeOperation = 'destination-in';
    try { target.drawImage(maskCanvas, 0, 0); } catch (_) { /* stub */ }
    target.globalCompositeOperation = 'source-over';
    target.restore();
  };
  // Reproduce exactly what the eye sees: the locked base, then every VISIBLE
  // layer bottom → top (its fill, its movables, its pen), each at its own
  // opacity. Clipped layers are masked by their clip base. Used by the wand /
  // fill / eyedropper so sampling, the screen and the export all agree.
  const paintVisibleComposite = (target) => {
    if (baseCanvasRef.current) target.drawImage(baseCanvasRef.current, 0, 0);
    const needsScratch = layersRef.current.some(l => l.clipped || layerOpacityOf(l) < 1);
    const scratchCanvas = needsScratch ? getClipScratch() : null;
    const scratchCtx = scratchCanvas ? scratchCanvas.getContext('2d') : null;
    const maskCache = new Map();
    for (const layer of layersRef.current) {
      if (!layerEffectiveVisible(layer.id)) continue;
      const op = layerOpacityOf(layer);
      if (!(op > 0)) continue;
      const baseId = clipBaseFor(layer.id);
      if (!baseId || !scratchCtx) { drawLayerContentWithOpacity(target, layer); continue; }
      let mask = maskCache.get(baseId);
      if (!mask) { mask = buildClipMask(baseId); maskCache.set(baseId, mask); }
      paintClippedLayer(scratchCtx, layer, mask);
      if (op >= 1) target.drawImage(scratchCanvas, 0, 0);
      else {
        target.save();
        target.globalAlpha = op;
        try { target.drawImage(scratchCanvas, 0, 0); } catch (_) { /* stub */ }
        target.restore();
      }
    }
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
  // Bumped on every overlay frame; the live 3D preview polls this (via
  // `getRevision`) to know when the painted content changed — without forcing a
  // React re-render on every brush stroke.
  const revisionRef = useRef(0);
  const drawOverlay = useCallback(() => {
    rafRef.current = 0;
    revisionRef.current += 1;
    // Live values, not the closure's: a frame scheduled before a zoom/layout
    // change must still draw the chrome at the CURRENT scale (see effZoomRef).
    const z = effZoomRef.current || 1;
    const activeNow = activeRef.current;
    const selIdNow = selIdRef.current;
    // Drop eraser caches for objects that no longer exist on any layer.
    const eraseCache = eraseCacheRef.current;
    if (eraseCache.size) {
      const live = new Set();
      for (const l of layersRef.current) for (const st of l.objects) live.add(st.id);
      for (const id of [...eraseCache.keys()]) if (!live.has(id)) eraseCache.delete(id);
    }
    // ── Each layer's movables on that layer's own canvas, BELOW its paint
    // raster. Hidden layers are skipped (their canvases are display:none too).
    // Each movable renders in the panel its centre falls in (overflow past its
    // panel is clipped); a movable placed BEFORE any selection previews in full,
    // one ADDED while a selection exists is clipped to its stamped `clipMask`.
    for (const layer of layersRef.current) {
      const objCanvas = layerEl(layer.id, 'objects');
      if (!objCanvas) continue;
      const octx = objCanvas.getContext('2d');
      if (!octx) continue;
      octx.save();
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, W, H);
      if (layerEffectiveVisible(layer.id)) {
        for (const st of layer.objects) {
          if (!hasLiveVisual(st)) continue;
          paintObjectInPanel(octx, st);
        }
      }
      octx.restore();
    }
    // ── Clipped layers: assemble a masked display canvas. Their raw fill /
    // objects / paint canvases are hidden while clipped, so this is what the
    // screen shows — identical to the export / sampling composite. Rebuilt every
    // frame so painting (or hiding) the base updates the mask live.
    if (layersRef.current.some(l => l.clipped)) {
      const maskCache = new Map();
      for (const layer of layersRef.current) {
        const clipCanvas = layerEl(layer.id, 'clip');
        if (!clipCanvas) continue;
        const cctx = clipCanvas.getContext('2d');
        if (!cctx) continue;
        const baseId = layerEffectiveVisible(layer.id) ? clipBaseFor(layer.id) : null;
        if (!baseId) {
          cctx.save();
          cctx.setTransform(1, 0, 0, 1, 0, 0);
          cctx.clearRect(0, 0, W, H);
          cctx.restore();
          continue;
        }
        let mask = maskCache.get(baseId);
        if (!mask) { mask = buildClipMask(baseId); maskCache.set(baseId, mask); }
        paintClippedLayer(cctx, layer, mask);
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
    // UV region lock: dim every texel the active panel's mesh cannot reach (and
    // every inactive panel) so the editable island reads at a glance. Drawn
    // under the movable chrome so handles stay visible. Overlay only.
    if (uvLockRef.current && uvDimCanvasRef.current) {
      try { ctx.drawImage(uvDimCanvasRef.current, 0, 0); } catch (_) {}
    }
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
      // the corner and reshape the stroke instead of scaling the frame).
      // A rotation snap flags the snapped state the same pink as the
      // move/scale snap guides so the clip reads at a glance.
      const dragNow = dragRef.current;
      const rotSnapped = dragNow && dragNow.mode === 'rotate' && dragNow.id === st.id
        && snapGuidesRef.current && snapGuidesRef.current.rotSnap != null
        ? snapGuidesRef.current.rotSnap : null;
      if (rotSnapped != null) ctx.strokeStyle = '#ff2d95';
      ctx.beginPath();
      ctx.moveTo(fcx, fb.y0);
      ctx.lineTo(fcx, fb.y0 - gap);
      ctx.stroke();
      ctx.fillStyle = rotSnapped != null ? '#ff2d95' : '#6aa0ff';
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
      // Rotation-snap degree badge: while the rotate drag sits on a 90°
      // multiple, flag the snapped angle above the handle (world frame so
      // the text stays readable). Same pink as the snap guides. The chrome
      // is drawn in the UNFLIPPED frame, so the handle world position uses
      // translate + rotate only (no mirror), matching the drawn dot.
      if (rotSnapped != null) {
        const c0 = Math.cos(st.rot || 0);
        const s0 = Math.sin(st.rot || 0);
        const hx = fcx;
        const hy = fb.y0 - gap;
        const hw = { x: st.x + hx * c0 - hy * s0, y: st.y + hx * s0 + hy * c0 };
        const txt = `${rotSnapped}\u00B0`;
        const fs = 13 / z;
        ctx.save();
        ctx.font = `650 ${fs}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = (ctx.measureText && typeof ctx.measureText === 'function')
          ? ctx.measureText(txt).width : txt.length * fs * 0.62;
        const pw = tw + fs * 1.1;
        const ph = fs * 1.7;
        const bx = hw.x - pw / 2;
        const by = hw.y - 20 / z - ph;
        ctx.fillStyle = 'rgba(10,22,40,0.94)';
        ctx.strokeStyle = '#ff2d95';
        ctx.lineWidth = Math.max(1, 1.5 / z);
        ctx.beginPath();
        ctx.rect(bx, by, pw, ph);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ff2d95';
        ctx.fillText(txt, hw.x, by + ph / 2);
        ctx.restore();
      }
    }
    // Snap guides: while a move/scale gesture is snapped, draw the matched
    // world guide lines across the padded overlay so the alignment is visible.
    const guides = snapGuidesRef.current;
    if (guides && (guides.x != null || guides.y != null)) {
      ctx.save();
      ctx.strokeStyle = '#ff2d95';
      ctx.lineWidth = Math.max(1, 1.5 / z);
      ctx.setLineDash([7 / z, 5 / z]);
      if (guides.x != null) {
        ctx.beginPath();
        ctx.moveTo(guides.x, -OVERLAY_PAD);
        ctx.lineTo(guides.x, H + OVERLAY_PAD);
        ctx.stroke();
      }
      if (guides.y != null) {
        ctx.beginPath();
        ctx.moveTo(-OVERLAY_PAD, guides.y);
        ctx.lineTo(W + OVERLAY_PAD, guides.y);
        ctx.stroke();
      }
      ctx.restore();
    }
    const sh = shapeRef.current;
    if (sh && sh.current) {
      ctx.save();
      clipActivePanel(ctx, activeNow);
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
        clipActivePanel(ctx, activeNow);
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
      ctx.strokeRect(layout.x(activeNow) + 1, 1, TEXTURE - 2, H - 2);
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
    // 3D→flat glow: a glowing BOUNDARY around the clicked atlas region (no fill,
    // so the panel art underneath stays visible). Additive strokes build a soft
    // halo, then a crisp bright edge on top.
    const uvLoops = uvGlowOutlineRef.current;
    let uvPts = 0;
    for (let i = 0; uvLoops && i < uvLoops.length; i++) uvPts += (uvLoops[i] && uvLoops[i].length) || 0;
    if (uvLoops && uvLoops.length && uvPts <= 20000) {
      const traceLoops = () => {
        for (let i = 0; i < uvLoops.length; i++) {
          const loop = uvLoops[i];
          if (!loop || loop.length < 2) continue;
          ctx.moveTo(loop[0][0], loop[0][1]);
          for (let j = 1; j < loop.length; j++) ctx.lineTo(loop[j][0], loop[j][1]);
        }
      };
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash([]);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,196,64,0.10)';
      ctx.lineWidth = Math.max(6, 14 / z);
      ctx.beginPath(); traceLoops(); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,206,84,0.22)';
      ctx.lineWidth = Math.max(3, 7 / z);
      ctx.beginPath(); traceLoops(); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255,228,140,0.95)';
      ctx.lineWidth = Math.max(1.5, 2.5 / z);
      ctx.beginPath(); traceLoops(); ctx.stroke();
      ctx.restore();
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

  // Rebuild the UV editable mask + dim tint whenever the lock, the coverage or
  // the active panel changes. Never per stroke.
  useEffect(() => {
    rebuildUvConstraint();
    scheduleOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uvLock, uvRegions, active]);

  // Rebuild the 3D→flat glow whenever the clicked region or the coverage
  // changes (works whether or not the lock is on).
  useEffect(() => {
    rebuildUvGlow();
    scheduleOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uvGlow, uvRegions]);

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
        // A 0×0 decode (e.g. an SVG with no resolvable size that slipped past
        // the main-process normalizer) would poison the object stack — reject
        // before pushing an undo snapshot.
        if (!w || !h) {
          useAppStore.getState().showToast('BAD_IMAGE', 'error');
          return;
        }
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
    scheduleOverlay();
  };

  const flipSticker = (axis) => {
    const st = targetObject();
    if (!st) return;
    // Capture the CURRENT visible-boundary centre as the mirror pivot. Stored on
    // the object so a later erase (which re-frames the boundary) can never move
    // a flipped object, while a part-erased object still mirrors in place.
    const f = frameOf(st);
    updateObject(st.id, {
      [axis]: !st[axis],
      flipPivot: { x: (f.x0 + f.x1) / 2, y: (f.y0 + f.y1) / 2 },
    });
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
    if (st.flipPivot) copy.flipPivot = { x: st.flipPivot.x, y: st.flipPivot.y };
    syncObjects([...objectsRef.current, copy], copy.id);
    // Hand over to single-select (object) like Import Sticker, so the fresh
    // copy's box + handles are drawn even if a mask sub-mode was active.
    setSelMode('object');
    setTool('select');
    setDirty(true);
    scheduleOverlay();
  };

  // ── Export: base image → each visible layer (fill → movables → pen) ─
  // The composite order must match the on-screen DOM stack. Each layer
  // composites at its own opacity (0 = contributes nothing, but its stored
  // rasters/objects are preserved for a later fade back in).
  const flattenToCanvas = () => {
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.drawImage(baseCanvasRef.current, 0, 0);
    // Every VISIBLE layer composites bottom → top in the same order as its DOM
    // canvases: fill underlay → movables → pen. Hidden layers are skipped
    // entirely (they are not part of the exported texture). A clipped layer is
    // intersected with its clip base's alpha, exactly like the screen.
    const needsClip = layersRef.current.some(l => (l.clipped || layerOpacityOf(l) < 1) && layerEffectiveVisible(l.id));
    const scratchCanvas = needsClip ? getClipScratch() : null;
    const scratchCtx = scratchCanvas ? scratchCanvas.getContext('2d') : null;
    const maskCache = new Map();
    for (const layer of layersRef.current) {
      if (!layerEffectiveVisible(layer.id)) continue;
      const op = layerOpacityOf(layer);
      if (!(op > 0)) continue;
      const baseId = clipBaseFor(layer.id);
      if (!baseId || !scratchCtx) { drawLayerContentWithOpacity(ctx, layer); continue; }
      let mask = maskCache.get(baseId);
      if (!mask) { mask = buildClipMask(baseId); maskCache.set(baseId, mask); }
      paintClippedLayer(scratchCtx, layer, mask);
      if (op >= 1) ctx.drawImage(scratchCanvas, 0, 0);
      else {
        ctx.save();
        ctx.globalAlpha = op;
        try { ctx.drawImage(scratchCanvas, 0, 0); } catch (_) { /* stub */ }
        ctx.restore();
      }
    }
    return out;
  };
  // Persistent per-panel canvases for the live 3D preview (full resolution, no
  // PNG round-trip). The SAME elements are reused so the renderer can re-upload
  // them in place via THREE.CanvasTexture + needsUpdate.
  const previewCanvasRef = useRef({ size: 0, list: [] });
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
    // Full-resolution per-panel canvases for the live 3D preview. No PNG
    // encode/decode — three uploads the canvas straight to the GPU, so a
    // full-res refresh is cheap enough to sample ~1×/s while painting. The
    // canvas elements are reused across calls; the renderer re-uploads the SAME
    // texture (`needsUpdate`) instead of rebuilding it.
    getPanelCanvases(size = TEXTURE) {
      const px = Math.max(64, Math.min(TEXTURE, size | 0));
      const store = previewCanvasRef.current;
      if (store.size !== px || store.list.length !== panelCount) {
        store.size = px;
        store.list = Array.from({ length: panelCount }, () => {
          const c = document.createElement('canvas');
          c.width = px; c.height = px;
          return c;
        });
      }
      const flat = flattenToCanvas();
      const out = [];
      for (let i = 0; i < panelCount; i++) {
        const c = store.list[i];
        const cctx = c.getContext('2d');
        if (cctx) {
          if (typeof cctx.clearRect === 'function') cctx.clearRect(0, 0, px, px);
          cctx.drawImage(flat, layout.x(i), 0, TEXTURE, TEXTURE, 0, 0, px, px);
        }
        out.push({ partName: panelNames[i], canvas: c });
      }
      return out;
    },
    // Monotonic counter bumped on every overlay frame; the live preview polls
    // it to skip re-exporting when nothing changed.
    getRevision() { return revisionRef.current; },
    // Replace ONE panel's base image in place (the "Import image" action for
    // the active panel). Only the base layer under that panel changes — the
    // pen/fill rasters, live objects and every other panel are untouched, so an
    // import never discards work and needs no unsaved-changes guard. The
    // previous base is snapshotted first, so Ctrl+Z reverts the import.
    setPanelBase(index, dataUrl) {
      const baseCtx = baseCtxRef.current;
      if (!baseCtx || !dataUrl) return false;
      const i = Math.min(Math.max(0, index | 0), panelCount - 1);
      pushSnapshot();
      baseCtx.save();
      baseCtx.setTransform(1, 0, 0, 1, 0, 0);
      baseCtx.globalCompositeOperation = 'source-over';
      baseCtx.globalAlpha = 1;
      // Opaque fill under the image: a normalized import is 2048², but the
      // fill keeps the panel opaque even for a legacy smaller/transparent one.
      baseCtx.fillStyle = DEFAULT_BASE_COLOR;
      baseCtx.fillRect(layout.x(i), 0, TEXTURE, TEXTURE);
      baseCtx.restore();
      paintBaseImage(baseCtx, layout, i, dataUrl, () => {
        try { basePixelsRef.current = baseCtx.getImageData(0, 0, W, H); } catch (_) {}
        scheduleOverlay();
      });
      setDirty(true);
      return true;
    },
    importSticker,
    removeSticker,
    duplicateSticker,
    exportLayers,
    loadLayers,
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
        flipPivot: o.flipPivot ? { x: o.flipPivot.x, y: o.flipPivot.y } : null,
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
      // The Workshop upload dialog owns the keyboard while open (it overlays
      // the painter): no canvas shortcut may fire behind it — notably Ctrl+C,
      // which must reach the browser as copy (e.g. the item URL on the
      // dialog's success view), not the Duplicate-Sticker action.
      if (inputDisabledRef.current) return;
      try { if (document.getElementById('livery-upload-overlay')) return; } catch (_) {}
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
          return;
        }
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
      // Bare letters only: Ctrl/Alt chords belong to the app (Ctrl+S saves),
      // so a shortcut never fires while a modifier is held.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        // Brush sub-modes, reachable from ANY tool: B=Paint, S=Blur (the
        // colour-mixing pen). Each switches to the Brush tool first, like A/L/W.
        if (k === 'b') { if (toolRef.current !== 'brush') activateTool('brush'); setBrushMode('paint'); return; }
        if (k === 's') { if (toolRef.current !== 'brush') activateTool('brush'); setBrushMode('blur'); return; }
        const map = { e: 'eraser', g: 'fill', u: 'line', r: 'rect', m: 'ellipse', o: 'ellipse', t: 'text' };
        if (map[k] && TOOLS.includes(map[k])) { activateTool(map[k]); }
      }
    };
    const onKeyUp = (e) => { if (e.key === ' ') { spaceRef.current = false; setSpaceHeld(false); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  }, [doUndo, doRedo, textAnchor]);

  // Locked mode (the Workshop upload dialog owns the screen) drops every
  // transient gesture so nothing the pointer was mid-way through can finish
  // later, and clears the held-Space pan state / brush ring. The CSS
  // `lp-input-locked` class on the wrap also makes it pointer-transparent.
  useEffect(() => {
    if (!inputDisabled) return;
    lassoRef.current = null;
    curveRef.current = null;
    shapeRef.current = null;
    dragRef.current = null;
    panRef.current = null;
    if (spaceRef.current) { spaceRef.current = false; setSpaceHeld(false); }
    if (cursorRingRef.current) cursorRingRef.current.style.display = 'none';
    scheduleOverlay();
  }, [inputDisabled]);

  // ── Coord mapping ──────────────────────────────────────────
  // Map pointer coords from the ALWAYS-VISIBLE base canvas. Every layer canvas
  // shares the base's exact stage geometry, but the active layer's paint canvas
  // can be `display:none` — a clipped layer shows a masked display canvas
  // instead — and `getBoundingClientRect()` returns all zeros for a hidden
  // element, which would turn the brush coordinates into garbage.
  const stageRect = () => {
    const el = baseCanvasRef.current || canvasRef.current || overlayRef.current;
    return (el && typeof el.getBoundingClientRect === 'function')
      ? el.getBoundingClientRect()
      : { left: 0, top: 0, width: W, height: H };
  };
  const toTexture = (clientX, clientY) => {
    const rect = stageRect();
    return {
      x: (clientX - rect.left) * (W / rect.width),
      y: (clientY - rect.top) * (H / rect.height),
    };
  };
  const coalesced = (e) => {
    const n = e.nativeEvent;
    // One layout read per event: a real mouse delivers many coalesced points
    // per move, and calling getBoundingClientRect per point stalled drags.
    const rect = stageRect();
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
    applyBrushEdge(target, b);
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
    // The paint layer changed: drop its cached snapshot pixels.
    invalidateLayerPixels(activeLayer());
  };
  const endStroke = () => {
    strokeLayerRef.current = null;
    strokeBaseRef.current = null;
    strokeBoundsRef.current = null;
  };

  // ── Blur pen (colour mixing, no colour of its own) ─────────
  // A brush-shaped pen that never uses the rail colour: for each dab it samples
  // the VISIBLE stack inside the brush disc (base + every visible layer's fill,
  // movables and pen — exactly like the wand/eyedropper) and paints the average
  // of those pixels back into the ACTIVE layer's pen raster. Sampling the whole
  // visible stack lets a stroke mix base paint, lower layers and live movables
  // together, while writing only into the active layer leaves every other layer
  // untouched. Repeating an average disc across a hard edge progressively
  // smooths it into a gradient.
  //
  // Average the visible pixels inside the disc (cx, cy, radius). Returns an
  // `{r,g,b}` or null when the disc covers no visible pixel. The sample is
  // bounded to the active panel on a multi-image aircraft so a mix never pulls
  // colour across the gutter from the neighbouring panel.
  const sampleVisibleAverage = (cx, cy, radius) => {
    const x0 = Math.max(0, Math.floor(cx - radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const x1 = Math.min(W, Math.ceil(cx + radius));
    const y1 = Math.min(H, Math.ceil(cy + radius));
    const w = x1 - x0, h = y1 - y0;
    if (!(w > 0 && h > 0)) return null;
    const canvas = getBlurCanvas(w, h);
    const sctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!sctx) return null;
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.clearRect(0, 0, w, h);
    sctx.translate(-x0, -y0);
    paintVisibleComposite(sctx);
    let data = null;
    try { data = sctx.getImageData(0, 0, w, h).data; } catch (_) { data = null; }
    sctx.restore();
    if (!data) return null;
    const r2 = radius * radius;
    const panelX0 = panelCount > 1 ? layout.x(activeRef.current) : -Infinity;
    const panelX1 = panelCount > 1 ? panelX0 + TEXTURE : Infinity;
    let R = 0, G = 0, B = 0, n = 0;
    for (let y = 0; y < h; y++) {
      const dy = (y0 + y) - cy;
      for (let x = 0; x < w; x++) {
        const dx = (x0 + x) - cx;
        if (dx * dx + dy * dy > r2) continue;
        const gx = x0 + x;
        if (gx < panelX0 || gx >= panelX1) continue;
        const i = (y * w + x) * 4;
        if (data[i + 3] === 0) continue;
        R += data[i]; G += data[i + 1]; B += data[i + 2]; n++;
      }
    }
    if (n === 0) return null;
    return { r: R / n, g: G / n, b: B / n };
  };
  // Deposit ONE blur dab: the averaged visible colour, a flat disc at full
  // hardness or with a radial falloff whose solid core follows the hardness
  // (`hardness` 1 = crisp disc, 0 = falloff from the centre), painted opaque
  // into the per-stroke layer so the whole stroke still composites at the picker
  // alpha exactly once (see flushStroke).
  const paintBlurDab = (target, p) => {
    const b = brushRef.current;
    const radius = Math.max(1, (b.size || 1) / 2);
    const h = normalizeBrushHardness(b.hardness);
    const avg = sampleVisibleAverage(p.x, p.y, radius);
    if (!avg) return;
    const cr = Math.round(avg.r), cg = Math.round(avg.g), cb = Math.round(avg.b);
    const col = `rgb(${cr}, ${cg}, ${cb})`;
    target.save();
    target.globalCompositeOperation = 'source-over';
    target.globalAlpha = 1;
    if (h >= 0.995) {
      target.fillStyle = col;
    } else {
      const grad = target.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      grad.addColorStop(0, col);
      grad.addColorStop(h, col);
      grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
      target.fillStyle = grad;
    }
    target.beginPath();
    target.arc(p.x, p.y, radius, 0, Math.PI * 2);
    target.fill();
    target.restore();
    growStrokeBounds(p, p);
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
    applyBrushEdge(layer, b);
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
      paintVisibleComposite(sctx);
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
    if (inputDisabledRef.current) return;
    if (e.button === 1 || spaceRef.current) return; // pan handled by wrapper
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
        // Rebuild the UV mask for the new panel synchronously too, so a fill (or
        // a single-dab stroke) started by this same press is clipped correctly.
        rebuildUvConstraint();
      }
    }
    // A right-button press is a colour pick (the Eyedropper tool has no
    // shortcut), except two tools consume it as an editing gesture instead:
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
        scheduleOverlay();
        return;
      }
      if (toolRef.current === 'text' && textAnchorRef.current) {
        commitText();
        setTool('select');
        return;
      }
      pickColorAt(p);
      return;
    }
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
          // Snapshot the START object: the top-left-anchored scale pins its
          // frame, so every factor is measured against the drag's reference
          // object (the live one's origin shifts as it grows).
          dragRef.current = {
            mode: 'resize', id: sel.id, startObj: { ...sel }, startP: p,
          };
          snapGuidesRef.current = null;
          capture(); return;
        }
        if (Math.hypot(lp.x - rotateAt.x, lp.y - rotateAt.y) < grab) {
          dragRef.current = { mode: 'rotate', id: sel.id };
          snapGuidesRef.current = null;
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
        snapGuidesRef.current = null;
        capture(); scheduleOverlay(); return;
      }
      if (sel) syncObjects(objs, null);
    }

    if (t === 'brush' || t === 'eraser') {
      const isErase = t === 'eraser';
      // Brush Blur sub-mode: no colour of its own — each dab samples the visible
      // stack and mixes. The stroke rides the same per-stroke layer as the
      // brush so the whole stroke composites at the picker alpha once, and one
      // snapshot covers the gesture.
      if (t === 'brush' && brushModeRef.current === 'blur') {
        pushSnapshot();
        strokeRef.current = { last: p, erase: false, blur: true };
        strokeRef.current.layer = beginStroke();
        paintBlurDab(strokeRef.current.layer, p);
        flushStroke();
        capture();
        scheduleOverlay();
        return;
      }
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
      paintVisibleComposite(sceneCtx);
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

  // Suppress the browser context menu on the canvas: a right-button press is a
  // colour pick (or a curve-node pop / text commit), handled on pointerdown.
  const onCanvasContextMenu = (e) => {
    e.preventDefault();
  };

  const onCanvasMove = (e) => {
    if (inputDisabledRef.current) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (strokeRef.current) {
      // Blur pen: sample + mix one average dab per step, then composite the
      // stroke layer (so each step can see the previous flush — the mix
      // propagates along the drag). Steps closer than a fraction of the radius
      // are skipped: re-averaging the same disc adds nothing and costs a
      // composite read each time.
      if (strokeRef.current.blur) {
        const target = strokeRef.current.layer || ctx;
        const points = coalesced(e);
        const minD = Math.max(1, brushRef.current.size / 8);
        const minD2 = minD * minD;
        for (let i = 0; i < points.length; i++) {
          const prev = strokeRef.current.last;
          const dx = points[i].x - prev.x, dy = points[i].y - prev.y;
          if (i < points.length - 1 && dx * dx + dy * dy < minD2) continue;
          paintBlurDab(target, points[i]);
          strokeRef.current.last = points[i];
        }
        flushStroke();
        return;
      }
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
      applyBrushEdge(target, b);
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
          let nx = p.x + dragRef.current.dx;
          let ny = p.y + dragRef.current.dy;
          // Snap the moved box's edges + mid lines onto the guides. Alt bypasses
          // so a precise free placement is still possible.
          if (!e.altKey) {
            const box = objectAABB({ ...st, x: nx, y: ny });
            const snap = snapBox(box, snapLinesFor(st.id), snapThreshold());
            nx += snap.dx;
            ny += snap.dy;
            snapGuidesRef.current = (snap.guideX != null || snap.guideY != null)
              ? { x: snap.guideX, y: snap.guideY } : null;
          } else {
            snapGuidesRef.current = null;
          }
          updateObject(st.id, { x: nx, y: ny, panel: panelIndexAt(p.x) });
        }
        else if (mode === 'resize') {
          const d = dragRef.current;
          const so = d.startObj;
          // The dragged bottom-right corner tracks the pointer 1:1, so snapping
          // the pointer lands the moving edge exactly on a guide. Aspect-locked
          // (Shift) skips snapping: the lock and two independent guides fight.
          // Alt bypasses too.
          let sp = p;
          if (!e.shiftKey && !e.altKey) {
            const snap = snapPoint(p.x, p.y, snapLinesFor(st.id), snapThreshold());
            sp = { x: p.x + snap.dx, y: p.y + snap.dy };
            snapGuidesRef.current = (snap.guideX != null || snap.guideY != null)
              ? { x: snap.guideX, y: snap.guideY } : null;
          } else {
            snapGuidesRef.current = null;
          }
          // Top-left-anchored: factors are measured against the START object and
          // the origin is re-placed so the box's top-left corner stays pinned.
          const { kx, ky } = resizeFactors(so, d.startP, sp, e.shiftKey);
          const org = resizeOrigin(so, kx, ky);
          const patch = {
            x: org.x, y: org.y,
            w: Math.max(8, so.w * kx), h: Math.max(8, so.h * ky),
          };
          if (st.kind === 'text' && so.size) {
            if (e.shiftKey) {
              // Aspect-locked: the font follows the box, so the glyphs match.
              patch.size = Math.max(4, so.size * kx);
            } else {
              // Free stretch keeps the font and stretches the glyphs to the
              // box, so the box keeps hugging them.
              const s0 = so.stretch || { sx: 1, sy: 1 };
              patch.stretch = { sx: Math.max(0.01, s0.sx * kx), sy: Math.max(0.01, s0.sy * ky) };
            }
          }
          // Curves scale their control points with the box so the shape holds.
          if (st.kind === 'curve' && so.pts) {
            patch.pts = so.pts.map(q => ({ x: q.x * kx, y: q.y * ky }));
          }
          // Eraser holes and the part-erase boundary scale too: without this the
          // holes stayed put while the content grew, so a half circle turned
          // into a lopsided blob instead of staying a half circle.
          if (so.erase) patch.erase = scaleErase(kx, so.erase, ky);
          if (so.erasePolys) patch.erasePolys = scaleErasePolys(kx, so.erasePolys, ky);
          if (so.frame) patch.frame = scaleFrame(kx, so.frame, ky);
          if (so.flipPivot) patch.flipPivot = { x: so.flipPivot.x * kx, y: so.flipPivot.y * ky };
          updateObject(st.id, patch);
        } else if (mode === 'rotate') {
          const raw = Math.atan2(p.y - st.y, p.x - st.x) + Math.PI / 2;
          // Free rotation with suggest-snap: angles within ROT_SNAP_DEG of a
          // 90° multiple clip onto it (same suggestion feel as the geometric
          // move/resize snapping); Alt bypasses for fully free rotation.
          // The snapped degree lands in snapGuidesRef so the overlay can
          // flag the snapped state (pink handle + degree badge).
          let rot = raw;
          let snappedDeg = null;
          if (!e.altKey) {
            const step = Math.PI / 2;
            const nearest = Math.round(raw / step) * step;
            if (Math.abs(raw - nearest) <= (ROT_SNAP_DEG * Math.PI) / 180) {
              rot = nearest;
              snappedDeg = ((Math.round((nearest * 180) / Math.PI) % 360) + 360) % 360;
            }
          }
          snapGuidesRef.current = snappedDeg != null ? { rotSnap: snappedDeg } : null;
          updateObject(st.id, { rot });
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
    if (inputDisabledRef.current) return;
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
      const wasBlur = strokeRef.current.blur;
      const last = strokeRef.current.last;
      const layer = strokeRef.current.layer;
      strokeRef.current = null;
      if (wasErase) applyEraseGesture();
      else if (wasBlur) {
        // The down press already deposited the first dab; just composite any
        // remaining stroke pixels at the picker alpha.
        flushStroke();
      } else {
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
    if (dragRef.current) {
      dragRef.current = null;
      snapGuidesRef.current = null;
      scheduleOverlay();
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
      const wasBlur = strokeRef.current.blur;
      const last = strokeRef.current.last;
      const layer = strokeRef.current.layer;
      strokeRef.current = null;
      if (wasErase) applyEraseGesture();
      else if (wasBlur) flushStroke();
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
            // Reset the base layer, wipe every layer's rasters + movables.
            for (const l of layersRef.current) {
              invalidateLayerPixels(l);
              l.objects = [];
              for (const layerCtx of [ctxFor(l.id, 'paint'), ctxFor(l.id, 'fill')]) {
                if (!layerCtx) continue;
                layerCtx.setTransform(1, 0, 0, 1, 0, 0);
                layerCtx.clearRect(0, 0, W, H);
              }
            }
            const baseCtx = baseCtxRef.current;
            if (baseCtx) {
              drawBase(baseCtx, layout, clearParts, () => {
                try { basePixelsRef.current = baseCtx.getImageData(0, 0, W, H); } catch (_) {}
                scheduleOverlay();
              });
            }
            syncObjects(activeLayer().objects, null);
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
    if (inputDisabledRef.current) { if (cursorRingRef.current) cursorRingRef.current.style.display = 'none'; return; }
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
  // The slider reads/writes a 0–100 percentage; the model stores 0..1.
  const hardnessPct = Math.round(normalizeBrushHardness(brush.hardness) * 100);
  // The brush ring draws an inner circle at the solid-core fraction of the
  // hardness so the falloff is visible while adjusting the slider.
  const ringCoreDiameter = Math.max(0, ringDiameter * normalizeBrushHardness(brush.hardness));

  // ── Wrapper pan (space-drag + middle-drag) ─────────────────
  // The hand icon follows the pointer while Space is held (view-port fixed).
  const moveHand = (clientX, clientY) => {
    const el = handRef.current;
    if (!el) return;
    el.style.transform = `translate(${clientX}px, ${clientY}px) translate(-50%, -50%)`;
  };
  const onWrapDown = (e) => {
    if (inputDisabledRef.current) return;
    if (e.button === 1 || spaceRef.current) {
      e.preventDefault();
      panRef.current = { sx: e.clientX, sy: e.clientY, sl: wrapRef.current.scrollLeft, st: wrapRef.current.scrollTop };
      e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId);
    }
  };
  const onWrapMove = (e) => {
    if (inputDisabledRef.current) return;
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

  // ── Layer management ───────────────────────────────────────
  // Stable callback refs per (layer, kind) so React never detaches/reattaches
  // the canvas element on unrelated re-renders.
  const layerBinder = (id, kind) => {
    const key = `${id}:${kind}`;
    let fn = binderCacheRef.current.get(key);
    if (!fn) {
      fn = (el) => bindLayerEl(id, kind)(el);
      binderCacheRef.current.set(key, fn);
    }
    return fn;
  };
  const nextLayerName = () => {
    const used = new Set(layersRef.current.map(l => l.name));
    let i = layersRef.current.length + 1;
    while (used.has(`Layer ${i}`)) i++;
    return `Layer ${i}`;
  };

  // Make `id` the editable layer. In-progress gestures settle first; the
  // select mask belongs to the layer it was drawn on, so it is dropped.
  const switchActiveLayer = (id) => {
    if (!layerById(id)) return;
    if (activeIdRef.current === id) return;
    settleGesture();
    setActiveId(id);
    // The layout effect rebinds the aliases + object state after the commit;
    // do it eagerly too so an immediately-following paint targets the new layer.
    bindActiveLayerRefs();
    syncObjects(activeLayer().objects, null);
    clearMask();
    setDirty(true);
    scheduleOverlay();
  };

  // Discard a layer's record + canvases (used by layer/folder delete).
  const discardLayerRecord = (id) => {
    const i = layersRef.current.findIndex(l => l.id === id);
    if (i >= 0) layersRef.current.splice(i, 1);
    layerElsRef.current.delete(id);
    layerCtxsRef.current.delete(id);
    thumbElsRef.current.delete(id);
    clipMaskElsRef.current.delete(id);
    binderCacheRef.current.delete(`${id}:fill`);
    binderCacheRef.current.delete(`${id}:objects`);
    binderCacheRef.current.delete(`${id}:paint`);
    binderCacheRef.current.delete(`${id}:clip`);
  };
  const ensureActiveLayer = () => {
    if (layerById(activeIdRef.current)) return;
    const first = layersRef.current[0];
    if (!first) return;
    setActiveId(first.id);
    bindActiveLayerRefs();
    syncObjects(first.objects, null);
  };

  const addLayer = () => {
    settleGesture();
    pushSnapshot();
    const layer = makeLayer(nextLayerName());
    layersRef.current.push(layer); // order is rebuilt from the panel tree
    // A new layer sits directly ABOVE the active layer (inside its folder when
    // the active layer is nested).
    const slot = findLayerSlot(activeIdRef.current);
    if (slot && slot.folder) slot.folder.children.splice(slot.index, 0, layer.id);
    else if (slot) panelRef.current.splice(slot.index, 0, { type: 'layer', id: layer.id });
    else panelRef.current.unshift({ type: 'layer', id: layer.id });
    syncLayerOrder();
    syncLayersView();
    setActiveId(layer.id);
    syncObjects(layer.objects, null);
    setDirty(true);
    scheduleOverlay();
  };

  // Remove a layer and everything on it. The last remaining layer cannot be
  // deleted (delete is disabled); wiping uses Clear instead.
  const deleteLayer = (id) => {
    if (layersRef.current.length <= 1) return;
    settleGesture();
    pushSnapshot();
    detachLayerNode(id);
    discardLayerRecord(id);
    syncLayerOrder();
    ensureActiveLayer();
    syncLayersView();
    setDirty(true);
    scheduleOverlay();
  };

  const startRenameLayer = (layer) => {
    setEditingLayerId(layer.id);
    setLayerNameDraft(layer.name);
  };
  const commitRenameLayer = () => {
    const id = editingLayerId;
    setEditingLayerId(null);
    if (!id) return;
    const layer = layerById(id);
    const name = String(layerNameDraft || '').trim().slice(0, 48);
    if (!layer || !name || name === layer.name) return;
    pushSnapshot();
    layer.name = name;
    syncLayersView();
    setDirty(true);
  };

  // ── Folders (first-class panel nodes) ──────────────────────
  const nextFolderName = () => {
    const used = new Set(panelRef.current.filter(n => n.type === 'folder').map(n => n.name));
    let i = used.size + 1;
    while (used.has(`Folder ${i}`)) i++;
    return `Folder ${i}`;
  };
  const addFolder = () => {
    settleGesture();
    pushSnapshot();
    const id = `fd${folderIdSeqRef.current++}`;
    const name = nextFolderName();
    panelRef.current.unshift({ type: 'folder', id, name, visible: true, children: [] });
    syncLayersView();
    setDirty(true);
    setEditingFolderId(id);
    setFolderNameDraft(name);
  };
  // Delete a folder AND every layer inside it (same as deleting each layer). A
  // non-empty folder confirms first.
  const deleteFolder = (id) => {
    const node = folderNodeById(id);
    if (!node) return;
    const members = [...node.children];
    const doDelete = () => {
      settleGesture();
      pushSnapshot();
      panelRef.current = panelRef.current.filter(n => !(n.type === 'folder' && n.id === id));
      for (const cid of members) discardLayerRecord(cid);
      // The canvas always needs at least one layer.
      if (layersRef.current.length === 0) {
        const fresh = makeLayer('Layer 1');
        layersRef.current.push(fresh);
        panelRef.current.push({ type: 'layer', id: fresh.id });
      }
      syncLayerOrder();
      ensureActiveLayer();
      syncLayersView();
      setDirty(true);
      scheduleOverlay();
    };
    if (members.length === 0) { doDelete(); return; }
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      () => t('livery_layers_delete_folder_confirm_title'),
      () => <p>{t('livery_layers_delete_folder_confirm_body', { count: members.length })}</p>,
      () => (
        <>
          <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
          <button className="btn-danger" onClick={() => { hideModal(); doDelete(); }}>{t('livery_layers_delete_folder')}</button>
        </>
      ),
    );
  };
  const startRenameFolder = (node) => {
    setEditingFolderId(node.id);
    setFolderNameDraft(node.name);
  };
  const commitRenameFolder = () => {
    const id = editingFolderId;
    setEditingFolderId(null);
    if (!id) return;
    const node = folderNodeById(id);
    const name = String(folderNameDraft || '').trim().slice(0, 48);
    if (!node || !name || name === node.name) return;
    pushSnapshot();
    node.name = name;
    syncLayersView();
    setDirty(true);
  };
  const toggleFolderCollapsed = (id) => {
    setCollapsedFolders(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  // Hide/show a whole folder: every layer inside follows the folder's flag (a
  // layer's own flag is preserved for when the folder is shown again). If the
  // active layer becomes hidden, editing moves to the next visible layer.
  const toggleFolderVisible = (id) => {
    const node = folderNodeById(id);
    if (!node) return;
    pushSnapshot();
    node.visible = node.visible === false;
    if (!node.visible && !layerEffectiveVisible(activeIdRef.current)) {
      const next = layersRef.current.find(l => layerEffectiveVisible(l.id));
      if (next) {
        setActiveId(next.id);
        bindActiveLayerRefs();
        syncObjects(next.objects, null);
      }
    }
    syncLayersView();
    setDirty(true);
    scheduleOverlay();
  };

  // Hiding the active layer moves the target to the next visible one; when the
  // hidden layer was the LAST visible one there is no successor, so it simply
  // stays active (edits keep landing on it, invisibly, until it is shown again —
  // the same as hiding a whole folder). Opacity is deliberately NOT part of
  // this: a layer faded to 0% stays active and paintable, and its
  // rasters/objects are preserved for a fade back in.
  const toggleLayerVisible = (id) => {
    const layer = layerById(id);
    if (!layer) return;
    pushSnapshot();
    layer.visible = !layer.visible;
    if (!layer.visible && activeIdRef.current === id) {
      const next = layersRef.current.find(l => l.visible && l.id !== id);
      if (next) {
        setActiveId(next.id);
        bindActiveLayerRefs();
        syncObjects(next.objects, null);
      }
    }
    syncLayersView();
    setDirty(true);
    scheduleOverlay();
  };

  // Clip/unclip a layer. Clipping never touches its rasters or objects, so
  // unclipping shows every edit again. The mask itself is derived at render
  // time from the clip base (see `clipBaseFor`).
  const toggleLayerClipped = (id) => {
    const layer = layerById(id);
    if (!layer) return;
    pushSnapshot();
    layer.clipped = !layer.clipped;
    syncLayersView();
    setDirty(true);
    scheduleOverlay();
  };

  // ── Per-layer opacity (0..100%, independent of the hide/show flag) ──
  // Only the compositing alpha changes — the layer's rasters/objects are never
  // modified, so 0% → 100% restores the original shape pixel-identically.
  // A slider drag is ONE undo step: the snapshot is pushed once when the
  // gesture starts (`opacityGestureRef`), then every tick mutates in place.
  const opacityGestureRef = useRef(null);
  const beginOpacityGesture = () => {
    if (!opacityGestureRef.current) {
      pushSnapshot();
      opacityGestureRef.current = true;
    }
  };
  const endOpacityGesture = () => { opacityGestureRef.current = null; };
  const setLayerOpacity = (id, pct) => {
    const layer = layerById(id);
    if (!layer) return;
    const v = Math.round(Number(pct));
    if (!isFinite(v)) return;
    beginOpacityGesture();
    const next = Math.max(0, Math.min(100, v)) / 100;
    if (Math.abs(normalizeLayerOpacity(layer.opacity) - next) < 0.0005) return;
    layer.opacity = next;
    syncLayersView();
    setDirty(true);
    scheduleOverlay();
  };

  // ── Row-drag guard (opacity slider / rename input vs layer reorder) ──
  // The layer row is HTML5-`draggable`, and `dragstart` targets the row itself
  // — so a press that begins on the opacity slider (or the rename input) would
  // otherwise start a layer-reorder drag instead of adjusting the control.
  // The control marks the in-progress press (`rowDragGuardRef`) on pointerdown
  // and the row's `onDragStart` cancels the reorder while it is set. Cleared on
  // release/cancel/blur so normal row drags keep working.
  const rowDragGuardRef = useRef(false);
  useEffect(() => {
    const clear = () => { rowDragGuardRef.current = false; };
    window.addEventListener('pointerup', clear);
    window.addEventListener('pointercancel', clear);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('pointerup', clear);
      window.removeEventListener('pointercancel', clear);
      window.removeEventListener('blur', clear);
    };
  }, []);
  const guardRowDragProps = {
    onPointerDown: () => { rowDragGuardRef.current = true; },
  };

  // ── Drag & drop (operates on the panel tree, never stack indices) ──
  // Detach a layer node from wherever it sits (root or a folder).
  const detachLayerNode = (id) => {
    const slot = findLayerSlot(id);
    if (!slot) return;
    if (slot.folder) slot.folder.children.splice(slot.index, 1);
    else panelRef.current.splice(slot.index, 1);
  };
  const removeFolderNode = (id) => {
    const i = panelRef.current.findIndex(n => n.type === 'folder' && n.id === id);
    return i >= 0 ? panelRef.current.splice(i, 1)[0] : null;
  };
  const commitStructure = () => { syncLayerOrder(); syncLayersView(); setDirty(true); scheduleOverlay(); };

  // Insert a layer relative to an anchor layer (panel 'above' = earlier index).
  const insertLayerNear = (draggedId, anchorId, pos) => {
    if (!draggedId || draggedId === anchorId) return;
    if (!layerById(draggedId) || !layerById(anchorId)) return;
    settleGesture();
    pushSnapshot();
    detachLayerNode(draggedId);
    const slot = findLayerSlot(anchorId);
    if (!slot) return;
    const at = pos === 'above' ? slot.index : slot.index + 1;
    if (slot.folder) slot.folder.children.splice(at, 0, draggedId);
    else panelRef.current.splice(at, 0, { type: 'layer', id: draggedId });
    commitStructure();
  };
  // Move a layer into a folder, at the TOP of its members.
  const moveIntoFolder = (draggedId, folderId) => {
    if (!draggedId || !layerById(draggedId)) return;
    settleGesture();
    pushSnapshot();
    detachLayerNode(draggedId);
    const node = folderNodeById(folderId);
    if (!node) return;
    node.children.unshift(draggedId);
    commitStructure();
  };
  // Drop a layer immediately above a folder node (becoming a root layer).
  const moveAboveFolder = (draggedId, folderId) => {
    if (!draggedId || !layerById(draggedId)) return;
    settleGesture();
    pushSnapshot();
    detachLayerNode(draggedId);
    const fi = panelRef.current.findIndex(n => n.type === 'folder' && n.id === folderId);
    if (fi < 0) panelRef.current.push({ type: 'layer', id: draggedId });
    else panelRef.current.splice(fi, 0, { type: 'layer', id: draggedId });
    commitStructure();
  };
  const moveToRoot = (draggedId) => {
    if (!draggedId || !layerById(draggedId)) return;
    settleGesture();
    pushSnapshot();
    detachLayerNode(draggedId);
    panelRef.current.push({ type: 'layer', id: draggedId });
    commitStructure();
  };
  // Move a whole folder node; its member layers travel in `children`, so they
  // stay together and no other folder moves.
  const moveFolderNode = (folderId, anchor) => {
    settleGesture();
    pushSnapshot();
    const node = removeFolderNode(folderId);
    if (!node) return;
    let at = panelRef.current.length;
    if (anchor.kind === 'folder') {
      const i = panelRef.current.findIndex(n => n.type === 'folder' && n.id === anchor.id);
      at = i < 0 ? panelRef.current.length : (anchor.pos === 'above' ? i : i + 1);
    } else if (anchor.kind === 'layer') {
      const slot = findLayerSlot(anchor.id);
      if (slot && slot.folder) {
        const i = panelRef.current.indexOf(slot.folder);
        at = i < 0 ? panelRef.current.length : (anchor.pos === 'above' ? i : i + 1);
      } else if (slot) {
        at = anchor.pos === 'above' ? slot.index : slot.index + 1;
      }
    } else {
      at = anchor.pos === 'below' ? 0 : panelRef.current.length;
    }
    panelRef.current.splice(Math.max(0, Math.min(panelRef.current.length, at)), 0, node);
    commitStructure();
  };

  const handleDrop = (target) => {
    const dragged = dragItemRef.current;
    dragItemRef.current = null;
    setDragOverKey(null);
    if (!dragged || !target) return;
    if (dragged.kind === 'folder') {
      if (target.kind === 'folder' && target.id === dragged.id) return;
      if (target.kind === 'layer') {
        const slot = findLayerSlot(target.id);
        if (slot && slot.folder && slot.folder.id === dragged.id) return;
      }
      moveFolderNode(dragged.id, target);
      return;
    }
    if (target.kind === 'folder') {
      if (target.pos === 'into') moveIntoFolder(dragged.id, target.id);
      else moveAboveFolder(dragged.id, target.id);
    } else if (target.kind === 'root') {
      moveToRoot(dragged.id);
    } else if (target.kind === 'layer') {
      insertLayerNear(dragged.id, target.id, target.pos);
    }
  };
  const onDragStartItem = (e, kind, id) => {
    dragItemRef.current = { kind, id };
    try {
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }
    } catch (_) { /* some environments lack dataTransfer */ }
  };
  const onDragEndItem = () => { dragItemRef.current = null; setDragOverKey(null); };
  const dropKeyOf = (target) => `${target.kind}:${target.id || ''}:${target.pos || ''}`;
  const dropClass = (kind, id) => {
    const prefix = `${kind}:${id || ''}:`;
    if (!dragOverKey || !dragOverKey.startsWith(prefix)) return '';
    const pos = dragOverKey.slice(prefix.length);
    return pos ? ` lp-layer-drop-${pos}` : ' lp-layer-drop';
  };
  // Which half/strip of a row or folder header the pointer is over.
  const zonePos = (e, el, kind) => {
    const r = el.getBoundingClientRect();
    const y = e.clientY - r.top;
    const h = r.height || 1;
    if (kind === 'folder') {
      const dragging = dragItemRef.current;
      if (dragging && dragging.kind === 'folder') return y < h / 2 ? 'above' : 'below';
      // Dragging a layer: the top strip drops it above the folder, the rest
      // drops it into the folder (at the top of its members).
      return y < h * 0.3 ? 'above' : 'into';
    }
    return y < h / 2 ? 'above' : 'below';
  };
  const dropProps = (base) => ({
    onDragOver: (e) => {
      e.preventDefault();
      const pos = zonePos(e, e.currentTarget, base.kind);
      const k = dropKeyOf({ ...base, pos });
      setDragOverKey(prev => (prev === k ? prev : k));
    },
    onDrop: (e) => {
      e.preventDefault();
      const pos = zonePos(e, e.currentTarget, base.kind);
      handleDrop({ ...base, pos });
    },
  });

  // ── Layer thumbnails (50×50, sampled on a low ~2s cadence) ─
  const renderLayerThumb = (layer) => {
    const c = thumbElsRef.current.get(layer.id);
    const cc = c && c.getContext && c.getContext('2d');
    if (!cc) return;
    const S = c.width || LAYER_THUMB_SIZE;
    const s = Math.min(S / W, S / H);
    const ox = (S - W * s) / 2;
    const oy = (S - H * s) / 2;
    cc.save();
    if (cc.setTransform) cc.setTransform(1, 0, 0, 1, 0, 0);
    if (cc.clearRect) cc.clearRect(0, 0, S, S);
    if (cc.translate) cc.translate(ox, oy);
    if (cc.scale) cc.scale(s, s);
    const fc = layerEl(layer.id, 'fill');
    if (fc) cc.drawImage(fc, 0, 0);
    for (const o of layer.objects) {
      if (hasLiveVisual(o)) paintObjectInPanel(cc, o);
    }
    const pc = layerEl(layer.id, 'paint');
    if (pc) cc.drawImage(pc, 0, 0);
    cc.restore();
  };
  // The locked base texture preview (opaque white behind the atlas).
  const renderBaseThumb = () => {
    const c = baseThumbRef.current;
    const cc = c && c.getContext && c.getContext('2d');
    if (!cc || !baseCanvasRef.current) return;
    const S = c.width || LAYER_THUMB_SIZE;
    const s = Math.min(S / W, S / H);
    const ox = (S - W * s) / 2;
    const oy = (S - H * s) / 2;
    cc.save();
    if (cc.setTransform) cc.setTransform(1, 0, 0, 1, 0, 0);
    if (cc.fillStyle !== undefined) cc.fillStyle = '#ffffff';
    if (cc.fillRect) cc.fillRect(0, 0, S, S);
    if (cc.translate) cc.translate(ox, oy);
    if (cc.scale) cc.scale(s, s);
    cc.drawImage(baseCanvasRef.current, 0, 0);
    cc.restore();
  };

  // ── Layer persistence ──────────────────────────────────────
  // Slice a full-store canvas into one 2048² PNG per panel (same cut as
  // `exportParts`), so each layer's fill/paint and the locked base round-trip.
  const panelSliceUrls = (canvas) => {
    const out = [];
    for (let i = 0; i < panelCount; i++) {
      const c = document.createElement('canvas');
      c.width = TEXTURE; c.height = TEXTURE;
      const cc = c.getContext('2d');
      if (cc && canvas) cc.drawImage(canvas, layout.x(i), 0, TEXTURE, TEXTURE, 0, 0, TEXTURE, TEXTURE);
      out.push(c.toDataURL('image/png'));
    }
    return out;
  };
  // Full, lossless snapshot of the layer stack for the on-disk sidecar. The
  // game still reads the flattened BaseMap; this is editor-only bookkeeping.
  const exportLayers = () => {
    const baseUrls = panelSliceUrls(baseCanvasRef.current);
    const base = { panels: panelNames.map((pn, i) => ({ partName: pn, imageDataUrl: baseUrls[i] })) };
    const layers = layersRef.current.map(l => {
      const paintUrls = panelSliceUrls(layerEl(l.id, 'paint'));
      const fillUrls = panelSliceUrls(layerEl(l.id, 'fill'));
      return {
        id: l.id,
        name: l.name,
        visible: l.visible,
        opacity: normalizeLayerOpacity(l.opacity),
        clipped: !!l.clipped,
        objects: l.objects.map(serializeLayerObject).filter(Boolean),
        panels: panelNames.map((pn, i) => ({
          partName: pn,
          paintDataUrl: paintUrls[i],
          fillDataUrl: fillUrls[i],
        })),
      };
    });
    return {
      version: 2,
      activeId: activeIdRef.current,
      base,
      // The ordered panel tree (folders + root layers) — folders keep their
      // position independently of member layers.
      panel: panelSnapshot(),
      layers,
    };
  };
  // Paint one 2048² panel of a layer's fill/paint raster from a saved data URL.
  const paintRasterPanel = (layerId, kind, index, url) => {
    if (!url) return;
    const c = ctxFor(layerId, kind);
    if (!c) return;
    const img = new Image();
    img.onload = () => {
      try {
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalCompositeOperation = 'source-over';
        c.globalAlpha = 1;
        c.drawImage(img, layout.x(index), 0, TEXTURE, TEXTURE);
        c.restore();
      } catch (_) { /* stub context */ }
      invalidateLayerPixels(layerById(layerId));
      scheduleOverlay();
    };
    img.src = url;
  };
  // Apply a just-loaded sidecar payload's rasters + locked base. Runs after the
  // layer canvases have mounted.
  const applyLoadedLayers = (pending) => {
    if (!pending) return;
    for (const rec of pending.recs) {
      const panels = rec.savedPanels || [];
      rec.savedPanels = null;
      for (let i = 0; i < panelCount; i++) {
        const p = panels[i];
        if (!p) continue;
        paintRasterPanel(rec.id, 'paint', i, p.paintDataUrl);
        paintRasterPanel(rec.id, 'fill', i, p.fillDataUrl);
      }
      invalidateLayerPixels(rec);
    }
    if (Array.isArray(pending.basePanels) && pending.basePanels.length) {
      const bctx = baseCtxRef.current;
      if (bctx) {
        drawBase(bctx, layout, pending.basePanels, () => {
          try { basePixelsRef.current = bctx.getImageData(0, 0, W, H); } catch (_) {}
          scheduleOverlay();
        });
      }
    }
  };
  // Rebuild the whole layer stack from a persisted payload. Returns false for a
  // missing/invalid payload (a legacy livery with no sidecar → one empty layer).
  const loadLayers = (payload) => {
    if (!payload || !Array.isArray(payload.layers) || payload.layers.length === 0) return false;
    const idMap = new Map(); // saved layer id -> fresh id
    const recs = payload.layers.map((ls, i) => {
      const layer = makeLayer(ls.name || `Layer ${i + 1}`);
      layer.visible = ls.visible !== false;
      layer.opacity = normalizeLayerOpacity(ls.opacity);
      layer.clipped = ls.clipped === true;
      layer.objects = (Array.isArray(ls.objects) ? ls.objects : [])
        .map(raw => deserializeLayerObject(raw, () => nextIdRef.current++, W, H))
        .filter(Boolean);
      layer.savedPanels = Array.isArray(ls.panels) ? ls.panels : [];
      if (ls.id) idMap.set(String(ls.id), layer.id);
      return layer;
    });
    // Build the panel tree. `version 2` carries an explicit `panel`; older
    // sidecars are migrated from `folders`+layer.folder or `group` names.
    const sanitizeNode = (n) => {
      if (!n || typeof n !== 'object') return null;
      if (n.type === 'layer') { const id = idMap.get(String(n.id)); return id ? { type: 'layer', id } : null; }
      if (n.type === 'folder') {
        const children = (Array.isArray(n.children) ? n.children : [])
          .map(cid => idMap.get(String(cid))).filter(Boolean);
        return { type: 'folder', id: `fd${folderIdSeqRef.current++}`, name: String(n.name || 'Folder').slice(0, 48), visible: n.visible !== false, children };
      }
      return null;
    };
    let panel = Array.isArray(payload.panel) ? payload.panel.map(sanitizeNode).filter(Boolean) : null;
    if (!panel) {
      const folderByName = new Map();
      const folderByOldId = new Map();
      const makeFolder = (name) => {
        const f = { type: 'folder', id: `fd${folderIdSeqRef.current++}`, name: String(name || 'Folder').slice(0, 48), visible: true, children: [] };
        if (!folderByName.has(f.name)) folderByName.set(f.name, f);
        return f;
      };
      if (Array.isArray(payload.folders)) {
        for (const f of payload.folders) {
          if (f && f.id) folderByOldId.set(String(f.id), makeFolder(f.name));
        }
      }
      const order = [];
      // Layers are stored bottom→top; emit the panel top→bottom.
      for (let i = payload.layers.length - 1; i >= 0; i--) {
        const ls = payload.layers[i];
        const newId = idMap.get(String(ls.id));
        if (!newId) continue;
        let folder = null;
        if (ls.folder) folder = folderByOldId.get(String(ls.folder)) || null;
        else if (ls.group) folder = folderByName.get(String(ls.group)) || makeFolder(ls.group);
        if (folder) {
          if (!order.includes(folder)) order.push(folder);
          folder.children.push(newId);
        } else {
          order.push({ type: 'layer', id: newId });
        }
      }
      // Folders that ended up empty sit at the top (the old renderer's rule).
      for (const f of folderByName.values()) if (!order.includes(f)) order.unshift(f);
      panel = order;
    }
    const idx = payload.layers.findIndex(ls => ls.id === payload.activeId);
    const activeRec = recs[idx >= 0 ? idx : 0];
    // Retire the placeholder layer's canvases/contexts.
    for (const l of layersRef.current) {
      layerElsRef.current.delete(l.id);
      layerCtxsRef.current.delete(l.id);
      thumbElsRef.current.delete(l.id);
      binderCacheRef.current.delete(`${l.id}:fill`);
      binderCacheRef.current.delete(`${l.id}:objects`);
      binderCacheRef.current.delete(`${l.id}:paint`);
      binderCacheRef.current.delete(`${l.id}:clip`);
    }
    clipMaskElsRef.current.clear();
    layersRef.current = recs;
    panelRef.current = (panel && panel.length) ? panel : [{ type: 'layer', id: recs[0].id }];
    syncLayerOrder();
    activeIdRef.current = activeRec.id;
    setActiveIdState(activeRec.id);
    syncObjects(activeRec.objects, null);
    syncLayersView();
    pendingLayersRef.current = {
      recs,
      basePanels: payload.base && Array.isArray(payload.base.panels)
        ? payload.base.panels.map(p => ({ partName: (p && p.partName) || 'Body', imageDataUrl: p && p.imageDataUrl }))
        : null,
    };
    setDirty(false);
    return true;
  };

  // Restore a saved layer stack once (the parent passes the sidecar it read).
  useEffect(() => {
    if (initialLayers && Array.isArray(initialLayers.layers) && initialLayers.layers.length) {
      loadLayers(initialLayers);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLayers]);

  // Keep the 50×50 previews fresh on a low cadence (plus immediately whenever
  // the panel structure changes). Cheap: ~10 draws of a 50px canvas.
  useEffect(() => {
    const tick = () => { renderBaseThumb(); for (const l of layersRef.current) renderLayerThumb(l); };
    tick();
    const iv = setInterval(tick, LAYER_THUMB_INTERVAL_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layersView, panelView]);

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
          {tool === 'brush' && (
            <span className="lp-seg" role="group" aria-label={t('livery_paint_brush_mode')}>
              {/* Brush sub-modes: normal paint vs the colour-mixing Blur pen.
                  B / S switch to the Brush tool and pick the mode (any tool). */}
              <button className={brushMode === 'paint' ? 'lp-on' : ''} {...bind(withKey(t('livery_paint_brush_paint'), 'B'))} aria-label={t('livery_paint_brush_paint')} aria-pressed={brushMode === 'paint'} onClick={() => setBrushMode('paint')}><IoBrushOutline size={15} /></button>
              <button className={brushMode === 'blur' ? 'lp-on' : ''} {...bind(withKey(t('livery_paint_blur'), 'S'))} aria-label={t('livery_paint_blur')} aria-pressed={brushMode === 'blur'} onClick={() => setBrushMode('blur')}><MdBlurOn size={15} /></button>
            </span>
          )}
          {(tool === 'brush' || tool === 'eraser') && (
            <label className="lp-field">{t('livery_paint_size')}
              <input type="range" min={1} max={200} value={brush.size} onChange={(e) => setBrush({ ...brush, size: Number(e.target.value) })} />
              <NumberInput value={brush.size} min={1} max={200} onCommit={(v) => setBrush({ ...brush, size: v })} ariaLabel={t('livery_paint_size')} />
            </label>
          )}
          {tool === 'brush' && (
            <label className="lp-field">{t('livery_paint_hardness')}
              <input type="range" min={0} max={100} value={hardnessPct} onChange={(e) => setBrush({ ...brush, hardness: Number(e.target.value) / 100 })} />
              <NumberInput value={hardnessPct} min={0} max={100} onCommit={(v) => setBrush({ ...brush, hardness: v / 100 })} ariaLabel={t('livery_paint_hardness')} suffix="%" />
            </label>
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
          className={'livery-canvas-wrap' + (inputDisabled ? ' lp-input-locked' : '')}
          tabIndex={0}
          aria-disabled={inputDisabled || undefined}
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
            {/* Editable layers, bottom → top. Each layer owns a fill raster
                (under its movables), an objects canvas (its live movables) and a
                pen raster (above its movables). DOM order is the composite
                z-order; hidden layers keep their canvases mounted (so their
                pixels/contexts survive) but are not displayed. */}
            {layersView.map((l) => {
              const effVisible = layerEffectiveVisible(l.id);
              const layerOpacity = normalizeLayerOpacity(l.opacity);
              // A clipped layer shows its masked composite canvas; its raw
              // fill / objects / paint canvases stay mounted (pixels + contexts
              // survive) but hidden, so its edits are preserved for unclipping.
              // Layer opacity rides as CSS opacity on the DISPLAYED canvas(es)
              // only — the stored rasters keep full alpha for a fade back in.
              const storageStyle = {
                position: 'absolute', left: 0, top: 0,
                width: W * effZoom, height: H * effZoom,
                pointerEvents: 'none',
                display: (effVisible && !l.clipped) ? 'block' : 'none',
                opacity: layerOpacity,
              };
              const clipStyle = { ...storageStyle, display: (effVisible && l.clipped) ? 'block' : 'none' };
              return (
                <React.Fragment key={l.id}>
                  <canvas
                    ref={layerBinder(l.id, 'fill')}
                    data-layer="fill"
                    data-layer-id={l.id}
                    width={W}
                    height={H}
                    style={storageStyle}
                    aria-hidden="true"
                  />
                  <canvas
                    ref={layerBinder(l.id, 'objects')}
                    data-layer="objects"
                    data-layer-id={l.id}
                    width={W}
                    height={H}
                    style={storageStyle}
                    aria-hidden="true"
                  />
                  <canvas
                    ref={layerBinder(l.id, 'paint')}
                    data-layer="paint"
                    data-layer-id={l.id}
                    width={W}
                    height={H}
                    style={storageStyle}
                    aria-hidden="true"
                  />
                  {l.clipped && (
                    <canvas
                      ref={layerBinder(l.id, 'clip')}
                      data-layer="clip"
                      data-layer-id={l.id}
                      width={W}
                      height={H}
                      style={clipStyle}
                      aria-hidden="true"
                    />
                  )}
                </React.Fragment>
              );
            })}
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
                {tool === 'brush' && ringCoreDiameter > 2 && ringCoreDiameter < ringDiameter - 2 && (
                  <div
                    className="lp-cursor-core"
                    style={{ width: ringCoreDiameter, height: ringCoreDiameter }}
                  />
                )}
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
        {/* ── Right-hand layer panel ── */}
        <aside className="lp-layers" aria-label={t('livery_layers')}>
          <div className="lp-layers-head">
            <span className="lp-layers-title">{t('livery_layers')}</span>
            <span className="lp-layers-head-actions">
              <button
                className="lp-layer-mini"
                title={t('livery_layers_add')}
                aria-label={t('livery_layers_add')}
                onClick={addLayer}
              >
                <IoAddOutline size={16} />
              </button>
              <button
                className="lp-layer-mini"
                title={t('livery_layers_new_folder')}
                aria-label={t('livery_layers_new_folder')}
                onClick={addFolder}
              >
                <IoFolderOutline size={16} />
              </button>
            </span>
          </div>
          <div className="lp-layers-list" role="list">
            {(() => {
              const rows = [];
              const layerViewById = (id) => layersView.find(l => l.id === id) || null;
              const layerRow = (l, nested) => {
                if (!l) return null;
                const isActive = l.id === activeId;
                const effVisible = layerEffectiveVisible(l.id);
                const opacityPct = Math.round(normalizeLayerOpacity(l.opacity) * 100);
                return (
                  <div
                    className={'lp-layer-row' + (isActive ? ' lp-layer-active' : '') + (effVisible ? '' : ' lp-layer-hidden') + (nested ? ' lp-layer-nested' : '') + (l.clipped ? ' lp-layer-clipped' : '') + dropClass('layer', l.id)}
                    key={l.id}
                    role="listitem"
                    draggable
                    aria-current={isActive || undefined}
                    onClick={() => switchActiveLayer(l.id)}
                    onDragStart={(e) => {
                      // A press that began on the opacity slider or the rename
                      // input adjusts that control — cancel the reorder drag.
                      if (rowDragGuardRef.current) { e.preventDefault(); return; }
                      onDragStartItem(e, 'layer', l.id);
                    }}
                    onDragEnd={onDragEndItem}
                    {...dropProps({ kind: 'layer', id: l.id })}
                  >
                    <canvas
                      ref={bindThumbEl(l.id)}
                      className="lp-layer-thumb"
                      width={LAYER_THUMB_SIZE}
                      height={LAYER_THUMB_SIZE}
                      style={{ opacity: normalizeLayerOpacity(l.opacity) }}
                      aria-hidden="true"
                    />
                    {/* Name + opacity share the middle column, right of the
                        thumbnail: the name reads on the top line with its
                        percentage, the slider sits directly beneath it. This
                        keeps the row at the thumbnail's height (the slider no
                        longer adds a wrapped full-width line). */}
                    <div className="lp-layer-main">
                      <div className="lp-layer-toprow">
                        {editingLayerId === l.id ? (
                          <input
                            className="lp-layer-name-input"
                            autoFocus
                            value={layerNameDraft}
                            maxLength={48}
                            aria-label={t('livery_layers_rename')}
                            onChange={(e) => setLayerNameDraft(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            {...guardRowDragProps}
                            onBlur={commitRenameLayer}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Enter') e.target.blur();
                              else if (e.key === 'Escape') setEditingLayerId(null);
                            }}
                          />
                        ) : (
                          <span
                            className="lp-layer-name"
                            title={l.name}
                            onDoubleClick={() => startRenameLayer(l)}
                          >
                            {l.name}
                          </span>
                        )}
                        <span className="lp-layer-opacity-val" title={`${t('livery_layers_opacity')} (${opacityPct}%)`} aria-hidden="true">{opacityPct}%</span>
                      </div>
                      {/* Per-layer opacity (0–100%), independent of the eye
                          toggle: only the compositing alpha — rasters/objects
                          untouched. */}
                      <div
                        className="lp-layer-opacity"
                        onClick={(e) => e.stopPropagation()}
                        {...guardRowDragProps}
                      >
                        <input
                          type="range"
                          className="lp-layer-opacity-slider"
                          min={0}
                          max={100}
                          value={opacityPct}
                          title={`${t('livery_layers_opacity')} (${opacityPct}%)`}
                          aria-label={t('livery_layers_opacity')}
                          onChange={(e) => setLayerOpacity(l.id, Number(e.target.value))}
                          onPointerUp={endOpacityGesture}
                          onPointerCancel={endOpacityGesture}
                          onBlur={endOpacityGesture}
                        />
                      </div>
                    </div>
                    <span className="lp-layer-actions">
                      {/* 2×2 grid: visibility + clip on the top row, rename +
                          delete on the bottom row. It spans the full row height
                          so the name/slider column owns the card layout. */}
                      <button className="lp-layer-mini" title={l.visible ? t('livery_layers_hide') : t('livery_layers_show')} aria-label={l.visible ? t('livery_layers_hide') : t('livery_layers_show')} aria-pressed={l.visible} onClick={(e) => { e.stopPropagation(); toggleLayerVisible(l.id); }}>
                        {l.visible ? <IoEyeOutline size={15} /> : <IoEyeOffOutline size={15} />}
                      </button>
                      <button className={'lp-layer-mini lp-layer-clip' + (l.clipped ? ' lp-layer-clip--on' : '')} title={l.clipped ? t('livery_layers_unclip') : t('livery_layers_clip')} aria-label={l.clipped ? t('livery_layers_unclip') : t('livery_layers_clip')} aria-pressed={Boolean(l.clipped)} onClick={(e) => { e.stopPropagation(); toggleLayerClipped(l.id); }}>
                        {l.clipped ? <IoLinkOutline size={15} /> : <IoUnlinkOutline size={15} />}
                      </button>
                      <button className="lp-layer-mini" title={t('livery_layers_rename')} aria-label={t('livery_layers_rename')} onClick={(e) => { e.stopPropagation(); startRenameLayer(l); }}>
                        <IoPencilOutline size={13} />
                      </button>
                      <button className="lp-layer-mini lp-danger" title={t('livery_layers_delete')} aria-label={t('livery_layers_delete')} disabled={layersView.length <= 1} onClick={(e) => { e.stopPropagation(); deleteLayer(l.id); }}>
                        <IoTrashOutline size={13} />
                      </button>
                    </span>
                  </div>
                );
              };
              const folderHeader = (node) => {
                const collapsed = collapsedFolders.has(node.id);
                const grabbable = node.children.length > 0;
                return (
                  <div
                    className={'lp-layer-folder' + (collapsed ? ' lp-layer-folder--collapsed' : '') + (!folderVisible(node) ? ' lp-layer-folder--hidden' : '') + dropClass('folder', node.id) + (grabbable ? ' lp-layer-folder--grab' : '')}
                    key={`f:${node.id}`}
                    draggable={grabbable}
                    onDragStart={grabbable ? (e) => onDragStartItem(e, 'folder', node.id) : undefined}
                    onDragEnd={onDragEndItem}
                    {...dropProps({ kind: 'folder', id: node.id })}
                  >
                    <button
                      className="lp-layer-folder-toggle"
                      aria-label={collapsed ? t('livery_layers_expand') : t('livery_layers_collapse')}
                      onClick={() => toggleFolderCollapsed(node.id)}
                    >
                      {collapsed ? <IoChevronForwardOutline size={13} /> : <IoChevronDownOutline size={13} />}
                    </button>
                    <IoFolderOutline size={14} className="lp-layer-folder-icon" />
                    {editingFolderId === node.id ? (
                      <input
                        className="lp-layer-name-input"
                        autoFocus
                        value={folderNameDraft}
                        maxLength={48}
                        aria-label={t('livery_layers_folder_rename')}
                        onChange={(e) => setFolderNameDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={commitRenameFolder}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') e.target.blur();
                          else if (e.key === 'Escape') setEditingFolderId(null);
                        }}
                      />
                    ) : (
                      <span
                        className="lp-layer-folder-name"
                        title={node.name}
                        onDoubleClick={() => startRenameFolder(node)}
                      >
                        {node.name}
                      </span>
                    )}
                    <span className="lp-layer-actions lp-layer-actions--row">
                      <button className="lp-layer-mini" title={folderVisible(node) ? t('livery_layers_hide') : t('livery_layers_show')} aria-label={folderVisible(node) ? t('livery_layers_hide') : t('livery_layers_show')} aria-pressed={folderVisible(node)} onClick={(e) => { e.stopPropagation(); toggleFolderVisible(node.id); }}>
                        {folderVisible(node) ? <IoEyeOutline size={15} /> : <IoEyeOffOutline size={15} />}
                      </button>
                      <button className="lp-layer-mini" title={t('livery_layers_folder_rename')} aria-label={t('livery_layers_folder_rename')} onClick={(e) => { e.stopPropagation(); startRenameFolder(node); }}>
                        <IoPencilOutline size={13} />
                      </button>
                      <button className="lp-layer-mini lp-danger" title={t('livery_layers_delete_folder')} aria-label={t('livery_layers_delete_folder')} onClick={(e) => { e.stopPropagation(); deleteFolder(node.id); }}>
                        <IoTrashOutline size={13} />
                      </button>
                    </span>
                  </div>
                );
              };
              for (const node of panelView) {
                if (node.type === 'layer') {
                  rows.push(layerRow(layerViewById(node.id), false));
                } else {
                  rows.push(folderHeader(node));
                  if (!collapsedFolders.has(node.id)) {
                    for (const cid of node.children) rows.push(layerRow(layerViewById(cid), true));
                  }
                }
              }
              return rows;
            })()}
            {/* Drop here to move a layer out of its folder; the locked base is
                always bottom-most. */}
            <div
              className={'lp-layer-row lp-layer-base' + dropClass('root', '')}
              role="listitem"
              {...dropProps({ kind: 'root' })}
            >
              <canvas
                ref={baseThumbRef}
                className="lp-layer-thumb lp-layer-thumb--base"
                width={LAYER_THUMB_SIZE}
                height={LAYER_THUMB_SIZE}
                aria-hidden="true"
              />
              <span className="lp-layer-eye lp-layer-locked" title={t('livery_layers_base_locked')}><IoLockClosed size={13} /></span>
              <span className="lp-layer-name">{t('livery_layers_base')}</span>
            </div>
          </div>
        </aside>
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
