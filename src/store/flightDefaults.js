/**
 * Pure helpers for creating new flight objects with sensible defaults.
 * Extracted from appStore.js to keep the store focused on state management.
 */
import { getAirlineCode, FALLBACK_BASE_MINUTES, DEFAULT_TIME_OFFSET_MIN, DEFAULT_TAXI_MINUTES } from '../utils/constants';

/**
 * Compute a default base time (in minutes from midnight) for new flights.
 * Uses configEndTime minus DEFAULT_TIME_OFFSET_MIN, clamped to >= 0,
 * falling back to FALLBACK_BASE_MINUTES (06:00).
 * @param {string|null} configEndTime - "HH:MM" string or null
 * @returns {number} minutes from midnight
 */
export function computeDefaultBaseMin(configEndTime) {
  if (!configEndTime) return FALLBACK_BASE_MINUTES;
  const p = String(configEndTime).split(':');
  let baseMin = parseInt(p[0]) * 60 + parseInt(p[1]) - DEFAULT_TIME_OFFSET_MIN;
  if (baseMin < 0) baseMin = 0;
  return baseMin;
}

/**
 * Format minutes-from-midnight to "HH:MM:00" string.
 * @param {number} m - minutes from midnight
 * @returns {string}
 */
export function minutesToTimeString(m) {
  const hh = String(Math.floor(m / 60) % 24).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return hh + ':' + mm + ':00';
}

/**
 * Pick the first valid flight number for an airline from the canonical set.
 * (_flightNums is collected during root scan from audio clips + ALL .acl files.)
 * @param {object} airportValues - airportValues[currentAirport]
 * @param {string} airlineCode - 3-letter ICAO airline code
 * @returns {string} flight number
 */
export function pickFirstFlightNumber(airportValues, airlineCode) {
  const canonNums = (airportValues || {})._flightNums || {};
  const nums = canonNums[airlineCode];
  if (nums && nums.length > 0) return nums[0];
  return '1'; // fallback
}

/**
 * Choose the best default airline code.
 * Prefers first entry from audio callsigns, then first AirlineName from airport values.
 * @param {object} audioData - state.audioCallsigns
 * @param {object} values - airportValues[currentAirport]
 * @returns {string} 3-letter airline code
 */
export function pickDefaultAirlineCode(audioData, values) {
  if (audioData.allAirlines && audioData.allAirlines.length > 0) {
    return audioData.allAirlines[0];
  }
  if (values.AirlineName && values.AirlineName.length > 0) {
    return getAirlineCode(values.AirlineName[0]);
  }
  return 'NEW';
}

/**
 * Create a blank flight with all 15 fields initialized to empty strings,
 * so getActiveColumns can detect column presence.
 * @returns {object}
 */
export function makeEmptyFlight() {
  return {
    CallSign: '', DepartureAirport: '', ArrivalAirport: '',
    Stand: '', Runway: '',
    OffBlockTime: '', TakeoffTime: '', LandingTime: '', InBlockTime: '',
    AirlineName: '', AircraftType: '', Airway: '',
    Registration: '', Voice: '', Language: '',
  };
}

/**
 * Pick the first value from an array, or empty string if unavailable.
 * @param {Array|undefined} arr
 * @returns {string}
 */
function firstOrEmpty(arr) {
  return (arr && arr[0]) || '';
}

/**
 * Build a fully-populated default flight object (arrival or departure).
 * @param {'arrival'|'departure'} type
 * @param {object} values - airportValues[currentAirport]
 * @param {object} audioData - state.audioCallsigns
 * @param {string} currentAirport - ICAO code
 * @param {object} airportValues - full airportValues for pickFirstFlightNumber
 * @returns {object} new flight object
 */
export function createDefaultFlight(type, values, audioData, currentAirport, airportValuesForNum) {
  const baseMin = computeDefaultBaseMin(null); // will be overridden by caller
  const airlineCode = pickDefaultAirlineCode(audioData, values);
  const flightNum = pickFirstFlightNumber(airportValuesForNum, airlineCode);

  const flight = {
    ...makeEmptyFlight(),
    CallSign: airlineCode + flightNum,
    Language: 'en',
    AircraftType: firstOrEmpty(values.AircraftType),
    AirlineName: firstOrEmpty(values.AirlineName),
    Stand: firstOrEmpty(values.Stand),
    Runway: firstOrEmpty(values.Runway),
    Airway: firstOrEmpty(values.Airway),
    Registration: firstOrEmpty(values.Registration),
    Voice: firstOrEmpty(values.Voice),
  };

  if (type === 'arrival') {
    flight.ArrivalAirport = currentAirport || '';
    // times set by caller with baseMin
  } else {
    flight.DepartureAirport = currentAirport || '';
  }

  return flight;
}

/**
 * Build a complete arrival flight with time defaults.
 */
export function createArrivalFlight(configEndTime, values, audioData, currentAirport, airportValuesForNum) {
  const baseMin = computeDefaultBaseMin(configEndTime);
  const flight = createDefaultFlight('arrival', values, audioData, currentAirport, airportValuesForNum);
  flight.LandingTime = minutesToTimeString(baseMin);
  flight.InBlockTime = minutesToTimeString(baseMin + DEFAULT_TAXI_MINUTES);
  return flight;
}

/**
 * Build a complete departure flight with time defaults.
 */
export function createDepartureFlight(configEndTime, values, audioData, currentAirport, airportValuesForNum) {
  const baseMin = computeDefaultBaseMin(configEndTime);
  const flight = createDefaultFlight('departure', values, audioData, currentAirport, airportValuesForNum);
  flight.OffBlockTime = minutesToTimeString(baseMin);
  flight.TakeoffTime = minutesToTimeString(baseMin + DEFAULT_TAXI_MINUTES);
  return flight;
}
