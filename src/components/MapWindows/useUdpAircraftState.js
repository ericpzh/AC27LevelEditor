import { useState, useEffect } from 'react';
import { useElectronAPI } from '../../hooks/useElectronAPI';

/**
 * Subscribe to live UDP aircraft state pushes from the main process.
 * Returns { aircraft, currentAirport } updated at ~10 Hz.
 */
export default function useUdpAircraftState() {
  const electronAPI = useElectronAPI();
  const [state, setState] = useState({ aircraft: [], currentAirport: null, simTimeUnixMs: 0 });

  useEffect(() => {
    const handler = (s) => {
      setState({
        aircraft: s?.aircraft || [],
        currentAirport: s?.currentAirport || null,
        simTimeUnixMs: s?.simTimeUnixMs || 0,
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
