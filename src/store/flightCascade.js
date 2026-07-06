/**
 * Pure helpers for cascading flight field updates.
 *
 * When a field changes, related fields may need automatic updates:
 *   1. FlightNum or AirlineCode change → rebuild CallSign
 *   2. AirlineCode change → cascade AircraftType + Registration to first valid
 *   3. Runway change → cascade Airway to first valid STAR
 *   4. Registration edit → clear internal _Registration bookkeeping field
 *
 * All functions are pure: they take inputs and return computed updates.
 * The caller (appStore.updateFlight) merges them into the flight object.
 */
import { pickFirstFlightNumber } from './flightDefaults.js';

/**
 * Rebuild a CallSign from AirlineCode + FlightNum.
 * If FlightNum is explicitly provided it's used as-is;
 * otherwise auto-picks the first canonical number for the airline.
 *
 * @param {object} oldFlight - the flight BEFORE updates
 * @param {object} updates - partial updates from the user
 * @param {object} airportValues - airportValues[currentAirport] for canonical numbers
 * @returns {string} new CallSign
 */
export function rebuildCallSign(oldFlight, updates, airportValues) {
  const code = updates.AirlineCode || oldFlight.AirlineCode || (oldFlight.CallSign || '').substring(0, 3);
  let num;
  if ('FlightNum' in updates) {
    num = updates.FlightNum;
  } else {
    num = pickFirstFlightNumber(airportValues, code);
    if (!num || num === '1') {
      num = (oldFlight.CallSign || '').substring(3);
    }
  }
  return code + num;
}

/**
 * When AirlineCode changes, cascade to AircraftType and Registration.
 * Returns the fields that should be updated on the flight.
 *
 * @param {string} newCode - the new airline code
 * @param {object} flight - the flight AFTER preliminary updates (CallSign rebuilt)
 * @param {object} airportValues - airportValues[currentAirport]
 * @returns {{ AircraftType?: string, Registration?: string, _Registration?: undefined }}
 */
export function cascadeAirlineChange(newCode, flight, airportValues) {
  const result = {};
  const compat = (airportValues || {})._compat || {};

  // AircraftType: reset to first valid type for the new airline
  const validTypes = compat.airlineToAircraft?.[newCode];
  if (validTypes && validTypes.length > 0) {
    const curType = flight.AircraftType || '';
    if (!curType || !validTypes.includes(curType)) {
      result.AircraftType = validTypes[0];
    }
  }

  // Registration: reset to first valid reg for airline + aircraft type
  const acType = result.AircraftType || flight.AircraftType || '';
  const regKey = newCode + '|' + acType;
  const validRegs = (airportValues || {})._registrationMap?.[regKey];
  if (validRegs && validRegs.length > 0) {
    const curReg = flight.Registration || flight._Registration || '';
    if (!curReg || !validRegs.includes(curReg)) {
      result.Registration = validRegs[0];
    }
  }

  return result;
}

/**
 * When Runway changes, cascade to Airway (STAR).
 * If the new runway has valid STARs, reset to the first one.
 * If no STAR is valid for this runway, clear the Airway.
 *
 * @param {string} newRunway - the new runway name
 * @param {object} flight - the flight state (current Airway)
 * @param {object} airportValues - airportValues[currentAirport]
 * @returns {{ Airway: string }}
 */
export function cascadeRunwayChange(newRunway, flight, airportValues) {
  const runwayStarMap = (airportValues || {})._runwayStarMap || {};
  const validStars = runwayStarMap[newRunway] || [];
  const curAirway = flight.Airway || '';

  if (validStars.length > 0) {
    if (!curAirway || !validStars.includes(curAirway)) {
      return { Airway: validStars[0] };
    }
    return {};
  }
  // No STAR is valid for this runway — clear the stale value
  return { Airway: '' };
}

/**
 * Strip the internal _Registration key when user explicitly edits Registration.
 * The display layer reads _Registration first, so it must be removed to avoid
 * shadowing the user's explicit value.
 *
 * @param {object} flight - mutable flight object (mutated in place)
 */
export function clearInternalRegistration(flight) {
  delete flight._Registration;
}
