import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Scroll-wheel zoom + click-drag pan via SVG viewBox manipulation.
 * Cursor-centered zoom, free drag panning bounded to initial viewBox.
 * Zoom in up to 50×, out to 1× the initial viewBox. Only auto-resets on first data load.
 */
export default function useSvgZoom(initialViewBox) {
  const [viewBox, setViewBox] = useState(initialViewBox);
  const svgRef = useRef(null);
  const didInit = useRef(false);

  // ── Drag state ──────────────────────────────────────────
  const dragging = useRef(false);
  const dragStart = useRef({ mx: 0, my: 0, vbX: 0, vbY: 0 });

  // Stable ref for imperative zoom/pan (avoids re-renders in sidebar)
  const viewBoxRef = useRef(viewBox);
  useEffect(() => { viewBoxRef.current = viewBox; }, [viewBox]);

  // Reset only on first meaningful viewBox (e.g. data loaded)
  useEffect(() => {
    if (initialViewBox && !didInit.current) {
      setViewBox(initialViewBox);
      didInit.current = true;
    }
  }, [initialViewBox]);

  // ── Zoom (wheel) ────────────────────────────────────────
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const fracX = (e.clientX - rect.left) / rect.width;
    const fracY = (e.clientY - rect.top) / rect.height;

    const svgX = viewBox.x + fracX * viewBox.w;
    const svgY = viewBox.y + fracY * viewBox.h;

    const scale = e.deltaY > 0 ? 1.12 : 1 / 1.12;

    const newW = viewBox.w * scale;
    const newH = viewBox.h * scale;

    if (!initialViewBox) return;
    // Only allow zoom in (smaller viewBox). Max out = default view.
    if (newW < initialViewBox.w * 0.02 || newW > initialViewBox.w) return;

    const newX = svgX - fracX * newW;
    const newY = svgY - fracY * newH;

    setViewBox({ x: newX, y: newY, w: newW, h: newH });
  }, [viewBox, initialViewBox]);

  // ── Drag (pan) ──────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    // Only left button
    if (e.button !== 0) return;
    dragging.current = true;
    dragStart.current = { mx: e.clientX, my: e.clientY, vbX: viewBox.x, vbY: viewBox.y };
    e.preventDefault();
  }, [viewBox]);

  const handleMouseMove = useCallback((e) => {
    if (!dragging.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dxPx = e.clientX - dragStart.current.mx;
    const dyPx = e.clientY - dragStart.current.my;

    // Convert pixel delta to viewBox units
    const dxVb = (dxPx / rect.width) * viewBox.w;
    const dyVb = (dyPx / rect.height) * viewBox.h;

    const ivb = initialViewBox;
    setViewBox(prev => {
      let nx = dragStart.current.vbX - dxVb;
      let ny = dragStart.current.vbY - dyVb;
      // Clamp pan to stay within initial viewBox bounds
      if (ivb) {
        const maxX = ivb.x + ivb.w - prev.w;
        const maxY = ivb.y + ivb.h - prev.h;
        nx = Math.max(ivb.x, Math.min(maxX, nx));
        ny = Math.max(ivb.y, Math.min(maxY, ny));
      }
      return { ...prev, x: nx, y: ny };
    });
  }, [viewBox, initialViewBox]);

  const handleMouseUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // ── Imperative zoom steps (center-based, for sidebar knobs) ──
  const zoomIn = useCallback(() => {
    const vb = viewBoxRef.current;
    if (!vb || !initialViewBox) return;
    const scale = 1 / 1.12;
    const newW = vb.w * scale;
    const newH = vb.h * scale;
    if (newW < initialViewBox.w * 0.02) return;
    const cx = vb.x + vb.w / 2;
    const cy = vb.y + vb.h / 2;
    setViewBox({ x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH });
  }, [initialViewBox]);

  const zoomOut = useCallback(() => {
    const vb = viewBoxRef.current;
    if (!vb || !initialViewBox) return;
    const scale = 1.12;
    const newW = vb.w * scale;
    const newH = vb.h * scale;
    if (newW > initialViewBox.w) return;
    const cx = vb.x + vb.w / 2;
    const cy = vb.y + vb.h / 2;
    setViewBox({ x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH });
  }, [initialViewBox]);

  const panLeft = useCallback(() => {
    setViewBox(prev => {
      const newX = prev.x - prev.w * 0.05;
      const maxX = initialViewBox.x + initialViewBox.w - prev.w;
      return { ...prev, x: Math.max(initialViewBox.x, Math.min(maxX, newX)) };
    });
  }, [initialViewBox]);
  const panRight = useCallback(() => {
    setViewBox(prev => {
      const newX = prev.x + prev.w * 0.05;
      const maxX = initialViewBox.x + initialViewBox.w - prev.w;
      return { ...prev, x: Math.max(initialViewBox.x, Math.min(maxX, newX)) };
    });
  }, [initialViewBox]);
  const panUp = useCallback(() => {
    setViewBox(prev => {
      const newY = prev.y - prev.h * 0.05;
      const maxY = initialViewBox.y + initialViewBox.h - prev.h;
      return { ...prev, y: Math.max(initialViewBox.y, Math.min(maxY, newY)) };
    });
  }, [initialViewBox]);
  const panDown = useCallback(() => {
    setViewBox(prev => {
      const newY = prev.y + prev.h * 0.05;
      const maxY = initialViewBox.y + initialViewBox.h - prev.h;
      return { ...prev, y: Math.max(initialViewBox.y, Math.min(maxY, newY)) };
    });
  }, [initialViewBox]);

  // ── Reset ───────────────────────────────────────────────
  const resetZoom = useCallback(() => {
    if (initialViewBox) setViewBox(initialViewBox);
  }, [initialViewBox]);

  // Reset only horizontal pan (preserve zoom + vertical offset)
  const resetPanH = useCallback(() => {
    if (!initialViewBox) return;
    setViewBox(prev => {
      const initCX = initialViewBox.x + initialViewBox.w / 2;
      return { ...prev, x: initCX - prev.w / 2 };
    });
  }, [initialViewBox]);

  // Reset only vertical pan (preserve zoom + horizontal offset)
  const resetPanV = useCallback(() => {
    if (!initialViewBox) return;
    setViewBox(prev => {
      const initCY = initialViewBox.y + initialViewBox.h / 2;
      return { ...prev, y: initCY - prev.h / 2 };
    });
  }, [initialViewBox]);

  return {
    viewBox, svgRef, resetZoom, resetPanH, resetPanV,
    handleWheel, handleMouseDown, handleMouseMove, handleMouseUp,
    zoomIn, zoomOut, panLeft, panRight, panUp, panDown,
  };
}
