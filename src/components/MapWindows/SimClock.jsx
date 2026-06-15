import React, { useMemo } from 'react';

/**
 * Displays the sim time as HH:MM:SS UTC in the top-left corner.
 * Renders nothing when simTimeUnixMs is 0 or falsy.
 */
export default function SimClock({ simTimeUnixMs }) {
  const timeStr = useMemo(() => {
    if (!simTimeUnixMs) return null;
    const d = new Date(simTimeUnixMs);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }, [simTimeUnixMs]);

  if (!timeStr) return null;

  return <div className="air-map-clock">{timeStr}</div>;
}
