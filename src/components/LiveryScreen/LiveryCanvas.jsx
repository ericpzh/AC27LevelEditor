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
} from '../../utils/liveryPaint';
import {
  IoBrushOutline,
  IoEyedropOutline,
  IoColorFillOutline,
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
import { FaEraser, FaRegHandPaper } from 'react-icons/fa';
import { FaArrowPointer } from 'react-icons/fa6';
import { TbSticker2 } from 'react-icons/tb';
import { HiDocumentDuplicate } from 'react-icons/hi';
import { CiBookmarkRemove } from 'react-icons/ci';
import { LuFlipHorizontal, LuFlipVertical } from 'react-icons/lu';
import useTooltip from '../BrowserScreen/useTooltip';

export const TEXTURE = 2048;

// Opaque fallback base for a new/cleared canvas. The BaseMap replaces the
// model's own texture, so a transparent background would render as holes.
export const DEFAULT_BASE_COLOR = '#ffffff';

// ── Base painting helpers (shared by mount + Clear) ──────────
function clearBase(ctx) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, TEXTURE, TEXTURE);
  ctx.restore();
}

function fillBase(ctx) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = DEFAULT_BASE_COLOR;
  ctx.fillRect(0, 0, TEXTURE, TEXTURE);
  ctx.restore();
}

// Paints the base texture: the given image when present, else the opaque
// neutral fill. `onDone` fires once the base is on the canvas (the image path
// is async).
function drawBase(ctx, dataUrl, onDone) {
  if (!dataUrl) { fillBase(ctx); if (onDone) onDone(); return; }
  const img = new Image();
  img.onload = () => {
    clearBase(ctx);
    ctx.drawImage(img, 0, 0, TEXTURE, TEXTURE);
    if (onDone) onDone();
  };
  img.onerror = () => { fillBase(ctx); if (onDone) onDone(); };
  img.src = dataUrl;
}

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

// Tools that surface a contextual options bar (select / eyedropper do not).
const TOOLS_WITH_OPTIONS = ['brush', 'eraser', 'fill', 'line', 'rect', 'ellipse', 'text'];

// Common fonts offered by the Text tool.
const FONT_OPTIONS = [
  'sans-serif', 'serif', 'monospace', 'Arial', 'Helvetica', 'Verdana',
  'Tahoma', 'Georgia', 'Times New Roman', 'Courier New', 'Impact',
  'Comic Sans MS', 'Microsoft YaHei', 'SimHei', 'SimSun', 'KaiTi',
];

// Zoom ladder for the +/- buttons.
const ZOOM_STEPS = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2];

// ── Live objects ───────────────────────────────────────────
// A live object is a non-destructive, moveable overlay element flattened onto
// the texture only at export: a sticker image (`kind: 'sticker'`, with `img`),
// a text box (`kind: 'text'`, with `text`/`font`/`size`/…), or a shape
// (`kind: 'line' | 'rect' | 'ellipse'`, with `color`/`width`/`filled`/`opacity`).
// Shared fields: x, y, w, h, rot, flipX, flipY, selected. Shapes are centred
// on their bounding box; lines use `w` = length, `h` = thickness, `rot` = angle.
const SHAPE_KINDS = ['line', 'rect', 'ellipse'];
const liveFont = (o) => `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${o.size}px ${o.font}`;

// True when a live object has a drawable/exportable payload.
function hasLiveVisual(o) {
  if (!o) return false;
  if (o.kind === 'text') return Boolean(o.text);
  if (SHAPE_KINDS.includes(o.kind)) return o.w > 0 || o.h > 0;
  return Boolean(o.img);
}

// Paint a live object centred on its own origin (caller positions the frame).
function paintLiveObject(ctx, o) {
  if (!ctx || !o) return;
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(o.rot || 0);
  ctx.scale(o.flipX ? -1 : 1, o.flipY ? -1 : 1);
  if (o.kind === 'text') {
    ctx.fillStyle = o.color || '#000000';
    ctx.font = liveFont(o);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(o.text, 0, 0);
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
    ctx.drawImage(o.img, -o.w / 2, -o.h / 2, o.w, o.h);
  }
  ctx.restore();
}

