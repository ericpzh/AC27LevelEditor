/**
 * Pure mapping helpers that turn aviationstack `/v1/flights` records into AC27
 * flight-schedule rows, intersected with the airport's in-game dropdown pools.
 *
 * aviationstack is only the *seed*: every generated field must exist in the
 * level's own value pools (airline code, flight number, aircraft type,
 * registration, runway, STAR, stand, voice, language). Rows that cannot be made
 * valid are returned with `keep:false` and a reason note — never written broken.
 *
 * No network access here; the raw records are fetched by the main process
 * (`aviationstack-fetch` IPC).
 */
import {
  makeEmptyFlight, randomPick, pickVoiceForLanguage, defaultLanguageForAirport,
} from '../../store/flightDefaults.js';

const MINUTES_PER_DAY = 24 * 60;

/** Parse "HH:MM(:SS)" into minutes-from-midnight. */
function timeToMinutes(t) {
  const p = String(t || '').split(':');
  if (p.length < 2) return null;
  const h = parseInt(p[0], 10);
  const m = parseInt(p[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToTime(m) {
  const mm = ((m % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hh = String(Math.floor(mm / 60)).padStart(2, '0');
  const mi = String(mm % 60).padStart(2, '0');
  return `${hh}:${mi}:00`;
}

/**
 * Convert an aviationstack scheduled timestamp to the airport-local wall clock
 * "HH:MM".
 *
 * aviationstack returns the LOCAL time at the airport but tags the string with a
 * nominal `+00:00` (verified: ETD1 AUH→JFK reads 02:35→08:35, which is only a
 * sane 14h block if both clock values are local). So we read the clock time as
 * authored and do NOT timezone-convert it — converting would shift every time by
 * the airport's UTC offset a second time.
 */
export function isoToLocalHHMM(iso, timezone) { // eslint-disable-line no-unused-vars
  if (!iso) return null;
  const m = String(iso).match(/[T ](\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Check whether a wall-clock "HH:MM" falls inside the level's
 * [startMin, endMin] window. Windows may cross midnight (start > end).
 * Returns the "HH:MM:00" string, or null when it does not fit.
 * When no window is given the raw time is used.
 */
export function fitTimeToWindow(hhmm, startMin, endMin) {
  const base = timeToMinutes(hhmm);
  if (base === null) return null;
  if (startMin === null || endMin === null) return minutesToTime(base);
  const inWindow = (startMin <= endMin)
    ? (base >= startMin && base <= endMin)
    : (base >= startMin || base <= endMin);
  return inWindow ? minutesToTime(base) : null;
}

/**
 * Resolve the game airline code (3-letter ICAO). aviationstack may put the code
 * in `airline.icao`, or only inside `flight.icao` ("CCA8843"); `airline.iata`
 * / `flight.iata` are 2-letter IATA and cannot be matched against the game's
 * ICAO pools directly.
 */
function extractAirlineCode(raw) {
  const icao = String(raw?.airline?.icao || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(icao)) return icao;
  const flightIcao = String(raw?.flight?.icao || '').trim().toUpperCase();
  const m = flightIcao.match(/^([A-Z]{3})\d/);
  if (m) return m[1];
  const iata = String(raw?.airline?.iata || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(iata)) return iata;
  return '';
}

/**
 * Extract the numeric flight number. aviationstack mixes formats across
 * `flight.number` (digits), `flight.icao` ("CCA8843") and `flight.iata`
 * ("CA8843") — strip any airline prefix so the game gets the number only.
 */
function extractFlightNumber(raw, airlineCode) {
  const stripPrefix = (v) => {
    let s = String(v == null ? '' : v).trim().toUpperCase();
    if (!s) return '';
    if (airlineCode && s.startsWith(airlineCode)) return s.slice(airlineCode.length);
    return s.replace(/^[A-Z]{2,3}/, '');
  };
  for (const v of [raw?.flight?.number, raw?.flight?.icao, raw?.flight?.iata]) {
    const n = stripPrefix(v);
    if (n) return n;
  }
  return '';
}

function firstScheduled(leg) {
  if (!leg) return null;
  return leg.scheduled || leg.estimated || leg.actual || leg.estimated_runway || leg.actual_runway || null;
}

/** Extract a usable local scheduled time from an aviationstack record. */
export function legScheduledHHMM(leg) {
  if (!leg) return null;
  return isoToLocalHHMM(firstScheduled(leg), leg.timezone);
}

/**
 * Map one aviationstack record into a 15-field flight object.
 * @param {object} raw
 * @param {object} ctx - { airportIcao, vals, usedCallsigns:Set, usedStands:Set }
 * @returns {{ flight: object|null, keep: boolean, notes: Array<{key:string,params?:object}> }}
 */
export function mapAviationstackFlight(raw, ctx) {
  const notes = [];
  const vals = ctx.vals || {};
  const icao = String(ctx.airportIcao || '').toUpperCase();
  const depIcao = String(raw?.departure?.icao || '').toUpperCase();
  const arrIcao = String(raw?.arrival?.icao || '').toUpperCase();

  let isDeparture;
  if (arrIcao && arrIcao === icao) isDeparture = false;
  else if (depIcao && depIcao === icao) isDeparture = true;
  else return { flight: null, keep: false, notes: [{ key: 'realtime_note_not_this_airport' }] };

  // ── Airline code ──────────────────────────────────────────
  const airlineCode = extractAirlineCode(raw);
  const knownCodes = new Set([
    ...(Array.isArray(vals.AirlineCode) ? vals.AirlineCode : []),
    ...Object.keys(vals._compat?.airlineToAircraft || {}),
  ]);
  if (!airlineCode) {
    return { flight: null, keep: false, notes: [{ key: 'realtime_note_airline_unknown', params: { code: '?' } }] };
  }
  if (knownCodes.size > 0 && !knownCodes.has(airlineCode)) {
    return { flight: null, keep: false, notes: [{ key: 'realtime_note_airline_unknown', params: { code: airlineCode } }] };
  }

  // ── Flight number / CallSign ──────────────────────────────
  let number = extractFlightNumber(raw, airlineCode);
  const canonNums = (vals._flightNums || {})[airlineCode];
  const firstUnused = (nums) => (nums || []).find(n => !ctx.usedCallsigns.has(airlineCode + n));
  if (canonNums && canonNums.length > 0 && (!number || !canonNums.includes(number))) {
    const sub = firstUnused(canonNums) || canonNums[0];
    if (sub) {
      number = sub;
      notes.push({ key: 'realtime_note_flightnum_substituted' });
    }
  }
  if (!number) {
    number = (canonNums && canonNums[0]) || '1';
    notes.push({ key: 'realtime_note_flightnum_substituted' });
  }
  const callSign = airlineCode + number;
  // Duplicates are dropped (first VALID record wins), never re-numbered to keep.
  if (ctx.usedCallsigns.has(callSign)) {
    return { flight: null, keep: false, notes: [{ key: 'realtime_note_duplicate_callsign', params: { cs: callSign } }] };
  }

  // ── Aircraft type ─────────────────────────────────────────
  const designator = String(raw?.aircraft?.icao || raw?.aircraft?.iata || '').trim().toUpperCase();
  const typePool = Array.isArray(vals.AircraftType) ? vals.AircraftType : [];
  let aircraftType = '';
  if (designator) {
    aircraftType = vals._designatorToType?.[designator] || '';
    if (!aircraftType) {
      aircraftType = typePool.find(t => t.replace(/[^A-Z0-9]/g, '').endsWith(designator)) || '';
    }
  }
  if (!aircraftType) {
    const compat = (vals._compat?.airlineToAircraft || {})[airlineCode];
    aircraftType = (compat && compat.find(t => typePool.includes(t))) || randomPick(typePool) || '';
    notes.push({ key: 'realtime_note_type_defaulted' });
  }

  // ── Registration ──────────────────────────────────────────
  const regMap = vals._registrationMap || {};
  const pairKey = airlineCode + '|' + aircraftType;
  const validRegs = regMap[pairKey] || (Array.isArray(vals.Registration) ? vals.Registration : []);
  let registration = String(raw?.aircraft?.registration || '').trim().toUpperCase();
  if (!registration || (validRegs.length > 0 && !validRegs.includes(registration))) {
    registration = randomPick(validRegs.filter(r => !ctx.usedRegs.has(r))) || randomPick(validRegs) || '';
    if (registration) notes.push({ key: 'realtime_note_reg_defaulted' });
  }

  // ── Runway + STAR ─────────────────────────────────────────
  const runways = Array.isArray(vals.Runway) ? vals.Runway : [];
  const runwayStarMap = vals._runwayStarMap || {};
  let runway = '';
  if (isDeparture) {
    runway = randomPick(runways) || '';
  } else {
    const withStar = runways.filter(r => (runwayStarMap[r] || []).length > 0);
    runway = randomPick(withStar) || randomPick(runways) || '';
  }
  let airway = '';
  if (!isDeparture && runway) {
    airway = randomPick(runwayStarMap[runway] || []) || '';
  }

  // ── Stand ─────────────────────────────────────────────────
  const stands = Array.isArray(vals.Stand) ? vals.Stand : [];
  let stand = randomPick(stands.filter(s => !ctx.usedStands.has(s))) || randomPick(stands) || '';

  // ── Times ─────────────────────────────────────────────────
  // Keep the flight even if the real local time falls outside the level window;
  // the batch builder retimes out-of-window flights into the window afterwards.
  const leg = isDeparture ? raw.departure : raw.arrival;
  const hhmm = legScheduledHHMM(leg);
  const schedMin = timeToMinutes(hhmm);
  if (schedMin === null) {
    return { flight: null, keep: false, notes: [{ key: 'realtime_note_time_out_of_range' }], schedMin: null };
  }
  const startMin = ctx.configStartTime ? timeToMinutes(ctx.configStartTime) : null;
  const endMin = ctx.configEndTime ? timeToMinutes(ctx.configEndTime) : null;
  const fitted = fitTimeToWindow(hhmm, startMin, endMin);
  const timeStr = fitted || minutesToTime(schedMin);

  // ── Language / Voice ──────────────────────────────────────
  const language = defaultLanguageForAirport(icao);
  const voice = pickVoiceForLanguage(vals, language);

  const flight = {
    ...makeEmptyFlight(),
    CallSign: callSign,
    AirlineName: airlineCode,
    AircraftType: aircraftType,
    Registration: registration,
    Stand: stand,
    Runway: runway,
    Airway: airway,
    Language: language,
    Voice: voice,
    isDeparture,
  };
  if (isDeparture) {
    flight.DepartureAirport = '';
    flight.ArrivalAirport = arrIcao || '';
    flight.OffBlockTime = timeStr;
  } else {
    flight.ArrivalAirport = '';
    flight.DepartureAirport = depIcao || '';
    flight.LandingTime = timeStr;
  }

  return { flight, keep: true, notes, schedMin };
}

/** Is minute-of-day `m` inside [startMin, endMin] (window may cross midnight)? */
function inWindow(m, startMin, endMin) {
  return startMin <= endMin ? (m >= startMin && m <= endMin) : (m >= startMin || m <= endMin);
}

/**
 * Retime a direction's flights into [startMin, endMin] when any of them is out of
 * window, preserving chronological order and relative spacing. Returns true if
 * anything was retimed.
 */
function retimeIntoWindow(entries, startMin, endMin) {
  const list = entries.filter(e => e.schedMin !== null).sort((a, b) => a.schedMin - b.schedMin);
  if (list.length === 0) return false;
  if (list.every(e => inWindow(e.schedMin, startMin, endMin))) return false;

  const span = endMin >= startMin ? (endMin - startMin) : (endMin + MINUTES_PER_DAY - startMin);
  const rawMin = list[0].schedMin;
  const rawSpan = list[list.length - 1].schedMin - rawMin;
  list.forEach((e, i) => {
    const offset = rawSpan > 0
      ? Math.round((e.schedMin - rawMin) / rawSpan * span)
      : (list.length > 1 ? Math.round(i * span / (list.length - 1)) : 0);
    const t = ((startMin + offset) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const str = minutesToTime(t);
    if (e.flight.isDeparture) e.flight.OffBlockTime = str; else e.flight.LandingTime = str;
  });
  return true;
}

/**
 * Map a batch of aviationstack records. Dedupes callsigns/stands/regs WITHIN
 * the batch only — the importer replaces the whole schedule, so flights that
 * already exist in the level must not count as collisions (otherwise busy
 * airports whose schedule mirrors real traffic reject every fetched flight).
 * @param {object[]} rawFlights
 * @param {{ airportIcao, vals, configStartTime, configEndTime }} ctx
 * @returns {{ candidates: Array<{flight,keep,notes,raw}>, summary:{total,matched,skipped,reasons}} }
 */
export function buildFlightsFromAviationstack(rawFlights, ctx = {}) {
  const icao = String(ctx.airportIcao || '').toUpperCase();
  const usedCallsigns = new Set();
  const usedStands = new Set();
  const usedRegs = new Set();
  const keptPhysical = new Set();   // only KEPT flights claim a physical key

  const candidates = [];
  const keptEntries = [];   // { flight, schedMin } for retiming
  const reasons = {};
  let matched = 0;
  for (const raw of (rawFlights || [])) {
    // Physical-flight key (direction + route + scheduled time). Claimed only by
    // a kept record, so an invalid earlier duplicate does not block a valid one.
    const depIcao = String(raw?.departure?.icao || '').toUpperCase();
    const arrIcao = String(raw?.arrival?.icao || '').toUpperCase();
    const isArr = !!arrIcao && arrIcao === icao;
    const isDep = !!depIcao && depIcao === icao;
    let physKey = '';
    if (isArr || isDep) {
      const leg = isArr ? raw.arrival : raw.departure;
      const sched = leg ? (leg.scheduled || leg.estimated || leg.actual || '') : '';
      const id = sched || raw?.flight?.icao || raw?.flight?.number || '';
      physKey = `${isDep ? 'D' : 'A'}|${depIcao}|${arrIcao}|${id}`;
      if (keptPhysical.has(physKey)) {
        reasons['realtime_note_duplicate_flight'] = (reasons['realtime_note_duplicate_flight'] || 0) + 1;
        candidates.push({ flight: null, keep: false, notes: [{ key: 'realtime_note_duplicate_flight' }], raw });
        continue;
      }
    }

    const res = mapAviationstackFlight(raw, {
      airportIcao: ctx.airportIcao,
      vals: ctx.vals,
      configStartTime: ctx.configStartTime,
      configEndTime: ctx.configEndTime,
      usedCallsigns,
      usedStands,
      usedRegs,
    });
    if (res.keep && res.flight) {
      matched++;
      usedCallsigns.add(res.flight.CallSign);
      if (res.flight.Stand) usedStands.add(res.flight.Stand);
      if (res.flight.Registration) usedRegs.add(res.flight.Registration);
      if (physKey) keptPhysical.add(physKey);
      keptEntries.push({ flight: res.flight, schedMin: res.schedMin });
    } else {
      const k = res.notes[0]?.key || 'unknown';
      reasons[k] = (reasons[k] || 0) + 1;
    }
    candidates.push({ ...res, raw });
  }

  // Retime out-of-window flights into the level window (per direction), so a
  // short scenario window still imports instead of dropping every real flight.
  let retimed = false;
  const startMin = ctx.configStartTime ? timeToMinutes(ctx.configStartTime) : null;
  const endMin = ctx.configEndTime ? timeToMinutes(ctx.configEndTime) : null;
  if (startMin !== null && endMin !== null) {
    for (const isDeparture of [false, true]) {
      const group = keptEntries.filter(e => e.flight.isDeparture === isDeparture);
      if (retimeIntoWindow(group, startMin, endMin)) retimed = true;
    }
  }

  const total = (rawFlights || []).length;
  return {
    candidates,
    summary: { total, matched, skipped: total - matched, reasons, retimed },
  };
}
