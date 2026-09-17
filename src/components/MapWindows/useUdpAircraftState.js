import { useState, useEffect, useRef } from 'react';
import { useElectronAPI } from '../../hooks/useElectronAPI';

/**
 * Subscribe to live UDP aircraft state pushes from the main process.
 * Returns { aircraft, currentAirport, simTimeUnixMs, simFlags, timeScale,
 *          udpConnected, udpAirportChanged } — updated at ~10 Hz.
 *
 * `udpConnected` is true while the listener is receiving packets (<2s old);
 * `null` until the first push arrives.
 * `udpAirportChanged` is true for one render when the UDP airport code
 * transitions from one valid code to a different one.
 */
export default function useUdpAircraftState() {
  const electronAPI = useElectronAPI();
  const [state, setState] = useState({ aircraft: [], currentAirport: null, simTimeUnixMs: 0, simFlags: 0, timeScale: 0, udpConnected: null, udpAirportChanged: false });
  const prevAirportRef = useRef(null);

  useEffect(() => {
    const handler = (s) => {
      const newAirport = s?.currentAirport || null;
      const prev = prevAirportRef.current;
      const changed = !!(newAirport && prev && newAirport !== prev);
      if (changed) {
        console.log('[UDP hook] Airport transition: ' + prev + ' → ' + newAirport);
      }
      prevAirportRef.current = newAirport;

      setState({
        aircraft: s?.aircraft || [],
        currentAirport: newAirport,
        simTimeUnixMs: s?.simTimeUnixMs || 0,
        simFlags: s?.simFlags ?? 0,
        timeScale: s?.timeScale ?? 0,
        udpConnected: typeof s?.connected === 'boolean' ? s.connected : null,
        udpAirportChanged: changed,
      });
    };
    if (electronAPI && electronAPI.onUdpAircraftState) {
      electronAPI.onUdpAircraftState(handler);
    }
    return () => {
      if (electronAPI && electronAPI.offUdpAircraftState) {
        electronAPI.offUdpAircraftState(handler);
      }
    };
  }, [electronAPI]);

  return state;
}
