/**
 * Pure helpers for cascading flight field updates.
 *
 * When a field changes, related fields may need automatic updates:
 *   1. FlightNum or AirlineCode change → rebuild CallSign
 *   2. AirlineCode change → cascade Registration to first valid (aircraft type
 *      is independent of the airline and never changes)
 *   3. Runway change → cascade Airway to first valid STAR
 *   4. Language change → cascade Voice to the first option valid for the new
 *      language (the game's VoiceCatalog rejects a voice/language mismatch)
 *   5. Registration edit → clear internal _Registration bookkeeping field
 *
 * All functions are pure: they take inputs and return computed updates.
 * The caller (appStore.updateFlight) merges them into the flight object.
 */
import { pickFirstFlightNumber } from './flightDefaults.js';
import { languageForAirline } from '../utils/airlineLanguage.js';

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
 * When AirlineCode changes, cascade to Registration and AirlineName (the game
 * stores the 3-letter code there). AircraftType is deliberately NOT changed —
 * it is independent of the airline.
 * Returns the fields that should be updated on the flight.
 *
 * @param {string} newCode - the new airline code
 * @param {object} flight - the flight AFTER preliminary updates (CallSign rebuilt)
 * @param {object} airportValues - airportValues[currentAirport]
 * @returns {{ Registration?: string, AirlineName?: string, _Registration?: undefined }}
 */
export function cascadeAirlineChange(newCode, flight, airportValues) {
  const result = {};
  result.AirlineName = newCode;

  // Registration: reset to first valid reg for airline + the (unchanged) aircraft type
  const acType = flight.AircraftType || '';
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
 * When Language changes, cascade Voice to the FIRST option the FlightTable
 * Voice dropdown would offer for the new language (the dropdown filters to
 * voices whose catalog language matches; catalog-unknown voices are the
 * fallback, then the full pool). Always returns the first option so the cell
 * never keeps a stale voice from the previous language.
 *
 * Returns {} when there is no catalog map or no voice pool (nothing to pick).
 *
 * @param {string} newLanguage - the new Language value
 * @param {object} airportValues - airportValues[currentAirport]
 * @returns {{ Voice: string } | {}}
 */
export function cascadeLanguageChange(newLanguage, airportValues) {
  const langOf = (airportValues || {})._voiceLanguages || {};
  const pool = (airportValues || {}).Voice || [];
  if (!newLanguage || pool.length === 0 || Object.keys(langOf).length === 0) return {};
  const matching = pool.filter((v) => langOf[v] === newLanguage);
  const unknown = pool.filter((v) => !langOf[v]);
  const next = matching.length > 0 ? matching : (unknown.length > 0 ? unknown : pool);
  return next.length > 0 ? { Voice: next[0] } : {};
}

/**
 * When the airline (callsign prefix) changes, cascade Language (and Voice) to
 * the captain language the game's CallsignService requires: CN carriers speak
 * zh, every other carrier speaks en. A mismatch makes the game throw
 * "failed to allocate callsign ... for crew voice ..." at level load
 * (CAL2017 paired with a zh `CN-Captain-Young`).
 *
 * Returns {} when the airline is unknown to the registry or the language is
 * already correct, so a caller can safely merge the result.
 *
 * @param {string} newCode - the new 3-letter airline code
 * @param {object} flight - the flight AFTER preliminary updates
 * @param {object} airportValues - airportValues[currentAirport]
 * @returns {{ Language?: string, Voice?: string }}
 */
export function cascadeAirlineLanguage(newCode, flight, airportValues) {
  const vals = airportValues || {};
  const expected = languageForAirline(newCode, vals._airlineCountries, vals.Language);
  if (!expected || expected === (flight.Language || '')) return {};
  const result = { Language: expected };
  const voiceUpdates = cascadeLanguageChange(expected, vals);
  if (voiceUpdates.Voice) result.Voice = voiceUpdates.Voice;
  return result;
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
