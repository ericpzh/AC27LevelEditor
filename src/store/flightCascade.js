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
import { pickFirstFlightNumber, pickV3LanguageVoiceAndNumber } from './flightDefaults.js';
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
export function cascadeLanguageChange(newLanguage, airportValues, flight = null) {
  const vals = airportValues || {};
  const langOf = vals._voiceLanguages || {};
  const pool = vals.Voice || [];
  if (!newLanguage || pool.length === 0 || Object.keys(langOf).length === 0) return {};
  const matching = pool.filter((v) => langOf[v] === newLanguage);
  const unknown = pool.filter((v) => !langOf[v]);
  const next = matching.length > 0 ? matching : (unknown.length > 0 ? unknown : pool);
  if (next.length === 0) return {};

  if (vals._v3Audio?.hasClipIndex && flight?.CallSign) {
    const cs = String(flight.CallSign).trim();
    const withAlloc = next.find((v) => (vals._v3Audio.allocatableCallsignsByVoice?.[v] || []).includes(cs));
    if (withAlloc) return { Voice: withAlloc };
    const withClip = next.find((v) => (vals._v3Audio.voiceCallsigns?.[v] || []).includes(cs));
    if (withClip) return { Voice: withClip };
  }
  return { Voice: next[0] };
}

/**
 * When the airline (callsign prefix) changes, cascade Language (and Voice) to
 * a compatible language/voice pair.
 *
 * - On GATCARC4 v3 (`vals._v3Audio` present): if the flight's existing
 *   `(Language, Voice)` already allocates the new `CallSign` against the
 *   airport's clip index, keep it untouched; otherwise pick a compatible
 *   `(Language, Voice)` from `vals._v3Audio`.
 * - On legacy/v2 (`vals._v3Audio` absent): CN carriers speak `zh` and every
 *   other carrier speaks `en` per `airline_country_registry`.
 *
 * @param {string} newCode - the new 3-letter airline code
 * @param {object} flight - the flight AFTER preliminary updates
 * @param {object} airportValues - airportValues[currentAirport]
 * @returns {{ Language?: string, Voice?: string }}
 */
export function cascadeAirlineLanguage(newCode, flight, airportValues) {
  const vals = airportValues || {};
  if (vals._v3Audio) {
    const v3 = vals._v3Audio;
    const curLang = String(flight?.Language || '').trim();
    const curVoice = String(flight?.Voice || '').trim();
    const cs = String(flight?.CallSign || '').trim();
    const langAllowed = !Array.isArray(v3.knownChannelLanguages)
      || v3.knownChannelLanguages.length === 0
      || v3.knownChannelLanguages.includes(curLang);
    if (
      curLang &&
      curVoice &&
      langAllowed &&
      (!v3.hasClipIndex || (v3.allocatableCallsignsByVoice?.[curVoice] || []).includes(cs))
    ) {
      return {};
    }
    const flightNum = cs.startsWith(newCode) ? cs.slice(newCode.length) : cs.slice(3);
    const picked = pickV3LanguageVoiceAndNumber(newCode, flightNum, vals, v3.icao || '');
    const result = {};
    if (picked.language && picked.language !== curLang) result.Language = picked.language;
    if (picked.voice && picked.voice !== curVoice) result.Voice = picked.voice;
    return result;
  }

  const expected = languageForAirline(newCode, vals._airlineCountries, vals.Language);
  if (!expected || expected === (flight.Language || '')) return {};
  const result = { Language: expected };
  const voiceUpdates = cascadeLanguageChange(expected, vals, flight);
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