// Text box dimensions — real font metrics when the context supports them, a
// linear estimate otherwise (jsdom's context stub has no measureText).
function measureLiveText(ctx, text, o) {
  let w = 0;
  if (ctx && typeof ctx.measureText === 'function') {
    ctx.save();
    ctx.font = liveFont(o);
    const m = ctx.measureText(text);
    w = m && m.width;
    ctx.restore();
  }
  if (!w || !isFinite(w)) w = Math.max(8, String(text).length * o.size * 0.6);
  return { w, h: o.size * 1.2 };
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

/**
 * LiveryCanvas — flat 2048×2048 texture painter (P2).
 * Opaque base (per-aircraft template or a neutral fill), CSS-scaled view,
 * zoom in/out/fit, space-/middle-drag pan, coalesced pointer strokes. Stickers
 * are live, non-destructive moveable objects (select / move / scale / rotate)
 * flattened only on export.
 */
const LiveryCanvas = forwardRef(function LiveryCanvas(
  { initialImageDataUrl, onDirty },
  ref,
) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();
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
  const dragRef = useRef(null);
  const rafRef = useRef(0);
  const liveRef = useRef(null);
  const cursorRingRef = useRef(null);
  const toolRef = useRef('brush');
  const brushRef = useRef({ color: '#ff0000', size: 12, opacity: 1, hard: true });
  const shapeOptsRef = useRef({ width: 8, filled: true });
  const fillTolRef = useRef(32);
  const textOptsRef = useRef({ font: 'sans-serif', size: 120, bold: false, italic: false, color: '#000000' });

  const [tool, setToolState] = useState('brush');
  const [brush, setBrushState] = useState(brushRef.current);
  const [shapeOpts, setShapeOptsState] = useState(shapeOptsRef.current);
  const [fillTol, setFillTolState] = useState(32);
  const [textOpts, setTextOptsState] = useState(textOptsRef.current);
  const [zoom, setZoom] = useState('fit');
  const [fitScale, setFitScale] = useState(0.25);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [live, setLiveState] = useState(null);
  const [textAnchor, setTextAnchorState] = useState(null);
  const [textDraft, setTextDraftState] = useState('');
  const [dirty, setDirtyState] = useState(false);
  // Mirror the text-entry state in refs so commitText() can read the live
  // values from blur / tool-switch / canvas handlers without stale closures.
  const textAnchorRef = useRef(null);
  const textDraftRef = useRef('');

  const setTool = (v) => { toolRef.current = v; setToolState(v); };
  const setTextAnchor = (v) => { textAnchorRef.current = v; setTextAnchorState(v); };
  const setTextDraft = (v) => { textDraftRef.current = v; setTextDraftState(v); };
  const setBrush = (v) => { brushRef.current = v; setBrushState(v); };
  const setShapeOpts = (v) => { shapeOptsRef.current = v; setShapeOptsState(v); };
  const setTextOpts = (v) => { textOptsRef.current = v; setTextOptsState(v); };
  const setLive = (v) => {
    liveRef.current = v;
    setLiveState(v);
  };
  const setDirty = (v) => {
    setDirtyState(v);
    if (onDirty) onDirty(v);
  };

  const effZoom = zoom === 'fit' ? fitScale : zoom;

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
    setLive(null);
    setTextAnchor(null);
    drawBase(ctx, initialImageDataUrl, scheduleOverlay);
    scheduleOverlay();
    // Mount-only: the parent remounts (key) whenever the base changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialImageDataUrl]);

  // ── Fit zoom tracking ──────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth || 512;
      const h = el.clientHeight || 512;
      setFitScale(Math.max(0.05, Math.min(1, (Math.min(w, h) - 24) / TEXTURE)));
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

  const pushSnapshot = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    pushUndo(undoRef.current, ctx.getImageData(0, 0, TEXTURE, TEXTURE));
    setDirty(true);
  };

  const doUndo = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const prev = undoStep(undoRef.current, ctx.getImageData(0, 0, TEXTURE, TEXTURE));
    if (prev) {
      ctx.putImageData(prev, 0, 0);
      setDirty(true);
      scheduleOverlay();
    }
  }, []);

  const doRedo = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const next = redoStep(undoRef.current, ctx.getImageData(0, 0, TEXTURE, TEXTURE));
    if (next) {
      ctx.putImageData(next, 0, 0);
      setDirty(true);
      scheduleOverlay();
    }
  }, []);

  // ── Overlay (sticker + shape preview), rAF-throttled ───────
  const drawOverlay = useCallback(() => {
    rafRef.current = 0;
    const ov = overlayRef.current;
    if (!ov) return;
    const ctx = ov.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, TEXTURE, TEXTURE);
    ctx.restore();
    const st = liveRef.current;
    if (hasLiveVisual(st)) {
      const z = effZoom || 1;
      const gap = 40 / z;
      const hr = 7 / z;
      const active = st.selected && toolRef.current === 'select';
      // The visual (flip applied); the selection box below is drawn in the
      // unflipped frame so its handles stay put when mirrored.
      paintLiveObject(ctx, st);
      ctx.save();
      ctx.translate(st.x, st.y);
      ctx.rotate(st.rot || 0);
      ctx.lineWidth = (active ? 2 : 1) / z;
      ctx.strokeStyle = active ? '#6aa0ff' : 'rgba(106, 160, 255, 0.55)';
      ctx.setLineDash(active ? [] : [6 / z, 4 / z]);
      ctx.strokeRect(-st.w / 2, -st.h / 2, st.w, st.h);
      if (active) {
        // rotate handle (top-centre, on a connector) + resize handle (bottom-right)
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(0, -st.h / 2);
        ctx.lineTo(0, -st.h / 2 - gap);
        ctx.stroke();
        ctx.fillStyle = '#6aa0ff';
        ctx.beginPath(); ctx.arc(st.w / 2, st.h / 2, hr, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(0, -st.h / 2 - gap, hr, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    const sh = shapeRef.current;
    if (sh && sh.current) {
      drawShape(ctx, sh.tool, sh.start, sh.current, brushRef.current, shapeOptsRef.current, true);
    }
  }, [effZoom]);

  function scheduleOverlay() {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(drawOverlay);
  }

  useEffect(() => { scheduleOverlay(); }, [live, textAnchor, scheduleOverlay]);

  // Replace the current live object, stamping the old one onto the base first
  // so nothing is silently lost.
  const flattenLive = () => {
    const st = liveRef.current;
    const ctx = ctxRef.current;
    if (!st || !ctx) return;
    pushSnapshot();
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    paintLiveObject(ctx, st);
    ctx.restore();
  };

  // ── Sticker import (flush into a live, moveable object) ────
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
        flattenLive();
        setLive({ kind: 'sticker', img, w: w * k, h: h * k, x: TEXTURE / 2, y: TEXTURE / 2, rot: 0, flipX: false, flipY: false, selected: true });
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
    if (!liveRef.current) return;
    setLive(null);
    setDirty(true);
    scheduleOverlay();
  };

  const flipSticker = (axis) => {
    const st = liveRef.current;
    if (!st) return;
    setLive({ ...st, [axis]: !st[axis], selected: true });
    setDirty(true);
    scheduleOverlay();
  };

  // ── Duplicate: stamp the live object onto the base, keep a nudged copy ─
  const duplicateSticker = () => {
    const st = liveRef.current;
    const ctx = ctxRef.current;
    if (!st || !ctx) return;
    pushSnapshot();
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    paintLiveObject(ctx, st);
    ctx.restore();
    const nudge = Math.max(st.w, st.h) * 0.15 + 20;
    setLive({ ...st, x: st.x + nudge, y: st.y + nudge, selected: true });
    setTool('select');
    setDirty(true);
    scheduleOverlay();
  };

  // ── Export (opaque base + live object flattened) ───────────
  useImperativeHandle(ref, () => ({
    exportPNG() {
      const out = document.createElement('canvas');
      out.width = TEXTURE; out.height = TEXTURE;
      const ctx = out.getContext('2d');
      ctx.drawImage(canvasRef.current, 0, 0);
      paintLiveObject(ctx, liveRef.current);
      return out.toDataURL('image/png');
    },
    importSticker,
    removeSticker,
    duplicateSticker,
    isDirty: () => dirty,
  }), [dirty]);

  // ── Keyboard: shortcuts + undo/redo + Del ──────────────────
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key === 'Escape' && textAnchor) { setTextAnchor(null); setTextDraft(''); }
        return;
      }
      if (e.key === ' ') { spaceRef.current = true; setSpaceHeld(true); e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
      if (e.key === 'Escape') {
        if (liveRef.current && liveRef.current.selected) { setLive({ ...liveRef.current, selected: false }); scheduleOverlay(); }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (liveRef.current && liveRef.current.selected) { setLive(null); setDirty(true); scheduleOverlay(); }
        return;
      }
      const k = e.key.toLowerCase();
      const map = { a: 'select', b: 'brush', e: 'eraser', i: 'eyedropper', g: 'fill', l: 'line', r: 'rect', o: 'ellipse', t: 'text' };
      if (map[k] && TOOLS.includes(map[k])) { commitText(); setTool(map[k]); }
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
      x: (clientX - rect.left) * (TEXTURE / rect.width),
      y: (clientY - rect.top) * (TEXTURE / rect.height),
    };
  };
  const coalesced = (e) => {
    const n = e.nativeEvent;
    // jsdom returns [] here; fall back to the raw event in that case.
    const list = n.getCoalescedEvents ? n.getCoalescedEvents() : null;
    if (list && list.length) return list.map(p => toTexture(p.clientX, p.clientY));
    return [toTexture(n.clientX, n.clientY)];
  };

  // ── Brush strokes ──────────────────────────────────────────
  const strokeTo = (ctx, from, toPt, erase) => {
    const b = brushRef.current;
    ctx.save();
    if (erase) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#000';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = b.opacity;
      ctx.strokeStyle = b.color;
      if (!b.hard) { ctx.shadowColor = b.color; ctx.shadowBlur = b.size / 2; }
    }
    ctx.lineWidth = b.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(toPt.x, toPt.y);
    ctx.stroke();
    ctx.restore();
  };

  // ── Sticker hit-testing (local frame) ──────────────────────
  const stickerLocal = (st, p) => {
    const dx = p.x - st.x, dy = p.y - st.y;
    const c = Math.cos(-(st.rot || 0)), s = Math.sin(-(st.rot || 0));
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  };

  // Eyedropper shared by the Eyedropper tool and the right-click shortcut:
  // read the base pixel under `p` and make it the current brush colour.
  const pickColorAt = (p) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const x = Math.max(0, Math.min(TEXTURE - 1, p.x | 0));
    const y = Math.max(0, Math.min(TEXTURE - 1, p.y | 0));
    const d = ctx.getImageData(x, y, 1, 1).data;
    setBrush({ ...brushRef.current, color: rgbaToHex(d[0], d[1], d[2]) });
  };

  // ── Canvas pointer handlers ────────────────────────────────
  const onCanvasDown = (e) => {
    if (e.button === 1 || spaceRef.current) return; // pan handled by wrapper
    const ctx = ctxRef.current;
    if (!ctx) return;
    const p = toTexture(e.clientX, e.clientY);
    // Right-click = pick the pixel colour (keeps the active tool).
    if (e.button === 2) { pickColorAt(p); return; }
    const t = toolRef.current;
    const capture = () => { canvasRef.current.setPointerCapture && e.target.setPointerCapture(e.pointerId); };

    // Live-object interactions (Select tool): click to select / move, drag the
    // handles to scale / rotate, click away to deselect. Lines get a taller
    // hit band since their box is only the stroke thickness.
    const st = liveRef.current;
    if (st && t === 'select') {
      const z = effZoom || 1;
      const gap = 40 / z;
      const grab = 22 / z;
      const lp = stickerLocal(st, p);
      const dResize = Math.hypot(lp.x - st.w / 2, lp.y - st.h / 2);
      const dRotate = Math.hypot(lp.x, lp.y - (-st.h / 2 - gap));
      const hitY = st.kind === 'line' ? Math.max(st.h / 2, 14 / z) : st.h / 2;
      const inside = Math.abs(lp.x) <= st.w / 2 && Math.abs(lp.y) <= hitY;
      if (st.selected && dResize < grab) {
        dragRef.current = { mode: 'resize', startW: st.w, startH: st.h, startSize: st.size, startP: p };
        capture(); return;
      }
      if (st.selected && dRotate < grab) {
        dragRef.current = { mode: 'rotate' };
        capture(); return;
      }
      if (inside) {
        if (!st.selected) setLive({ ...st, selected: true });
        dragRef.current = { mode: 'move', dx: st.x - p.x, dy: st.y - p.y };
        capture(); scheduleOverlay(); return;
      }
      if (st.selected) { setLive({ ...st, selected: false }); scheduleOverlay(); }
    }

    if (t === 'brush' || t === 'eraser') {
      pushSnapshot();
      strokeRef.current = { last: p, erase: t === 'eraser' };
      capture();
    } else if (t === 'eyedropper') {
      pickColorAt(p);
      setTool('brush');
    } else if (t === 'fill') {
      pushSnapshot();
      const img = ctx.getImageData(0, 0, TEXTURE, TEXTURE);
      const changed = floodFill(img, p.x | 0, p.y | 0, hexToRgba('#ffffff', 0).map((v, i) => i < 3 ? hexToRgba(brushRef.current.color)[i] : 255), fillTolRef.current);
      if (changed) { ctx.putImageData(img, 0, 0); }
      else { undoRef.current.past.pop(); }
    } else if (t === 'line' || t === 'rect' || t === 'ellipse') {
      shapeRef.current = { tool: t, start: p, current: p };
      capture();
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

  const onCanvasMove = (e) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (strokeRef.current) {
      for (const p of coalesced(e)) {
        strokeTo(ctx, strokeRef.current.last, p, strokeRef.current.erase);
        strokeRef.current.last = p;
      }
      return;
    }
    if (shapeRef.current) {
      shapeRef.current.current = toTexture(e.clientX, e.clientY);
      scheduleOverlay();
      return;
    }
    if (dragRef.current && liveRef.current) {
      const st = liveRef.current;
      const p = toTexture(e.clientX, e.clientY);
      const mode = dragRef.current.mode;
      if (mode === 'move') setLive({ ...st, x: p.x + dragRef.current.dx, y: p.y + dragRef.current.dy, selected: true });
      else if (mode === 'resize') {
        const d = dragRef.current;
        const startDist = Math.max(1, Math.hypot(d.startP.x - st.x, d.startP.y - st.y));
        const k = Math.max(0.02, Math.hypot(p.x - st.x, p.y - st.y) / startDist);
        const next = { ...st, w: Math.max(8, d.startW * k), h: Math.max(8, d.startH * k), selected: true };
        // Text scales its font with the box so the glyphs match the frame.
        if (st.kind === 'text' && d.startSize) next.size = Math.max(4, d.startSize * k);
        setLive(next);
      } else if (mode === 'rotate') {
        setLive({ ...st, rot: Math.atan2(p.y - st.y, p.x - st.x) + Math.PI / 2, selected: true });
      }
      setDirty(true);
      scheduleOverlay();
    }
  };

  const onCanvasUp = () => {
    if (strokeRef.current) { strokeRef.current = null; return; }
    if (shapeRef.current) {
      const sh = shapeRef.current;
      shapeRef.current = null;
      commitShape(sh);
      return;
    }
    dragRef.current = null;
  };

  // ── Shape preview (drawn on the overlay while dragging) ────
  function drawShape(ctx, shapeTool, a, b, brushOpts, sOpts, preview) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = brushOpts.opacity;
    ctx.strokeStyle = brushOpts.color;
    ctx.fillStyle = brushOpts.color;
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
  const commitShape = (sh) => {
    const o = makeShapeObject(sh.tool, sh.start, sh.current, brushRef.current, shapeOptsRef.current);
    // Ignore an accidental click (no drag) — nothing to select or move.
    const tooSmall = sh.tool === 'line' ? o.w < 2 : (o.w < 2 && o.h < 2);
    if (tooSmall) { setTool('select'); scheduleOverlay(); return; }
    flattenLive();
    setLive(o);
    setTool('select');
    setDirty(true);
    scheduleOverlay();
  };

  // ── Text commit — becomes a selectable live object (not rasterised) ──
  // Reads the ref-mirrored draft so pressing Enter, clicking away (blur) and
  // switching tools all funnel through the same commit. Does NOT change the
  // active tool; callers decide (Enter/deselect → select, tool switch → the
  // picked tool, canvas click → stays on text for a fresh box).
  const commitText = () => {
    const anchor = textAnchorRef.current;
    const raw = String(textDraftRef.current || '').trim();
    if (!anchor || !raw) { setTextAnchor(null); setTextDraft(''); return; }
    const o = textOptsRef.current;
    const { w, h } = measureLiveText(ctxRef.current, raw, o);
    flattenLive();
    // Keep the clicked point as the top-left corner of the text box.
    setLive({
      kind: 'text', text: raw, font: o.font, size: o.size, bold: o.bold, italic: o.italic,
      color: brushRef.current.color, w, h,
      x: anchor.x + w / 2, y: anchor.y + h / 2,
      rot: 0, flipX: false, flipY: false, selected: true,
    });
    setTextAnchor(null);
    setTextDraft('');
    setDirty(true);
    scheduleOverlay();
  };

  // ── Clear / reset (confirm modal) ──────────────────────────
  // Resets to the base the canvas was opened with — the aircraft's built-in
  // default livery template for a new livery (never a blank transparent
  // canvas), the origin picture for an edit, or the imported image.
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
            drawBase(ctxRef.current, initialImageDataUrl, scheduleOverlay);
            setLive(null);
            setTextAnchor(null);
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

  return (
    <div className="lp-workspace">
      {/* ── Options bar — fixed height, always visible so the canvas never shifts ── */}
      <div className="lp-optionsbar">
        <span className="lp-options-tool">
          {ActiveIcon && <ActiveIcon size={15} />}
          <span>{t('livery_paint_' + tool)}</span>
        </span>
        {TOOLS_WITH_OPTIONS.includes(tool) && (
          <>
            <span className="lp-sep" />
          {(tool === 'brush' || tool === 'eraser') && (
            <label className="lp-field">{t('livery_paint_size')}
              <input type="range" min={1} max={200} value={brush.size} onChange={(e) => setBrush({ ...brush, size: Number(e.target.value) })} />
              <span className="lp-val">{brush.size}</span>
            </label>
          )}
          {tool === 'brush' && (
            <>
              <label className="lp-field">{t('livery_paint_opacity')}
                <input type="range" min={0.05} max={1} step={0.05} value={brush.opacity} onChange={(e) => setBrush({ ...brush, opacity: Number(e.target.value) })} />
                <span className="lp-val">{Math.round(brush.opacity * 100)}%</span>
              </label>
              <span className="lp-seg">
                <button className={brush.hard ? 'lp-on' : ''} {...bind(t('livery_paint_hard'))} onClick={() => setBrush({ ...brush, hard: true })}>{t('livery_paint_hard')}</button>
                <button className={!brush.hard ? 'lp-on' : ''} {...bind(t('livery_paint_soft'))} onClick={() => setBrush({ ...brush, hard: false })}>{t('livery_paint_soft')}</button>
              </span>
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
              <label className="lp-field">{t('livery_paint_width')}
                <input type="range" min={1} max={200} value={shapeOpts.width} onChange={(e) => setShapeOpts({ ...shapeOpts, width: Number(e.target.value) })} />
                <span className="lp-val">{shapeOpts.width}</span>
              </label>
              <label className="lp-check">
                <input type="checkbox" checked={shapeOpts.filled} onChange={(e) => setShapeOpts({ ...shapeOpts, filled: e.target.checked })} />
                {t('livery_paint_fill_toggle')}
              </label>
            </>
          )}
          {tool === 'text' && (
            <>
              <label className="lp-field">{t('livery_paint_font')}
                <select
                  className="lp-font"
                  aria-label={t('livery_paint_font')}
                  value={textOpts.font}
                  onChange={(e) => setTextOpts({ ...textOpts, font: e.target.value })}
                >
                  {FONT_OPTIONS.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                  {!FONT_OPTIONS.includes(textOpts.font) && <option value={textOpts.font}>{textOpts.font}</option>}
                </select>
              </label>
              <label className="lp-field">{t('livery_paint_size')}
                <input type="range" min={8} max={400} value={textOpts.size} onChange={(e) => setTextOpts({ ...textOpts, size: Number(e.target.value) })} />
                <span className="lp-val">{textOpts.size}</span>
              </label>
              <span className="lp-seg">
                <button className={textOpts.bold ? 'lp-on' : ''} {...bind(t('livery_paint_bold'))} aria-label={t('livery_paint_bold')} aria-pressed={textOpts.bold} onClick={() => setTextOpts({ ...textOpts, bold: !textOpts.bold })}><strong>B</strong></button>
                <button className={textOpts.italic ? 'lp-on' : ''} {...bind(t('livery_paint_italic'))} aria-label={t('livery_paint_italic')} aria-pressed={textOpts.italic} onClick={() => setTextOpts({ ...textOpts, italic: !textOpts.italic })}><em>I</em></button>
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
                  onClick={() => { commitText(); setTool(name); }}
                >
                  {Icon ? <Icon size={18} /> : t('livery_paint_' + name)}
                </button>
              );
            })}
          </div>
          <div className="lp-rail-sep" />
          <div className="lp-rail-group">
            <button className="lp-tool" {...bind(t('livery_paint_import_sticker'))} aria-label={t('livery_paint_import_sticker')} onClick={importSticker}><TbSticker2 size={18} /></button>
            <button className="lp-tool" {...bind(t('livery_paint_duplicate_sticker'))} aria-label={t('livery_paint_duplicate_sticker')} disabled={!live} onClick={duplicateSticker}><HiDocumentDuplicate size={18} /></button>
            <button className="lp-tool" {...bind(t('livery_paint_flip_h'))} aria-label={t('livery_paint_flip_h')} disabled={!live} onClick={() => flipSticker('flipX')}><LuFlipHorizontal size={18} /></button>
            <button className="lp-tool" {...bind(t('livery_paint_flip_v'))} aria-label={t('livery_paint_flip_v')} disabled={!live} onClick={() => flipSticker('flipY')}><LuFlipVertical size={18} /></button>
            <button className="lp-tool lp-danger" {...bind(t('livery_paint_delete_sticker'))} aria-label={t('livery_paint_delete_sticker')} disabled={!live} onClick={removeSticker}><CiBookmarkRemove size={18} /></button>
          </div>
          <div className="lp-rail-sep" />
          <div className="lp-rail-group">
            <button className="lp-tool" {...bind(t('livery_paint_undo'))} aria-label={t('livery_paint_undo')} onClick={doUndo} disabled={undoRef.current.past.length === 0}><IoArrowUndoOutline size={18} /></button>
            <button className="lp-tool" {...bind(t('livery_paint_redo'))} aria-label={t('livery_paint_redo')} onClick={doRedo} disabled={undoRef.current.future.length === 0}><IoArrowRedoOutline size={18} /></button>
            <button className="lp-tool lp-danger" {...bind(t('livery_paint_clear'))} aria-label={t('livery_paint_clear')} onClick={handleClear}><AiOutlineClear size={18} /></button>
          </div>
          <div className="lp-rail-sep" />
          <div className="lp-rail-group">
            <span className="lp-rail-color" {...bind(t('livery_paint_color'))}>
              <input
                type="color"
                aria-label={t('livery_paint_color')}
                value={brush.color}
                onChange={(e) => setBrush({ ...brush, color: e.target.value })}
              />
            </span>
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
          <div className="lp-canvas-stage" style={{ width: TEXTURE * effZoom, height: TEXTURE * effZoom }} onPointerMove={showBrushRing ? moveCursorRing : undefined} onPointerDown={showBrushRing ? moveCursorRing : undefined} onPointerLeave={showBrushRing ? hideCursorRing : undefined}>
            <canvas
              ref={canvasRef}
              width={TEXTURE}
              height={TEXTURE}
              style={{ width: TEXTURE * effZoom, height: TEXTURE * effZoom, cursor: spaceHeld ? 'none' : (tool === 'text' ? 'text' : (tool === 'select' ? 'default' : (showBrushRing ? 'none' : 'crosshair'))), touchAction: 'none' }}
              onPointerDown={onCanvasDown}
              onPointerMove={onCanvasMove}
              onPointerUp={onCanvasUp}
              onContextMenu={(e) => e.preventDefault()}
            />
            <canvas
              ref={overlayRef}
              width={TEXTURE}
              height={TEXTURE}
              style={{ position: 'absolute', left: 0, top: 0, width: TEXTURE * effZoom, height: TEXTURE * effZoom, pointerEvents: 'none' }}
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
                  if (e.key === 'Escape') { setTextAnchor(null); setTextDraft(''); }
                  e.stopPropagation();
                }}
                onBlur={() => commitText()}
                style={{
                  position: 'absolute',
                  left: textAnchor.x * effZoom,
                  top: textAnchor.y * effZoom,
                  fontSize: Math.max(10, textOpts.size * effZoom),
                  color: brush.color,
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
      {TooltipPortal}
    </div>
  );
});

export default LiveryCanvas;
