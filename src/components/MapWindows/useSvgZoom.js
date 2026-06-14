import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Scroll-wheel zoom + click-drag pan via SVG viewBox manipulation.
 * Cursor-centered zoom, free drag panning.
 * Zoom in up to 50x, out up to 8x. Only auto-resets on first data load.
 */
export default function useSvgZoom(initialViewBox) {
  const [viewBox, setViewBox] = useState(initialViewBox);
  const svgRef = useRef(null);
  const didInit = useRef(false);

  // ── Drag state ──────────────────────────────────────────
  const dragging = useRef(false);
  const dragStart = useRef({ mx: 0, my: 0, vbX: 0, vbY: 0 });

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

    setViewBox(prev => ({
      ...prev,
      x: dragStart.current.vbX - dxVb,
      y: dragStart.current.vbY - dyVb,
    }));
  }, [viewBox]);

  const handleMouseUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // ── Reset ───────────────────────────────────────────────
  const resetZoom = useCallback(() => {
    if (initialViewBox) setViewBox(initialViewBox);
  }, [initialViewBox]);

  return {
    viewBox, svgRef, resetZoom,
    handleWheel, handleMouseDown, handleMouseMove, handleMouseUp,
  };
}
