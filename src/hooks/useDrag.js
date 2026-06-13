import { useState, useRef, useCallback, useEffect } from 'react';
import { DRAG_MIN_VISIBLE_X, DRAG_MIN_VISIBLE_Y } from '../utils/constants';

/**
 * Shared drag hook for floating panels (StandMap, StarMap).
 *
 * Uses direct DOM manipulation during drag to avoid React re-render lag,
 * then syncs the final position back to React state on mouseup.
 *
 * Usage:
 *   const { pos, isDragging, hasDragged, setPos, headerHandlers } =
 *     useDrag({ panelRef, enabled, onDragEnd });
 *
 * - Spread `headerHandlers` on the panel header div (the drag handle).
 * - Use `pos.left` / `pos.top` for panel positioning after drag completes.
 * - `enabled` = false disables drag (e.g. while minimized).
 * - `onDragEnd()` is called synchronously when the user releases the drag,
 *   so the parent can set `hasDragged` before the next render.
 */
export default function useDrag({ panelRef, enabled = true, onDragEnd }) {
  const [pos, setPos] = useState({ left: null, top: null });
  const [isDragging, setIsDragging] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);
  const offsetRef = useRef({ x: 0, y: 0 });
  const livePosRef = useRef({ left: null, top: null });

  const handleMouseDown = useCallback(
    (e) => {
      if (!enabled) return;
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;

      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();

      offsetRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      // Seed left/top from current position so the panel stays in place
      // when we switch from right-based to left-based positioning.
      panel.style.right = '';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.transition = 'none';

      // Seed state so the React re-render keeps the panel in place.
      livePosRef.current = { left: rect.left, top: rect.top };
      setPos({ left: rect.left, top: rect.top });

      setIsDragging(true);
      e.preventDefault();
    },
    [enabled, panelRef],
  );

  useEffect(() => {
    if (!isDragging) return;

    const panel = panelRef.current;
    if (!panel) return;
    const panelW = panel.offsetWidth;

    const handleMouseMove = (e) => {
      let newLeft = e.clientX - offsetRef.current.x;
      let newTop = e.clientY - offsetRef.current.y;

      // Clamp: keep at least DRAG_MIN_VISIBLE_X px of the panel visible horizontally,
      // and DRAG_MIN_VISIBLE_Y px (header) visible vertically.
      newLeft = Math.max(-panelW + DRAG_MIN_VISIBLE_X, Math.min(window.innerWidth - DRAG_MIN_VISIBLE_X, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - DRAG_MIN_VISIBLE_Y, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';

      livePosRef.current = { left: newLeft, top: newTop };
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setHasDragged(true);
      if (onDragEnd) onDragEnd();
      panel.style.transition = '';
      setPos({ ...livePosRef.current });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, panelRef, onDragEnd]);

  return {
    pos,
    isDragging,
    hasDragged,
    setPos,
    headerHandlers: { onMouseDown: handleMouseDown },
  };
}
