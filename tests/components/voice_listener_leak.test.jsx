/**
 * Regression test: useVoiceCommands must keep exactly ONE voice-stt-event
 * listener, even though its closures change with every 200 ms udpAircraft
 * push (the real main-process push rate, electron/main.js).
 *
 * The mock mimics Electron's contextBridge, which does NOT preserve function
 * identity across separate crossings (electron_api_context_bridge.cc wraps
 * every crossing in a fresh proxy). A bridge that keys a Map by the callback
 * argument (the old preload on/off pattern) can therefore never remove
 * listeners — the old hook's 5 Hz re-subscription effect leaked one
 * ipcRenderer listener per push, so every spoken sentence produced hundreds
 * of identical [VOICE-PARSE] log lines. The fixed hook subscribes once and
 * the fixed preload returns an unsubscribe closing over the exact handler.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import React from 'react';
import useVoiceCommands from '../../src/components/MapWindows/useVoiceCommands';
import { ElectronAPIProvider } from '../../src/hooks/useElectronAPI';

// Mimic contextBridge's identity loss: a fresh wrapper for EVERY crossing.
function makeBridge() {
  const ipcListeners = [];
  const bridge = {
    logs: [],
    onVoiceSttEvent(cb) {
      const proxied = (...a) => cb(...a);   // fresh proxy per crossing
      const handler = (_e, data) => proxied(data);
      ipcListeners.push(handler);
      return () => {                        // unsubscribe from THIS on()
        const i = ipcListeners.indexOf(handler);
        if (i >= 0) ipcListeners.splice(i, 1);
      };
    },
    offVoiceSttEvent() {
      // Legacy preload bridge: under contextBridge the cb stored by on() is a
      // different proxy than the one arriving here, so this is a no-op — kept
      // for API compat, exactly as in the real preload.
    },
    emit(evt) { [...ipcListeners].forEach((h) => h(null, evt)); },
    listenerCount() { return ipcListeners.length; },
    // Rest of the API surface the hook touches:
    getVoiceSttStatus: async () => ({ available: true, culture: 'en-US' }),
    voiceSttStart: async () => ({ success: true }),
    voiceSttStop: async () => ({ success: true }),
    debugLog: (...args) => { bridge.logs.push(args); },
  };
  return bridge;
}

function Harness({ aircraft }) {
  useVoiceCommands(aircraft);
  return <div />;
}

describe('useVoiceCommands listener hygiene', () => {
  let bridge;
  beforeEach(() => {
    bridge = makeBridge();
    window.electronAPI = bridge;
  });
  afterEach(() => {
    cleanup();
  });

  it('keeps exactly one listener across 5Hz aircraft churn, one log per result', async () => {
    // Mount with empty aircraft (as at app boot)
    let view;
    await act(async () => {
      view = render(
        <ElectronAPIProvider>
          <Harness aircraft={[]} />
        </ElectronAPIProvider>
      );
    });

    // Simulate 20 UDP pushes at 200ms (5Hz) with new array identities — the
    // old effect re-subscribed here, leaking one listener per push.
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        view.rerender(
          <ElectronAPIProvider>
            <Harness aircraft={[{ callSign: 'JBU2039', controlSeat: 5 }]} />
          </ElectronAPIProvider>
        );
      });
    }

    expect(bridge.listenerCount()).toBe(1);

    // One result event → exactly one [VOICE-PARSE] debugLog line
    bridge.emit({ type: 'result', text: 'jetblue twenty three nine', confidence: 0.9, language: 'en' });
    expect(bridge.logs.length).toBe(1);
    expect(bridge.logs[0][1]).toBe('"jetblue twenty three nine"');

    // A second sentence stays at one line too (no late accumulation)
    bridge.emit({ type: 'result', text: 'turn right heading three six zero', confidence: 0.9, language: 'en' });
    expect(bridge.logs.length).toBe(2);
    expect(bridge.listenerCount()).toBe(1);
  });
});
