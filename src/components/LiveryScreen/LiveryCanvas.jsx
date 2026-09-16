import React, {
  useEffect,
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

export const TEXTURE = 2048;

const TOOLS = ['brush', 'eraser', 'eyedropper', 'fill', 'line', 'rect', 'ellipse', 'text', 'sticker'];

/**
 * LiveryCanvas — flat 2048×2048 texture painter (P2).
 * Fixed backing store, CSS-scaled view, zoom 25/50/100%/fit, space-/
 * middle-drag pan, coalesced pointer strokes, rAF sticker transforms.
 * Export flattens over the base fill (eraser transparency → base fill).
 */
const LiveryCanvas = forwardRef(function LiveryCanvas(
  { initialImageDataUrl, baseFill = '#ffffff', onDirty },
  ref,
) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const wrapRef = useRef(null);
  const ctxRef = useRef(null);
  const undoRef = useRef(createUndoStack());
  const baseFillRef = useRef(baseFill);
  const spaceRef = useRef(false);
  const panRef = useRef(null);
  const strokeRef = useRef(null);
  const shapeRef = useRef(null);
  const dragRef = useRef(null);
  const rafRef = useRef(0);
  const stickerRef = useRef(null);
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
  const [sticker, setStickerState] = useState(null);
  const [textAnchor, setTextAnchor] = useState(null);
  const [textDraft, setTextDraft] = useState('');
  const [dirty, setDirtyState] = useState(false);

  const setTool = (v) => { toolRef.current = v; setToolState(v); };
  const setBrush = (v) => { brushRef.current = v; setBrushState(v); };
  const setShapeOpts = (v) => { shapeOptsRef.current = v; setShapeOptsState(v); };
  const setTextOpts = (v) => { textOptsRef.current = v; setTextOptsState(v); };
  const setSticker = (v) => { stickerRef.current = v; setStickerState(v); };
  const setDirty = (v) => {
    setDirtyState(v);
    if (onDirty) onDirty(v);
  };

  const effZoom = zoom === 'fit' ? fitScale : zoom;

  // ── Base init (mount only — parent remounts via key on base change) ─
  useEffect(() => {
    baseFillRef.current = baseFill;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseFill]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctxRef.current = ctx;
    undoRef.current = createUndoStack();
    setDirty(false);
    setSticker(null);
    setTextAnchor(null);
    const paintBase = () => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = baseFillRef.current;
      ctx.fillRect(0, 0, TEXTURE, TEXTURE);
      ctx.restore();
    };
    if (initialImageDataUrl) {
      const img = new Image();
      img.onload = () => {
        paintBase();
        ctx.drawImage(img, 0, 0, TEXTURE, TEXTURE);
        scheduleOverlay();
      };
      img.onerror = () => paintBase();
      img.src = initialImageDataUrl;
    } else {
      paintBase();
    }
    scheduleOverlay();
    // Mount-only: the parent remounts (key) whenever the base changes, so
    // re-running here would wipe in-progress strokes (e.g. fill-picker edits
    // update baseFillRef via the effect above and take effect on export/reset).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialImageDataUrl]);

  // ── Fit zoom tracking ──────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth || 512;
      setFitScale(Math.max(0.05, Math.min(1, (w - 4) / TEXTURE)));
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (ro) ro.observe(el);
    return () => { if (ro) ro.disconnect(); };
  }, []);

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
    const st = stickerRef.current;
    if (st && st.img) {
      ctx.save();
      ctx.translate(st.x, st.y);
      ctx.rotate(st.rot || 0);
      ctx.drawImage(st.img, -st.w / 2, -st.h / 2, st.w, st.h);
      ctx.strokeStyle = '#6aa0ff';
      ctx.lineWidth = 4;
      ctx.strokeRect(-st.w / 2, -st.h / 2, st.w, st.h);
      // resize handle (bottom-right) + rotate handle (top-center)
      ctx.fillStyle = '#6aa0ff';
      ctx.beginPath(); ctx.arc(st.w / 2, st.h / 2, 16, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0, -st.h / 2 - 48, 16, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    const sh = shapeRef.current;
    if (sh && sh.current) {
      drawShape(ctx, sh.tool, sh.start, sh.current, brushRef.current, shapeOptsRef.current, true);
    }
  }, []);

  function scheduleOverlay() {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(drawOverlay);
  }

  useEffect(() => { scheduleOverlay(); }, [sticker, textAnchor, scheduleOverlay]);

  // ── Export (flatten over base fill) ────────────────────────
  useImperativeHandle(ref, () => ({
    exportPNG() {
      const out = document.createElement('canvas');
      out.width = TEXTURE; out.height = TEXTURE;
      const ctx = out.getContext('2d');
      ctx.fillStyle = baseFillRef.current;
      ctx.fillRect(0, 0, TEXTURE, TEXTURE);
      ctx.drawImage(canvasRef.current, 0, 0);
      return out.toDataURL('image/png');
    },
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
      if (e.key === ' ') { spaceRef.current = true; e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (stickerRef.current) { setSticker(null); scheduleOverlay(); }
        return;
      }
      const k = e.key.toLowerCase();
      const map = { b: 'brush', e: 'eraser', i: 'eyedropper', g: 'fill', l: 'line', r: 'rect', o: 'ellipse', t: 'text', k: 'sticker' };
      if (map[k] && TOOLS.includes(map[k])) setTool(map[k]);
    };
    const onKeyUp = (e) => { if (e.key === ' ') spaceRef.current = false; };
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

  // ── Canvas pointer handlers ────────────────────────────────
  const onCanvasDown = (e) => {
    if (e.button === 1 || spaceRef.current) return; // pan handled by wrapper
    const ctx = ctxRef.current;
    if (!ctx) return;
    const p = toTexture(e.clientX, e.clientY);
    const t = toolRef.current;
    if (t === 'brush' || t === 'eraser') {
      pushSnapshot();
      strokeRef.current = { last: p, erase: t === 'eraser' };
      canvasRef.current.setPointerCapture && e.target.setPointerCapture(e.pointerId);
    } else if (t === 'eyedropper') {
      const d = ctx.getImageData(Math.max(0, Math.min(TEXTURE - 1, p.x | 0)), Math.max(0, Math.min(TEXTURE - 1, p.y | 0)), 1, 1).data;
      setBrush({ ...brushRef.current, color: rgbaToHex(d[0], d[1], d[2]) });
      setTool('brush');
    } else if (t === 'fill') {
      pushSnapshot();
      const img = ctx.getImageData(0, 0, TEXTURE, TEXTURE);
      const changed = floodFill(img, p.x | 0, p.y | 0, hexToRgba('#ffffff', 0).map((v, i) => i < 3 ? hexToRgba(brushRef.current.color)[i] : 255), fillTolRef.current);
      if (changed) { ctx.putImageData(img, 0, 0); }
      else { undoRef.current.past.pop(); }
    } else if (t === 'line' || t === 'rect' || t === 'ellipse') {
      pushSnapshot();
      shapeRef.current = { tool: t, start: p, current: p };
      canvasRef.current.setPointerCapture && e.target.setPointerCapture(e.pointerId);
    } else if (t === 'text') {
      setTextAnchor(p);
      setTextDraft('');
    } else if (t === 'sticker') {
      const st = stickerRef.current;
      if (!st) return;
      const lp = stickerLocal(st, p);
      const dResize = Math.hypot(lp.x - st.w / 2, lp.y - st.h / 2);
      const dRotate = Math.hypot(lp.x - 0, lp.y - (-st.h / 2 - 48));
      if (dResize < 28) dragRef.current = { mode: 'resize', cx: st.x, cy: st.y, startW: st.w, startH: st.h, startP: p };
      else if (dRotate < 28) dragRef.current = { mode: 'rotate' };
      else if (Math.abs(lp.x) <= st.w / 2 && Math.abs(lp.y) <= st.h / 2) dragRef.current = { mode: 'move', dx: st.x - p.x, dy: st.y - p.y };
      else return;
      canvasRef.current.setPointerCapture && e.target.setPointerCapture(e.pointerId);
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
    if (dragRef.current && stickerRef.current) {
      const st = stickerRef.current;
      const p = toTexture(e.clientX, e.clientY);
      const mode = dragRef.current.mode;
      if (mode === 'move') setSticker({ ...st, x: p.x + dragRef.current.dx, y: p.y + dragRef.current.dy });
      else if (mode === 'resize') {
        const lp0 = stickerLocal({ ...st, rot: 0 }, p);
        const k = Math.max(0.05, Math.max(Math.abs(lp0.x) / (st.w / 2), Math.abs(lp0.y) / (st.h / 2)));
        void dragRef;
        setSticker({ ...st, w: Math.max(8, st.w * k), h: Math.max(8, st.h * k) });
      } else if (mode === 'rotate') {
        setSticker({ ...st, rot: Math.atan2(p.y - st.y, p.x - st.x) + Math.PI / 2 });
      }
      scheduleOverlay();
    }
  };

  const onCanvasUp = () => {
    if (strokeRef.current) { strokeRef.current = null; return; }
    if (shapeRef.current) {
      const sh = shapeRef.current;
      shapeRef.current = null;
      const ctx = ctxRef.current;
      drawShape(ctx, sh.tool, sh.start, sh.current, brushRef.current, shapeOptsRef.current, false);
      scheduleOverlay();
      return;
    }
    dragRef.current = null;
  };

  // ── Shape commit ───────────────────────────────────────────
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

  // ── Text commit ────────────────────────────────────────────
  const commitText = () => {
    if (!textAnchor || !textDraft) { setTextAnchor(null); return; }
    const ctx = ctxRef.current;
    pushSnapshot();
    const o = textOptsRef.current;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = o.color;
    ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${o.size}px ${o.font}`;
    ctx.textBaseline = 'top';
    ctx.fillText(textDraft, textAnchor.x, textAnchor.y);
    ctx.restore();
    setTextAnchor(null);
    setTextDraft('');
  };

  // ── Sticker import (via P1 file picker) + commit ───────────
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
        setSticker({ img, w: w * k, h: h * k, x: TEXTURE / 2, y: TEXTURE / 2, rot: 0 });
        setTool('sticker');
        scheduleOverlay();
      };
      img.onerror = () => useAppStore.getState().showToast('BAD_IMAGE', 'error');
      img.src = res.imageDataUrl;
    } catch (err) {
      useAppStore.getState().showToast(err.message, 'error');
    }
  };

  const commitSticker = () => {
    const st = stickerRef.current;
    if (!st) return;
    const ctx = ctxRef.current;
    pushSnapshot();
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.translate(st.x, st.y);
    ctx.rotate(st.rot || 0);
    ctx.drawImage(st.img, -st.w / 2, -st.h / 2, st.w, st.h);
    ctx.restore();
    setSticker(null);
    scheduleOverlay();
  };

  // ── Clear / reset (confirm modal) ──────────────────────────
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
            const ctx = ctxRef.current;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
            ctx.fillStyle = baseFillRef.current;
            ctx.fillRect(0, 0, TEXTURE, TEXTURE);
            ctx.restore();
            setSticker(null);
            setTextAnchor(null);
            scheduleOverlay();
          }}>{t('livery_paint_clear')}</button>
        </>
      )
    );
  };

  // ── Wrapper pan (space-drag + middle-drag) ─────────────────
  const onWrapDown = (e) => {
    if (e.button === 1 || spaceRef.current) {
      e.preventDefault();
      panRef.current = { sx: e.clientX, sy: e.clientY, sl: wrapRef.current.scrollLeft, st: wrapRef.current.scrollTop };
      e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId);
    }
  };
  const onWrapMove = (e) => {
    if (!panRef.current) return;
    wrapRef.current.scrollLeft = panRef.current.sl - (e.clientX - panRef.current.sx);
    wrapRef.current.scrollTop = panRef.current.st - (e.clientY - panRef.current.sy);
  };
  const onWrapUp = () => { panRef.current = null; };

  return (
    <div>
      <div className="livery-toolbar">
        {TOOLS.map(name => (
          <button
            key={name}
            className={'btn-sm' + (tool === name ? ' tool-active' : '')}
            onClick={() => setTool(name)}
            title={name}
          >{t('livery_paint_' + name)}</button>
        ))}
        <button className="btn-sm" onClick={doUndo} disabled={undoRef.current.past.length === 0}>{t('livery_paint_undo')}</button>
        <button className="btn-sm" onClick={doRedo} disabled={undoRef.current.future.length === 0}>{t('livery_paint_redo')}</button>
        <button className="btn-sm" onClick={handleClear}>{t('livery_paint_clear')}</button>
        {[0.25, 0.5, 1].map(z => (
          <button key={z} className={'btn-sm' + (zoom === z ? ' tool-active' : '')} onClick={() => setZoom(z)}>{Math.round(z * 100)}%</button>
        ))}
        <button className={'btn-sm' + (zoom === 'fit' ? ' tool-active' : '')} onClick={() => setZoom('fit')}>{t('livery_paint_fit')}</button>
      </div>

      {(tool === 'brush' || tool === 'eraser') && (
        <div className="livery-toolbar">
          <input type="color" value={brush.color} onChange={(e) => setBrush({ ...brush, color: e.target.value })} />
          <input
            type="text" value={brush.color} maxLength={7}
            onChange={(e) => { const v = e.target.value; if (/^#[0-9a-fA-F]{6}$/.test(v)) setBrush({ ...brush, color: v }); }}
            style={{ width: 80 }}
          />
          <label>{t('livery_paint_size')}<input type="range" min={1} max={200} value={brush.size} onChange={(e) => setBrush({ ...brush, size: Number(e.target.value) })} />{brush.size}</label>
          <label>{t('livery_paint_opacity')}<input type="range" min={0.05} max={1} step={0.05} value={brush.opacity} onChange={(e) => setBrush({ ...brush, opacity: Number(e.target.value) })} />{Math.round(brush.opacity * 100)}%</label>
          <button className={'btn-sm' + (brush.hard ? ' tool-active' : '')} onClick={() => setBrush({ ...brush, hard: true })}>{t('livery_paint_hard')}</button>
          <button className={'btn-sm' + (!brush.hard ? ' tool-active' : '')} onClick={() => setBrush({ ...brush, hard: false })}>{t('livery_paint_soft')}</button>
        </div>
      )}
      {tool === 'fill' && (
        <div className="livery-toolbar">
          <label>{t('livery_paint_tolerance')}<input type="range" min={0} max={255} value={fillTol} onChange={(e) => { fillTolRef.current = Number(e.target.value); setFillTolState(fillTolRef.current); }} />{fillTol}</label>
        </div>
      )}
      {(tool === 'line' || tool === 'rect' || tool === 'ellipse') && (
        <div className="livery-toolbar">
          <label>{t('livery_paint_width')}<input type="range" min={1} max={200} value={shapeOpts.width} onChange={(e) => setShapeOpts({ ...shapeOpts, width: Number(e.target.value) })} />{shapeOpts.width}</label>
          <label><input type="checkbox" checked={shapeOpts.filled} onChange={(e) => setShapeOpts({ ...shapeOpts, filled: e.target.checked })} />{t('livery_paint_fill_toggle')}</label>
        </div>
      )}
      {tool === 'text' && (
        <div className="livery-toolbar">
          <input type="text" value={textOpts.font} onChange={(e) => setTextOpts({ ...textOpts, font: e.target.value })} style={{ width: 120 }} placeholder={t('livery_paint_font')} />
          <label>{t('livery_paint_size')}<input type="range" min={8} max={400} value={textOpts.size} onChange={(e) => setTextOpts({ ...textOpts, size: Number(e.target.value) })} />{textOpts.size}</label>
          <button className={'btn-sm' + (textOpts.bold ? ' tool-active' : '')} onClick={() => setTextOpts({ ...textOpts, bold: !textOpts.bold })}>B</button>
          <button className={'btn-sm' + (textOpts.italic ? ' tool-active' : '')} onClick={() => setTextOpts({ ...textOpts, italic: !textOpts.italic })}>I</button>
          <input type="color" value={textOpts.color} onChange={(e) => setTextOpts({ ...textOpts, color: e.target.value })} />
        </div>
      )}
      {tool === 'sticker' && (
        <div className="livery-toolbar">
          <button className="btn-sm" onClick={importSticker}>{t('livery_paint_import_sticker')}</button>
          {sticker && (
            <>
              <button className="btn-sm" onClick={commitSticker}>{t('livery_paint_commit_sticker')}</button>
              <button className="btn-sm" onClick={() => { setSticker(null); scheduleOverlay(); }}>{t('livery_paint_delete_sticker')}</button>
            </>
          )}
        </div>
      )}

      <div
        ref={wrapRef}
        className="livery-canvas-wrap"
        tabIndex={0}
        onPointerDown={onWrapDown}
        onPointerMove={onWrapMove}
        onPointerUp={onWrapUp}
      >
        <div style={{ position: 'relative', width: TEXTURE * effZoom, height: TEXTURE * effZoom }}>
          <canvas
            ref={canvasRef}
            width={TEXTURE}
            height={TEXTURE}
            style={{ width: TEXTURE * effZoom, height: TEXTURE * effZoom, cursor: tool === 'text' ? 'text' : 'crosshair', touchAction: 'none' }}
            onPointerDown={onCanvasDown}
            onPointerMove={onCanvasMove}
            onPointerUp={onCanvasUp}
          />
          <canvas
            ref={overlayRef}
            width={TEXTURE}
            height={TEXTURE}
            style={{ position: 'absolute', left: 0, top: 0, width: TEXTURE * effZoom, height: TEXTURE * effZoom, pointerEvents: 'none' }}
          />
          {textAnchor && (
            <input
              autoFocus
              value={textDraft}
              placeholder={t('livery_paint_text_placeholder')}
              onChange={(e) => setTextDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitText();
                if (e.key === 'Escape') { setTextAnchor(null); setTextDraft(''); }
                e.stopPropagation();
              }}
              style={{
                position: 'absolute',
                left: textAnchor.x * effZoom,
                top: textAnchor.y * effZoom,
                fontSize: Math.max(10, textOpts.size * effZoom),
                color: textOpts.color,
              }}
            />
          )}
        </div>
      </div>
      <p className="livery-folder-preview">{t('livery_paint_flat_note')}</p>
    </div>
  );
});

export default LiveryCanvas;
