/**
 * Unit tests for the VoiceSttWorker start/stop state machine.
 *
 * Regression guard for hold-to-talk: a quick tap's `stop` can arrive before
 * the child reports `started`, which previously left the mic recording
 * forever. The worker now remembers the stop and applies it on `started`.
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';

const { VoiceSttWorker } = require('../../electron/voiceSttWorker');

const STOP_DRAIN_MS = 1500;

function makeWorker() {
  const w = new VoiceSttWorker();
  w.statusCache = { available: true };   // skip the lazy spawn/probe
  w.state = 'ready';
  w._send = vi.fn();
  return w;
}

describe('VoiceSttWorker start/stop', () => {
  it('start sends start and clears startPending on started', async () => {
    const w = makeWorker();
    const r = await w.start({}, []);
    expect(r).toEqual({ success: true });
    expect(w._send).toHaveBeenCalledWith({ cmd: 'start', extraWords: [] });
    expect(w.startPending).toBe(true);
    w._onLine(JSON.stringify({ type: 'started' }));
    expect(w.state).toBe('recognizing');
    expect(w.startPending).toBe(false);
  });

  it('applies a stop that raced the start once started arrives', async () => {
    vi.useFakeTimers();
    try {
      const w = makeWorker();
      await w.start({}, []);
      w.stop();                       // release before 'started'
      expect(w.stopTimer).toBeNull();
      expect(w.stopPending).toBe(true);
      w._onLine(JSON.stringify({ type: 'started' }));
      expect(w.stopTimer).toBeTruthy();
      expect(w._send).not.toHaveBeenCalledWith({ cmd: 'stop' });
      vi.advanceTimersByTime(STOP_DRAIN_MS);
      expect(w._send).toHaveBeenCalledWith({ cmd: 'stop' });
    } finally { vi.useRealTimers(); }
  });

  it('a normal stop while recognizing drains then sends stop', async () => {
    vi.useFakeTimers();
    try {
      const w = makeWorker();
      await w.start({}, []);
      w._onLine(JSON.stringify({ type: 'started' }));
      w.stop();
      expect(w.stopTimer).toBeTruthy();
      vi.advanceTimersByTime(STOP_DRAIN_MS);
      expect(w._send).toHaveBeenCalledWith({ cmd: 'stop' });
    } finally { vi.useRealTimers(); }
  });

  it('stop with nothing pending is a no-op', () => {
    const w = makeWorker();
    w.stop();
    expect(w.stopTimer).toBeNull();
    expect(w.stopPending).toBe(false);
    expect(w._send).not.toHaveBeenCalled();
  });

  it('re-press inside the drain cancels the pending stop', async () => {
    vi.useFakeTimers();
    try {
      const w = makeWorker();
      await w.start({}, []);
      w._onLine(JSON.stringify({ type: 'started' }));
      w.stop();
      await w.start({}, []);          // re-press within the drain window
      expect(w.stopTimer).toBeNull();
      vi.advanceTimersByTime(5000);
      expect(w._send).not.toHaveBeenCalledWith({ cmd: 'stop' });
    } finally { vi.useRealTimers(); }
  });
});
