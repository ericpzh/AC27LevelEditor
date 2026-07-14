/**
 * Pure helpers for creating new flight objects with sensible defaults.
 * Extracted from appStore.js to keep the store focused on state management.
 */
import { getAirlineCode, FALLBACK_BASE_MINUTES, DEFAULT_TIME_OFFSET_MIN, DEFAULT_TAXI_MINUTES } from '../utils/constants';

/**
 * Pick a random element from an array.
 * @param {Array|undefined} arr
 * @returns {*} random element, or null if array is empty/undefined
 */
export function randomPick(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

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
 * Pick a random valid flight number for an airline from the canonical set.
 * @param {object} airportValues - airportValues[currentAirport]
 * @param {string} airlineCode - 3-letter ICAO airline code
 * @returns {string} flight number
 */
export function pickRandomFlightNumber(airportValues, airlineCode) {
  const canonNums = (airportValues || {})._flightNums || {};
  const nums = canonNums[airlineCode];
  if (nums && nums.length > 0) return randomPick(nums);
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
 * Pick a random airline code from available sources.
 * Priority: audio callsigns → AirlineCode dropdown values → AirlineName → 'NEW' fallback.
 * @param {object} audioData - state.audioCallsigns
 * @param {object} values - airportValues[currentAirport]
 * @returns {string} 3-letter airline code
 */
export function pickRandomAirlineCode(audioData, values) {
  if (audioData.allAirlines && audioData.allAirlines.length > 0) {
    return randomPick(audioData.allAirlines);
  }
  if (values.AirlineCode && values.AirlineCode.length > 0) {
    return randomPick(values.AirlineCode);
  }
  if (values.AirlineName && values.AirlineName.length > 0) {
    return getAirlineCode(randomPick(values.AirlineName));
  }
  return 'NEW';
}

/**
 * Pick a random stand that is not already used by existing flights.
 * @param {object} values - airportValues[currentAirport]
 * @param {Array} existingFlights - current flights array
 * @returns {string} stand name, or empty string if none available
 */
export function pickRandomUnusedStand(values, existingFlights) {
  const allStands = values.Stand || [];
  if (allStands.length === 0) return '';
  const usedStands = new Set(
    (existingFlights || []).map(f => f.Stand).filter(Boolean)
  );
  const available = allStands.filter(s => !usedStands.has(s));
  if (available.length > 0) return randomPick(available);
  // All stands are taken — reuse a random one
  return randomPick(allStands);
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
 *
 * Uses random selection for airline, flight number, aircraft type,
 * registration, and stand — with proper field cascading so that
 * aircraft type and registration are compatible with the chosen airline.
 *
 * @param {'arrival'|'departure'} type
 * @param {object} values - airportValues[currentAirport]
 * @param {object} audioData - state.audioCallsigns
 * @param {string} currentAirport - ICAO code
 * @param {object} airportValuesForNum - full airportValues for _flightNums / _compat / _registrationMap
 * @param {Array} existingFlights - current flights array (for stand conflict avoidance)
 * @returns {object} new flight object
 */
export function createDefaultFlight(type, values, audioData, currentAirport, airportValuesForNum, existingFlights) {
  const baseMin = computeDefaultBaseMin(null); // will be overridden by caller
  const airlineCode = pickRandomAirlineCode(audioData, values);
  const flightNum = pickRandomFlightNumber(airportValuesForNum, airlineCode);

  // Pick aircraft type valid for this airline (cascade: airline → aircraft)
  const compat = (airportValuesForNum || {})._compat || {};
  const validTypes = compat.airlineToAircraft?.[airlineCode] || values.AircraftType || [];
  const aircraftType = randomPick(validTypes) || firstOrEmpty(values.AircraftType);

  // Pick registration valid for this airline + aircraft combo (cascade: aircraft → reg)
  const regKey = airlineCode + '|' + aircraftType;
  const regMap = (airportValuesForNum || {})._registrationMap || {};
  const validRegs = regMap[regKey] || values.Registration || [];
  const registration = randomPick(validRegs) || firstOrEmpty(values.Registration);

  // Pick random unused stand (avoids conflicts with existing flights)
  const stand = pickRandomUnusedStand(values, existingFlights) || firstOrEmpty(values.Stand);

  const flight = {
    ...makeEmptyFlight(),
    CallSign: airlineCode + flightNum,
    Language: 'en',
    AircraftType: aircraftType,
    AirlineName: firstOrEmpty(values.AirlineName),
    Stand: stand,
    Runway: firstOrEmpty(values.Runway),
    Airway: firstOrEmpty(values.Airway),
    Registration: registration,
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
export function createArrivalFlight(configEndTime, values, audioData, currentAirport, airportValuesForNum, existingFlights) {
  const baseMin = computeDefaultBaseMin(configEndTime);
  const flight = createDefaultFlight('arrival', values, audioData, currentAirport, airportValuesForNum, existingFlights);
  flight.LandingTime = minutesToTimeString(baseMin);
  flight.InBlockTime = minutesToTimeString(baseMin + DEFAULT_TAXI_MINUTES);
  return flight;
}

/**
 * Build a complete departure flight with time defaults.
 */
export function createDepartureFlight(configEndTime, values, audioData, currentAirport, airportValuesForNum, existingFlights) {
  const baseMin = computeDefaultBaseMin(configEndTime);
  const flight = createDefaultFlight('departure', values, audioData, currentAirport, airportValuesForNum, existingFlights);
  flight.OffBlockTime = minutesToTimeString(baseMin);
  flight.TakeoffTime = minutesToTimeString(baseMin + DEFAULT_TAXI_MINUTES);
  return flight;
}
