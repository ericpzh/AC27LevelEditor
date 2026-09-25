/**
 * Unit tests for electron/pttKeyWatch.js — the Windows global key-state
 * watcher that gives the PTT hotkey a real key-UP edge (hold-to-talk).
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';

const { acceleratorToVk, createPttKeyWatch } = require('../../electron/pttKeyWatch');

// ─── acceleratorToVk ────────────────────────────────────────────────

describe('acceleratorToVk', () => {
  it('maps the main key regardless of modifiers', () => {
    expect(acceleratorToVk('Shift+Space')).toBe(0x20);
    expect(acceleratorToVk('Ctrl+Alt+P')).toBe('P'.charCodeAt(0));
    expect(acceleratorToVk('F9')).toBe(0x78);          // 0x70 + (9-1)
    expect(acceleratorToVk('F24')).toBe(0x70 + 23);
    expect(acceleratorToVk('Ctrl+1')).toBe('1'.charCodeAt(0));
    expect(acceleratorToVk('Alt+Tab')).toBe(0x09);
  });

  it('maps common OEM punctuation', () => {
    expect(acceleratorToVk('/')).toBe(0xBF);
    expect(acceleratorToVk('Shift+;')).toBe(0xBA);
    expect(acceleratorToVk('Ctrl+.')).toBe(0xBE);
  });

  it('returns 0 for empty / unmappable input', () => {
    expect(acceleratorToVk('')).toBe(0);
    expect(acceleratorToVk(null)).toBe(0);
    expect(acceleratorToVk(undefined)).toBe(0);
    expect(acceleratorToVk('Super+Meta')).toBe(0);   // no recognized main key
    expect(acceleratorToVk('Ctrl+Alt')).toBe(0);     // no main key part
  });
});

// ─── createPttKeyWatch ──────────────────────────────────────────────

describe('createPttKeyWatch', () => {
  it('is unavailable (and never arms) without a probe', () => {
    const w = createPttKeyWatch({ isDown: null });
    expect(w.isAvailable()).toBe(false);
    expect(w.watch(0x20, () => {})).toBe(false);
  });

  it('fires onUp exactly once on the down→up transition', () => {
    vi.useFakeTimers();
    try {
      let down = true;
      const onUp = vi.fn();
      const w = createPttKeyWatch({ isDown: () => down, intervalMs: 40 });
      expect(w.watch(0x20, onUp)).toBe(true);
      vi.advanceTimersByTime(200);
      expect(onUp).not.toHaveBeenCalled();
      down = false;
      vi.advanceTimersByTime(40);
      expect(onUp).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(200);
      expect(onUp).toHaveBeenCalledTimes(1);        // timer stopped after firing
    } finally { vi.useRealTimers(); }
  });

  it('re-arming replaces the pending hold without firing the old callback', () => {
    vi.useFakeTimers();
    try {
      let down = true;
      const first = vi.fn();
      const second = vi.fn();
      const w = createPttKeyWatch({ isDown: () => down, intervalMs: 40 });
      w.watch(0x20, first);
      w.watch(0x20, second);                         // Windows hotkey auto-repeat
      down = false;
      vi.advanceTimersByTime(40);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('cancel stops polling without firing onUp', () => {
    vi.useFakeTimers();
    try {
      const onUp = vi.fn();
      const w = createPttKeyWatch({ isDown: () => false, intervalMs: 40 });
      w.watch(0x20, onUp);
      w.cancel();
      vi.advanceTimersByTime(200);
      expect(onUp).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('treats a throwing probe as released (fails safe)', () => {
    vi.useFakeTimers();
    try {
      const onUp = vi.fn();
      const w = createPttKeyWatch({ isDown: () => { throw new Error('boom'); }, intervalMs: 40 });
      w.watch(0x20, onUp);
      vi.advanceTimersByTime(40);
      expect(onUp).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('tolerates an onUp throw', () => {
    vi.useFakeTimers();
    try {
      const w = createPttKeyWatch({ isDown: () => false, intervalMs: 40 });
      w.watch(0x20, () => { throw new Error('consumer gone'); });
      expect(() => vi.advanceTimersByTime(40)).not.toThrow();
    } finally { vi.useRealTimers(); }
  });
});
