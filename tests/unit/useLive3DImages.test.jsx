/**
 * Tests for the 120 ms live-3D-preview poll (useLive3DImages). The hook decides
 * when painting actually changed (via the canvas' monotonic revision) and pushes
 * a fresh, cheap panel export — without React churn during a stroke.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLive3DImages } from '../../src/components/LiveryScreen/useLive3DImages';

let rev;
let exported;
let canvas;

function canvasWith(over = {}) {
  return { getRevision: () => rev, exportPreviewParts: vi.fn(() => exported), ...over };
}

function tick(ms = 120) {
  act(() => { vi.advanceTimersByTime(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  rev = 0;
  exported = [{ partName: 'Body', imageDataUrl: 'data:image/png;base64,A' }];
  canvas = canvasWith();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLive3DImages', () => {
  it('does nothing while inactive', () => {
    const onImages = vi.fn();
    renderHook(() => useLive3DImages({ active: false, canvasRef: { current: canvas }, onImages }));
    tick(1000);
    expect(canvas.exportPreviewParts).not.toHaveBeenCalled();
    expect(onImages).not.toHaveBeenCalled();
  });

  it('does not re-export when the revision is unchanged', () => {
    const onImages = vi.fn();
    renderHook(() => useLive3DImages({ active: true, canvasRef: { current: canvas }, onImages }));
    tick(1000);
    expect(canvas.exportPreviewParts).not.toHaveBeenCalled();
  });

  it('re-exports the small panel images when the revision changes', () => {
    const onImages = vi.fn();
    renderHook(() => useLive3DImages({ active: true, canvasRef: { current: canvas }, onImages }));
    rev = 1;
    tick();
    expect(canvas.exportPreviewParts).toHaveBeenCalledWith(512);
    expect(onImages).toHaveBeenCalledTimes(1);
    expect(onImages).toHaveBeenCalledWith(exported);
  });

  it('only exports once per revision change', () => {
    const onImages = vi.fn();
    renderHook(() => useLive3DImages({ active: true, canvasRef: { current: canvas }, onImages }));
    rev = 1;
    tick();
    tick();
    tick();
    expect(canvas.exportPreviewParts).toHaveBeenCalledTimes(1);
  });

  it('seeds from the current revision on activation (no immediate downgrade)', () => {
    const onImages = vi.fn();
    const canvasRef = { current: canvas };
    const view = renderHook(({ active }) => useLive3DImages({ active, canvasRef, onImages }), { initialProps: { active: false } });
    rev = 7;
    act(() => { view.rerender({ active: true }); });
    tick();
    expect(canvas.exportPreviewParts).not.toHaveBeenCalled(); // seeded at 7
    rev = 8;
    tick();
    expect(canvas.exportPreviewParts).toHaveBeenCalledTimes(1);
  });

  it('falls back to the full export when the canvas has no exportPreviewParts', () => {
    const onImages = vi.fn();
    const bare = { getRevision: () => rev };
    const exportFallback = vi.fn(() => [{ partName: 'Body', imageDataUrl: 'FULL' }]);
    renderHook(() => useLive3DImages({ active: true, canvasRef: { current: bare }, onImages, exportFallback }));
    rev = 3;
    tick();
    expect(exportFallback).toHaveBeenCalledTimes(1);
    expect(onImages).toHaveBeenCalledWith([{ partName: 'Body', imageDataUrl: 'FULL' }]);
  });

  it('keeps the previous textures when the export throws (no retry storm)', () => {
    const onImages = vi.fn();
    const boom = canvasWith({ exportPreviewParts: vi.fn(() => { throw new Error('gone'); }) });
    renderHook(() => useLive3DImages({ active: true, canvasRef: { current: boom }, onImages }));
    rev = 4;
    tick();
    tick();
    expect(boom.exportPreviewParts).toHaveBeenCalledTimes(1);
    expect(onImages).not.toHaveBeenCalled();
  });

  it('never touches a null canvas handle', () => {
    const onImages = vi.fn();
    const canvasRef = { current: null };
    renderHook(() => useLive3DImages({ active: true, canvasRef, onImages }));
    expect(() => tick(500)).not.toThrow();
    expect(onImages).not.toHaveBeenCalled();
    // Once the handle appears, the next changed revision flows through.
    canvasRef.current = canvas;
    rev = 2;
    tick();
    expect(canvas.exportPreviewParts).toHaveBeenCalledTimes(1);
  });

  it('ignores a canvas without getRevision', () => {
    const onImages = vi.fn();
    renderHook(() => useLive3DImages({ active: true, canvasRef: { current: { exportPreviewParts: vi.fn() } }, onImages }));
    expect(() => tick(500)).not.toThrow();
    expect(onImages).not.toHaveBeenCalled();
  });

  it('uses the latest onImages callback without re-subscribing', () => {
    const first = vi.fn();
    const second = vi.fn();
    const canvasRef = { current: canvas };
    const view = renderHook(({ onImages }) => useLive3DImages({ active: true, canvasRef, onImages }), { initialProps: { onImages: first } });
    view.rerender({ onImages: second });
    rev = 9;
    tick();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops polling after unmount', () => {
    const onImages = vi.fn();
    const view = renderHook(() => useLive3DImages({ active: true, canvasRef: { current: canvas }, onImages }));
    view.unmount();
    rev = 5;
    tick(1000);
    expect(canvas.exportPreviewParts).not.toHaveBeenCalled();
    expect(onImages).not.toHaveBeenCalled();
  });

  it('honours a custom interval', () => {
    const onImages = vi.fn();
    renderHook(() => useLive3DImages({ active: true, canvasRef: { current: canvas }, onImages, intervalMs: 500 }));
    rev = 1;
    tick(120);
    expect(canvas.exportPreviewParts).not.toHaveBeenCalled();
    tick(400);
    expect(canvas.exportPreviewParts).toHaveBeenCalledTimes(1);
  });
});
