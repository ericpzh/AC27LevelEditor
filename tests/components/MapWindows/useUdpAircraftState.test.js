import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { ElectronAPIProvider } from '../../../src/hooks/useElectronAPI';
import useUdpAircraftState from '../../../src/components/MapWindows/useUdpAircraftState';

/**
 * Wrapper that provides a custom electronAPI for the hook under test.
 */
function makeWrapper(api) {
  return function Wrapper({ children }) {
    // Override the global mock so useContext picks up our custom api
    const original = window.electronAPI;
    window.electronAPI = api;
    const result = React.createElement(ElectronAPIProvider, null, children);
    return result;
  };
}

describe('useUdpAircraftState', () => {
  it('returns default initial state', () => {
    const api = {
      onUdpAircraftState: vi.fn(),
      offUdpAircraftState: vi.fn(),
    };
    const { result } = renderHook(() => useUdpAircraftState(), {
      wrapper: makeWrapper(api),
    });
    expect(result.current).toEqual({
      aircraft: [],
      currentAirport: null,
      simTimeUnixMs: 0,
    });
  });

  it('subscribes on mount', () => {
    const api = {
      onUdpAircraftState: vi.fn(),
      offUdpAircraftState: vi.fn(),
    };
    renderHook(() => useUdpAircraftState(), { wrapper: makeWrapper(api) });
    expect(api.onUdpAircraftState).toHaveBeenCalledTimes(1);
    expect(api.onUdpAircraftState).toHaveBeenCalledWith(expect.any(Function));
  });

  it('unsubscribes on unmount', () => {
    const api = {
      onUdpAircraftState: vi.fn(),
      offUdpAircraftState: vi.fn(),
    };
    const { unmount } = renderHook(() => useUdpAircraftState(), {
      wrapper: makeWrapper(api),
    });
    // Capture the handler that was registered
    const handler = api.onUdpAircraftState.mock.calls[0][0];
    unmount();
    expect(api.offUdpAircraftState).toHaveBeenCalledTimes(1);
    expect(api.offUdpAircraftState).toHaveBeenCalledWith(handler);
  });

  it('updates state when handler is called', () => {
    const api = {
      onUdpAircraftState: vi.fn(),
      offUdpAircraftState: vi.fn(),
    };
    const { result } = renderHook(() => useUdpAircraftState(), {
      wrapper: makeWrapper(api),
    });
    const handler = api.onUdpAircraftState.mock.calls[0][0];

    act(() => {
      handler({
        aircraft: [{ callSign: 'CES1234', position: { x: 100, y: 50, z: 200 } }],
        currentAirport: 'ZSJN',
        simTimeUnixMs: 1718400000000,
      });
    });

    expect(result.current.currentAirport).toBe('ZSJN');
    expect(result.current.simTimeUnixMs).toBe(1718400000000);
    expect(result.current.aircraft).toHaveLength(1);
    expect(result.current.aircraft[0].callSign).toBe('CES1234');
  });

  it('handles null/undefined push gracefully', () => {
    const api = {
      onUdpAircraftState: vi.fn(),
      offUdpAircraftState: vi.fn(),
    };
    const { result } = renderHook(() => useUdpAircraftState(), {
      wrapper: makeWrapper(api),
    });
    const handler = api.onUdpAircraftState.mock.calls[0][0];

    act(() => { handler(null); });
    expect(result.current.aircraft).toEqual([]);
    expect(result.current.currentAirport).toBeNull();
    expect(result.current.simTimeUnixMs).toBe(0);

    act(() => { handler(undefined); });
    expect(result.current.aircraft).toEqual([]);

    act(() => { handler({}); });
    expect(result.current.aircraft).toEqual([]);
    expect(result.current.currentAirport).toBeNull();
    expect(result.current.simTimeUnixMs).toBe(0);
  });

  it('works when electronAPI does not have the UDP methods', () => {
    const api = {}; // No onUdpAircraftState/offUdpAircraftState
    const { result } = renderHook(() => useUdpAircraftState(), {
      wrapper: makeWrapper(api),
    });
    // Should not throw, should return default state
    expect(result.current).toEqual({
      aircraft: [],
      currentAirport: null,
      simTimeUnixMs: 0,
    });
  });
});
