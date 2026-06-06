/**
 * CSV output — export in game format.
 */
const fs = require('fs');

// ─── CSV export (both formats are identical) ─────────────
function exportGameCSV(flights, csvPath) {
  const headers = 'registration,arrivalCallSign,originAirport,landingTime,arrivalStand,arrivalRunway,arrivalSTAR,departureCallSign,destinationAirport,offBlockTime,departureStand,departureRunway,airline,aircraftType,voice,language';
  const rows = [headers];
  for (const fl of flights) {
    const isArrival = !fl.isDeparture && !!(fl.LandingTime || '').trim();
    const isDeparture = fl.isDeparture || !!(fl.OffBlockTime || '').trim();
    const reg = fl._Registration || '';
    rows.push([
      reg,
      isArrival ? (fl.CallSign || '') : '',
      isArrival ? (fl.DepartureAirport || '') : '',
      isArrival ? (fl.LandingTime || '') : '',
      isArrival ? (fl.Stand || '') : '',
      isArrival ? (fl.Runway || '') : '',
      isArrival ? (fl.Airway || '') : '',
      isDeparture ? (fl.CallSign || '') : '',
      isDeparture ? (fl.ArrivalAirport || '') : '',
      isDeparture ? (fl.OffBlockTime || '') : '',
      isDeparture ? (fl.Stand || '') : '',
      isDeparture ? (fl.Runway || '') : '',
      fl.AirlineName || '', fl.AircraftType || '', fl.Voice || '', fl.Language || ''
    ].join(','));
  }
  fs.writeFileSync(csvPath, rows.join('\n'), 'utf-8');
}

function exportCSV(flights, csvPath) {
  return exportGameCSV(flights, csvPath);
}

module.exports = { exportCSV, exportGameCSV };
