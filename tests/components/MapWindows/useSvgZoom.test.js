import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useSvgZoom from '../../../src/components/MapWindows/useSvgZoom';

// Mock getBoundingClientRect on a DOM element
function mockRect(el, rect) {
  el.getBoundingClientRect = vi.fn(() => rect);
}

/**
 * Creates a fake SVG element with a mocked getBoundingClientRect
 * and attaches it as svgRef.current.
 */
function attachFakeSvg(result, rect) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (rect) mockRect(svg, rect);
  // Set the ref
  result.current.svgRef.current = svg;
  return svg;
}

const INITIAL_VB = { x: 0, y: 0, w: 1000, h: 800 };

describe('useSvgZoom', () => {
  describe('initial state', () => {
    it('returns the initialViewBox as the initial viewBox', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      expect(result.current.viewBox).toEqual(INITIAL_VB);
    });

    it('handles null initialViewBox gracefully', () => {
      const { result } = renderHook(() => useSvgZoom(null));
      expect(result.current.viewBox).toBeNull();
    });

    it('auto-initializes on first non-null initialViewBox', () => {
      const { result, rerender } = renderHook(
        (props) => useSvgZoom(props.vb),
        { initialProps: { vb: null } }
      );
      expect(result.current.viewBox).toBeNull();

      rerender({ vb: INITIAL_VB });
      expect(result.current.viewBox).toEqual(INITIAL_VB);
    });
  });

  describe('imperative zoom steps', () => {
    it('zoomIn reduces viewBox size centered', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      act(() => { result.current.zoomIn(); });
      const vb = result.current.viewBox;
      expect(vb.w).toBeLessThan(INITIAL_VB.w);
      expect(vb.h).toBeLessThan(INITIAL_VB.h);
      // Center should remain the same
      const initCX = INITIAL_VB.x + INITIAL_VB.w / 2;
      const initCY = INITIAL_VB.y + INITIAL_VB.h / 2;
      const newCX = vb.x + vb.w / 2;
      const newCY = vb.y + vb.h / 2;
      expect(newCX).toBeCloseTo(initCX, 0);
      expect(newCY).toBeCloseTo(initCY, 0);
    });

    it('zoomOut increases viewBox size centered', () => {
      // Start zoomed in
      const smallVB = { x: 250, y: 200, w: 500, h: 400 };
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      // Manually set viewBox to zoomed-in state
      act(() => {
        // Use zoomIn enough times to get smaller
        for (let i = 0; i < 10; i++) result.current.zoomIn();
      });
      const zoomedW = result.current.viewBox.w;
      act(() => { result.current.zoomOut(); });
      expect(result.current.viewBox.w).toBeGreaterThan(zoomedW);
    });

    it('zoomOut does not exceed initialViewBox', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      act(() => { result.current.zoomOut(); });
      expect(result.current.viewBox.w).toBeLessThanOrEqual(INITIAL_VB.w);
    });

    it('zoomIn does not go below 2% of initial width', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      // Zoom in many times
      act(() => {
        for (let i = 0; i < 100; i++) result.current.zoomIn();
      });
      const minW = INITIAL_VB.w * 0.02;
      expect(result.current.viewBox.w).toBeGreaterThanOrEqual(minW - 0.01);
    });
  });

  describe('imperative pan steps', () => {
    it('panLeft moves viewBox left after zooming in and panning right', () => {
      // Use a large initialViewBox so zoom+pan has room
      const { result } = renderHook(() => useSvgZoom({ x: 0, y: 0, w: 1000, h: 800 }));
      act(() => {
        result.current.zoomIn();   // Shrink viewBox
        result.current.panRight(); // Move right first
      });
      const xAfterRight = result.current.viewBox.x;
      act(() => { result.current.panLeft(); });
      expect(result.current.viewBox.x).toBeLessThan(xAfterRight);
    });

    it('panRight moves viewBox right after zooming in', () => {
      const { result } = renderHook(() => useSvgZoom({ x: 0, y: 0, w: 1000, h: 800 }));
      act(() => { result.current.zoomIn(); }); // Shrink to have pan room
      const xBefore = result.current.viewBox.x;
      act(() => { result.current.panRight(); });
      expect(result.current.viewBox.x).toBeGreaterThan(xBefore);
    });

    it('panUp moves viewBox up (lower Y) after zooming in and panning down', () => {
      const { result } = renderHook(() => useSvgZoom({ x: 0, y: 0, w: 1000, h: 800 }));
      act(() => {
        result.current.zoomIn();  // Shrink viewBox
        result.current.panDown(); // Move down first
      });
      const yAfterDown = result.current.viewBox.y;
      act(() => { result.current.panUp(); });
      expect(result.current.viewBox.y).toBeLessThan(yAfterDown);
    });

    it('panDown moves viewBox down (higher Y) after zooming in', () => {
      const { result } = renderHook(() => useSvgZoom({ x: 0, y: 0, w: 1000, h: 800 }));
      act(() => { result.current.zoomIn(); }); // Shrink to have pan room
      const yBefore = result.current.viewBox.y;
      act(() => { result.current.panDown(); });
      expect(result.current.viewBox.y).toBeGreaterThan(yBefore);
    });

    it('clamps panLeft to initialViewBox.x', () => {
      const { result } = renderHook(() => useSvgZoom({ x: 0, y: 0, w: 500, h: 400 }));
      act(() => { result.current.panLeft(); });
      expect(result.current.viewBox.x).toBe(0);
    });

    it('clamps panRight to stay within bounds', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      act(() => {
        // First zoom in to have room to pan
        for (let i = 0; i < 5; i++) result.current.zoomIn();
      });
      const vbBefore = result.current.viewBox;
      const maxX = INITIAL_VB.x + INITIAL_VB.w - vbBefore.w;
      // Pan right many times
      act(() => {
        for (let i = 0; i < 50; i++) result.current.panRight();
      });
      expect(result.current.viewBox.x).toBeLessThanOrEqual(maxX + 0.01);
      expect(result.current.viewBox.x).toBeGreaterThanOrEqual(INITIAL_VB.x - 0.01);
    });
  });

  describe('reset functions', () => {
    it('resetZoom restores initialViewBox', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      act(() => {
        result.current.zoomIn();
        result.current.panRight();
      });
      expect(result.current.viewBox).not.toEqual(INITIAL_VB);
      act(() => { result.current.resetZoom(); });
      expect(result.current.viewBox).toEqual(INITIAL_VB);
    });

    it('resetPanH centers horizontally while preserving zoom and vertical offset', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      act(() => {
        result.current.zoomIn();
        result.current.panRight();
        result.current.panDown();
      });
      const vbBefore = result.current.viewBox;
      act(() => { result.current.resetPanH(); });
      const vbAfter = result.current.viewBox;
      // Width and height preserved
      expect(vbAfter.w).toBeCloseTo(vbBefore.w);
      expect(vbAfter.h).toBeCloseTo(vbBefore.h);
      // Y preserved
      expect(vbAfter.y).toBeCloseTo(vbBefore.y);
    });

    it('resetPanV centers vertically while preserving zoom and horizontal offset', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      act(() => {
        result.current.zoomIn();
        result.current.panRight();
        result.current.panDown();
      });
      const vbBefore = result.current.viewBox;
      act(() => { result.current.resetPanV(); });
      const vbAfter = result.current.viewBox;
      // Width and height preserved
      expect(vbAfter.w).toBeCloseTo(vbBefore.w);
      expect(vbAfter.h).toBeCloseTo(vbBefore.h);
      // X preserved
      expect(vbAfter.x).toBeCloseTo(vbBefore.x);
    });
  });

  describe('wheel zoom', () => {
    it('zoom-in on wheel up (deltaY < 0) shrinks viewBox', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      const svg = attachFakeSvg(result, { left: 0, top: 0, width: 1000, height: 800 });
      const vbBefore = result.current.viewBox;

      act(() => {
        result.current.handleWheel({
          preventDefault: vi.fn(),
          deltaY: -100,
          clientX: 500, // center of SVG
          clientY: 400,
        });
      });

      expect(result.current.viewBox.w).toBeLessThan(vbBefore.w);
      expect(result.current.viewBox.h).toBeLessThan(vbBefore.h);
    });

    it('zoom-out on wheel down (deltaY > 0) grows viewBox', () => {
      // Start zoomed in
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      attachFakeSvg(result, { left: 0, top: 0, width: 1000, height: 800 });
      act(() => {
        for (let i = 0; i < 5; i++) result.current.zoomIn();
      });
      const vbBefore = { ...result.current.viewBox };

      act(() => {
        result.current.handleWheel({
          preventDefault: vi.fn(),
          deltaY: 100,
          clientX: 500,
          clientY: 400,
        });
      });

      expect(result.current.viewBox.w).toBeGreaterThan(vbBefore.w);
    });

    it('cursor-centered zoom: clicking left edge zooms toward that edge', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      attachFakeSvg(result, { left: 0, top: 0, width: 1000, height: 800 });

      act(() => {
        result.current.handleWheel({
          preventDefault: vi.fn(),
          deltaY: -100,
          clientX: 0, // far left edge
          clientY: 400,
        });
      });

      // The viewBox X should stay close to 0 (zoom centered toward left edge)
      // rather than moving right
      expect(result.current.viewBox.x).toBeCloseTo(0, -1);
    });

    it('zooms to max bounds when wheel zoom-out exceeds initial', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      attachFakeSvg(result, { left: 0, top: 0, width: 1000, height: 800 });

      act(() => {
        result.current.handleWheel({
          preventDefault: vi.fn(),
          deltaY: 100, // zoom out
          clientX: 500,
          clientY: 400,
        });
      });

      // Should not exceed initial w
      expect(result.current.viewBox.w).toBeCloseTo(INITIAL_VB.w);
    });
  });

  describe('drag panning', () => {
    it('starts drag on left mouse button', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));
      attachFakeSvg(result, { left: 0, top: 0, width: 1000, height: 800 });

      act(() => {
        result.current.handleMouseDown({
          button: 0,
          clientX: 500,
          clientY: 400,
          preventDefault: vi.fn(),
        });
      });

      // After mouseDown alone, viewBox should not change
      expect(result.current.viewBox.x).toBe(INITIAL_VB.x);
      expect(result.current.viewBox.y).toBe(INITIAL_VB.y);
    });

    it('does not start drag on non-left button', () => {
      const { result } = renderHook(() => useSvgZoom(INITIAL_VB));

      act(() => {
        result.current.handleMouseDown({
          button: 2, // right click
          clientX: 500,
          clientY: 400,
          preventDefault: vi.fn(),
        });
      });

      // No crash, viewBox unchanged
      expect(result.current.viewBox).toEqual(INITIAL_VB);
    });
  });
});
