/**
 * useCrossWindowSelection — shared IPC listener for cross-window aircraft selection sync.
 *
 * Listens for `aircraft-selected-in-map` IPC events scoped to the given airport ICAO.
 * Fetches the current selection on mount so a newly-opened window mirrors any existing one.
 *
 * Used by: AirMapWindow, GroundMapWindow, FlightStripsWindow.
 */
import { useEffect } from 'react';

/**
 * @param {string|null} airportIcao
 * @param {object|null} electronAPI
 * @param {function} setSelectedCallSign — state setter for the selected callsign
 */
export function useCrossWindowSelection(airportIcao, electronAPI, setSelectedCallSign) {
  useEffect(() => {
    if (!electronAPI || !airportIcao) return;
    // Fetch current selection on mount
    if (electronAPI.getSelectedAircraft) {
      electronAPI.getSelectedAircraft(airportIcao).then(r => {
        if (r?.callSign) setSelectedCallSign(r.callSign);
      });
    }
    const handler = (data) => {
      if (data.icao === airportIcao) setSelectedCallSign(data.callSign || null);
    };
    if (electronAPI.onAircraftSelectedInMap) {
      electronAPI.onAircraftSelectedInMap(handler);
    }
    return () => {
      if (electronAPI.offAircraftSelectedInMap) {
        electronAPI.offAircraftSelectedInMap(handler);
      }
    };
  }, [electronAPI, airportIcao, setSelectedCallSign]);
}

/**
 * useCrossWindowEmergency — shared IPC listener for emergency aircraft sync.
 *
 * Used by: AirMapWindow, FlightStripsWindow.
 */
export function useCrossWindowEmergency(airportIcao, electronAPI, setEmergencyCallSign) {
  useEffect(() => {
    if (!electronAPI || !airportIcao) return;
    if (electronAPI.getEmergencyAircraft) {
      electronAPI.getEmergencyAircraft(airportIcao).then(r => {
        if (r?.callSign) setEmergencyCallSign(r.callSign);
      });
    }
    const handler = (data) => {
      if (data.icao === airportIcao) setEmergencyCallSign(data.callSign || null);
    };
    if (electronAPI.onEmergencyAircraftChanged) {
      electronAPI.onEmergencyAircraftChanged(handler);
    }
    return () => {
      if (electronAPI.offEmergencyAircraftChanged) {
        electronAPI.offEmergencyAircraftChanged(handler);
      }
    };
  }, [electronAPI, airportIcao, setEmergencyCallSign]);
}
