/**
 * HTTP API Server for AC27 Level Editor
 *
 * Provides a REST API on 127.0.0.1:{port} that allows external tools (like
 * an MCP server) to read/write the editor's zustand store. The server
 * communicates with the renderer via IPC (store-api-update) and
 * webContents.executeJavaScript.
 *
 * Zero npm dependencies — uses only Node.js built-in `http` module.
 *
 * Validation uses data from the airport cache (passed from main.js) and
 * mirrors the editor's validation logic in src/utils/validators.js.
 */

const http = require('http');
const {
  FIELDS, getAirlineCode, AIRLINE_CODE_MAP,
  FALLBACK_BASE_MINUTES, DEFAULT_TAXI_MINUTES, DEFAULT_TIME_OFFSET_MIN,
} = require('../src/acl/constants');

// ── Module state ────────────────────────────────────────────────
let mainWindow = null;
let server = null;
let getAirportCache = null; // () => airportCache from main.js

// SSE MCP clients: clientId → ServerResponse
let sseClients = new Map();
let nextSseClientId = 1;

// ── Store I/O ───────────────────────────────────────────────────

async function readStoreState() {
  return mainWindow.webContents.executeJavaScript(
    'JSON.parse(JSON.stringify(window.__AC27_STORE.getState()))'
  );
}

function pushStoreUpdate(updates) {
  // Convert Sets to arrays before sending via IPC
  const safe = { ...updates };
  if (safe.selectedIndices instanceof Set) safe.selectedIndices = [...safe.selectedIndices];
  if (safe.searchMatches instanceof Set) safe.searchMatches = [...safe.searchMatches];
  if (safe.highlightedCells instanceof Set) safe.highlightedCells = [...safe.highlightedCells];
  mainWindow.webContents.send('store-api-update', safe);
}

// ── Helpers ─────────────────────────────────────────────────────

const FIELD_NAMES = FIELDS.map(f => f[0]);

/** Parse HH:MM or HH:MM:SS into total seconds */
function parseTimeSeconds(t) {
  if (!t || typeof t !== 'string') return NaN;
  const parts = t.split(':');
  if (parts.length === 2) parts.push('00');
  if (parts.length !== 3) return NaN;
  return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
}

/** Resolve a full airline name from a 3-letter code (reverse AIRLINE_CODE_MAP) */
function resolveAirlineName(code) {
  for (const [name, c] of Object.entries(AIRLINE_CODE_MAP)) {
    if (c === code && !/[一-鿿]/.test(name)) return name; // prefer English name
  }
  return code;
}

/** Determine if a flight is an arrival (has LandingTime) or departure (has OffBlockTime) */
function isArrival(flight) {
  return !!(flight.LandingTime && flight.LandingTime.trim());
}

/** Get the primary time field for a flight */
function primaryTime(flight) {
  return isArrival(flight) ? flight.LandingTime : flight.OffBlockTime;
}

// ── Constraint Map Builder ──────────────────────────────────────

function buildConstraints(state, cache) {
  const icao = state.currentAirport;
  const entry = cache && icao ? cache[icao] : null;
  const dv = entry?.dropdownValues || {};
  const ad = entry?.approachData || {};
  const ac = entry?.audioCallsigns || { byAirline: {}, allCallsigns: [], allAirlines: [] };

  // Known airline codes: from audio callsigns + dropdown values
  const knownCodes = new Set([
    ...Object.keys(ac.byAirline || {}),
    ...(dv.AirlineCode || []),
  ]);

  return {
    knownCodes,
    flightNumbers: dv._flightNums || {},
    stands: dv.Stand || [],
    runways: dv.Runway || [],
    aircraftTypes: dv.AircraftType || [],
    voices: dv.Voice || [],
    languages: dv.Language || [],
    airlineNames: dv.AirlineName || [],
    airlineAircraftCompat: (dv._compat && dv._compat.airlineToAircraft) || {},
    runwayStarCompat: ad.runwayStarMap || {},
    registrationsByPair: dv._registrationMap || {},
    configStartTime: state._configStartTime,
    configEndTime: state._configEndTime,
    currentAirport: state.currentAirport,
  };
}

// ── Validation ──────────────────────────────────────────────────

/**
 * Build a structured error response from validation failures.
 * Returns null if all checks pass.
 */
function validateFlightObjects(newFlights, existingFlights, constraints) {
  const details = [];
  const allFlights = [...existingFlights, ...newFlights];

  for (let i = 0; i < newFlights.length; i++) {
    const f = newFlights[i];
    const idx = existingFlights.length + i;

    // 1. All 15 fields present
    for (const name of FIELD_NAMES) {
      if (!(name in f)) {
        details.push({ index: idx, field: name, value: undefined, issue: 'missing_field' });
      }
    }
    if (details.some(d => d.index === idx && d.issue === 'missing_field')) continue; // skip further checks

    const airlineCode = (f.CallSign || '').substring(0, 3).toUpperCase();

    // 2. Airline code known
    if (airlineCode && constraints.knownCodes.size > 0 && !constraints.knownCodes.has(airlineCode)) {
      details.push({
        index: idx, field: 'CallSign', value: f.CallSign,
        issue: 'unknown_airline_code',
        message: `Unknown airline code '${airlineCode}' in callsign '${f.CallSign}'.`,
        valid: [...constraints.knownCodes].slice(0, 20),
      });
    }

    // 3. Flight number valid
    const canonNums = constraints.flightNumbers[airlineCode];
    if (canonNums && canonNums.length > 0) {
      const flightNum = (f.CallSign || '').substring(3);
      if (flightNum && !canonNums.includes(flightNum)) {
        details.push({
          index: idx, field: 'CallSign', value: f.CallSign,
          issue: 'invalid_flight_number',
          message: `Flight number '${flightNum}' is not valid for airline ${airlineCode}.`,
          valid: canonNums.slice(0, 20),
        });
      }
    }

    // 4. Stand exists
    if (f.Stand && constraints.stands.length > 0 && !constraints.stands.includes(f.Stand)) {
      details.push({
        index: idx, field: 'Stand', value: f.Stand,
        issue: 'invalid_stand',
        message: `Stand '${f.Stand}' is not valid.`,
        valid: constraints.stands.slice(0, 30),
      });
    }

    // 5. Runway exists
    if (f.Runway && constraints.runways.length > 0 && !constraints.runways.includes(f.Runway)) {
      details.push({
        index: idx, field: 'Runway', value: f.Runway,
        issue: 'invalid_runway',
        message: `Runway '${f.Runway}' is not valid.`,
        valid: constraints.runways.slice(0, 20),
      });
    }

    // 6. Aircraft type compatible with airline
    const compatAircraft = constraints.airlineAircraftCompat[airlineCode];
    if (f.AircraftType && compatAircraft && compatAircraft.length > 0 && !compatAircraft.includes(f.AircraftType)) {
      details.push({
        index: idx, field: 'AircraftType', value: f.AircraftType,
        issue: 'incompatible_aircraft',
        message: `Aircraft '${f.AircraftType}' is not valid for airline ${airlineCode}.`,
        valid: compatAircraft,
      });
    }

    // 7. Airway compatible with runway (arrivals only)
    if (isArrival(f) && f.Airway && f.Runway) {
      const validStars = constraints.runwayStarCompat[f.Runway];
      if (validStars && validStars.length > 0 && !validStars.includes(f.Airway)) {
        details.push({
          index: idx, field: 'Airway', value: f.Airway,
          issue: 'incompatible_star',
          message: `STAR '${f.Airway}' is not valid for runway ${f.Runway}.`,
          valid: validStars,
        });
      }
    }

    // 8. Registration valid for (airline, aircraft) pair
    if (f.Registration && f.AircraftType && airlineCode) {
      const pairKey = `${airlineCode}|${f.AircraftType}`;
      const validRegs = constraints.registrationsByPair[pairKey];
      if (validRegs && validRegs.length > 0 && !validRegs.includes(f.Registration)) {
        details.push({
          index: idx, field: 'Registration', value: f.Registration,
          issue: 'invalid_registration',
          message: `Registration '${f.Registration}' is not valid for ${pairKey}.`,
          valid: validRegs.slice(0, 20),
        });
      }
    }

    // 9. Time bounds
    const pt = primaryTime(f);
    if (pt) {
      const sec = parseTimeSeconds(pt);
      if (constraints.configStartTime) {
        const startSec = parseTimeSeconds(constraints.configStartTime);
        if (!isNaN(sec) && !isNaN(startSec) && sec < startSec) {
          details.push({
            index: idx, field: isArrival(f) ? 'LandingTime' : 'OffBlockTime', value: pt,
            issue: 'time_before_range',
            message: `${isArrival(f) ? 'LandingTime' : 'OffBlockTime'} ${pt} is before config start ${constraints.configStartTime}.`,
          });
        }
      }
      if (constraints.configEndTime) {
        const endSec = parseTimeSeconds(constraints.configEndTime);
        if (!isNaN(sec) && !isNaN(endSec) && sec > endSec) {
          details.push({
            index: idx, field: isArrival(f) ? 'LandingTime' : 'OffBlockTime', value: pt,
            issue: 'time_after_range',
            message: `${isArrival(f) ? 'LandingTime' : 'OffBlockTime'} ${pt} is after config end ${constraints.configEndTime}.`,
          });
        }
      }
    }

    // 10. Time order
    if (isArrival(f)) {
      const landSec = parseTimeSeconds(f.LandingTime);
      const inSec = parseTimeSeconds(f.InBlockTime);
      if (!isNaN(landSec) && !isNaN(inSec) && landSec >= inSec) {
        details.push({
          index: idx, field: 'LandingTime', value: f.LandingTime,
          issue: 'time_order',
          message: `LandingTime (${f.LandingTime}) must be before InBlockTime (${f.InBlockTime}).`,
        });
      }
    } else {
      const offSec = parseTimeSeconds(f.OffBlockTime);
      const takeSec = parseTimeSeconds(f.TakeoffTime);
      if (!isNaN(offSec) && !isNaN(takeSec) && offSec >= takeSec) {
        details.push({
          index: idx, field: 'OffBlockTime', value: f.OffBlockTime,
          issue: 'time_order',
          message: `OffBlockTime (${f.OffBlockTime}) must be before TakeoffTime (${f.TakeoffTime}).`,
        });
      }
    }
  }

  // 11. Duplicate callsigns in resulting array
  const callsignCounts = {};
  for (const f of allFlights) {
    const cs = (f.CallSign || '').trim();
    if (cs) callsignCounts[cs] = (callsignCounts[cs] || 0) + 1;
  }
  for (const [cs, count] of Object.entries(callsignCounts)) {
    if (count > 1) {
      details.push({
        index: -1, field: 'CallSign', value: cs,
        issue: 'duplicate_callsign',
        message: `Callsign ${cs} would appear ${count} times after this operation.`,
      });
    }
  }

  // 12a. Stand conflicts
  // Two departures on same stand = always conflict
  // Departure + arrival on same stand = conflict when OffBlockTime >= LandingTime
  const standFlights = {}; // stand → [{idx, isArr, offBlockSec, landingSec, callsign}]
  for (let i = 0; i < allFlights.length; i++) {
    const f = allFlights[i];
    const stand = (f.Stand || '').trim();
    if (!stand) continue;
    if (!standFlights[stand]) standFlights[stand] = [];
    standFlights[stand].push({
      index: i,
      isArr: isArrival(f),
      offBlockSec: parseTimeSeconds(f.OffBlockTime),
      landingSec: parseTimeSeconds(f.LandingTime),
      callsign: f.CallSign,
    });
  }
  for (const [stand, flights] of Object.entries(standFlights)) {
    for (let a = 0; a < flights.length; a++) {
      for (let b = a + 1; b < flights.length; b++) {
        const fa = flights[a], fb = flights[b];
        const hasConflict = (!fa.isArr && !fb.isArr) || // both departures
          (fa.isArr && !fb.isArr && !isNaN(fb.offBlockSec) && !isNaN(fa.landingSec) && fb.offBlockSec >= fa.landingSec) ||
          (!fa.isArr && fb.isArr && !isNaN(fa.offBlockSec) && !isNaN(fb.landingSec) && fa.offBlockSec >= fb.landingSec);
        if (hasConflict) {
          details.push({
            index: -1, field: 'Stand', value: stand,
            issue: 'stand_conflict',
            message: `Stand ${stand} conflict: ${fa.callsign} vs ${fb.callsign}.`,
          });
        }
      }
    }
  }

  // 12b. Duplicate registrations (2+ departures or 2+ arrivals with same reg)
  const depRegs = {}, arrRegs = {};
  for (const f of allFlights) {
    const reg = (f.Registration || '').trim();
    if (!reg) continue;
    if (isArrival(f)) {
      arrRegs[reg] = (arrRegs[reg] || 0) + 1;
    } else {
      depRegs[reg] = (depRegs[reg] || 0) + 1;
    }
  }
  for (const [reg, count] of Object.entries(depRegs)) {
    if (count > 1) {
      const callsigns = allFlights.filter(f => !isArrival(f) && f.Registration === reg).map(f => f.CallSign);
      details.push({
        index: -1, field: 'Registration', value: reg,
        issue: 'duplicate_registration',
        message: `Registration ${reg} on ${count} departures: ${callsigns.join(', ')}.`,
      });
    }
  }
  for (const [reg, count] of Object.entries(arrRegs)) {
    if (count > 1) {
      const callsigns = allFlights.filter(f => isArrival(f) && f.Registration === reg).map(f => f.CallSign);
      details.push({
        index: -1, field: 'Registration', value: reg,
        issue: 'duplicate_registration',
        message: `Registration ${reg} on ${count} arrivals: ${callsigns.join(', ')}.`,
      });
    }
  }

  return details.length > 0 ? details : null;
}

// ── Cascade Logic ───────────────────────────────────────────────

/**
 * Apply cascade logic when updating flights (mirrors updateFlight in appStore.js:276-348).
 * - AirlineCode change → rebuild CallSign, cascade AircraftType, cascade Registration
 * - FlightNum change → rebuild CallSign
 * - Runway change → cascade Airway from _runwayStarMap
 */
function applyCascades(flight, updates, constraints) {
  const result = { ...flight, ...updates };

  const oldCode = (flight.CallSign || '').substring(0, 3);
  let newCode = oldCode;
  let newNum = (flight.CallSign || '').substring(3);

  if ('AirlineCode' in updates && updates.AirlineCode) {
    newCode = updates.AirlineCode.toUpperCase();
    // Cascade AircraftType to first valid for new airline
    const compat = constraints.airlineAircraftCompat[newCode];
    if (compat && compat.length > 0 && !compat.includes(result.AircraftType)) {
      result.AircraftType = compat[0];
    }
    // Cascade Registration to first valid for (airline, aircraft)
    const pairKey = `${newCode}|${result.AircraftType}`;
    const validRegs = constraints.registrationsByPair[pairKey];
    if (validRegs && validRegs.length > 0 && !validRegs.includes(result.Registration)) {
      result.Registration = validRegs[0];
    }
  }

  if ('FlightNum' in updates && updates.FlightNum != null) {
    newNum = String(updates.FlightNum);
  }

  if ('AirlineCode' in updates || 'FlightNum' in updates) {
    result.CallSign = newCode + newNum;
  }

  if ('Runway' in updates && updates.Runway) {
    const validStars = constraints.runwayStarCompat[updates.Runway];
    if (validStars && validStars.length > 0 && !validStars.includes(result.Airway)) {
      result.Airway = validStars[0];
    }
  }

  return result;
}

// ── MCP Tool Definitions ────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: 'create_flights',
    description: 'Insert one or more complete flight rows into the currently-open level. Every flight must have all 15 fields populated. The server validates all constraints and rejects invalid data. Use get_airport_info first to get valid values for each field.',
    inputSchema: {
      type: 'object',
      properties: {
        flights: {
          type: 'array', minItems: 1, maxItems: 500,
          items: {
            type: 'object',
            properties: {
              CallSign: { type: 'string' }, DepartureAirport: { type: 'string' }, ArrivalAirport: { type: 'string' },
              Stand: { type: 'string' }, Runway: { type: 'string' },
              OffBlockTime: { type: 'string' }, TakeoffTime: { type: 'string' },
              LandingTime: { type: 'string' }, InBlockTime: { type: 'string' },
              AirlineName: { type: 'string' }, AircraftType: { type: 'string' }, Airway: { type: 'string' },
              Registration: { type: 'string' }, Voice: { type: 'string' }, Language: { type: 'string' },
            },
            required: FIELD_NAMES,
          },
        },
      },
      required: ['flights'],
    },
  },
  {
    name: 'get_flights',
    description: 'Read flights from the currently-open level, with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['arrival', 'departure'] },
        airline: { type: 'string' }, callsign: { type: 'string' },
        stand: { type: 'string' }, runway: { type: 'string' }, aircraftType: { type: 'string' },
        timeAfter: { type: 'string' }, timeBefore: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
    },
  },
  {
    name: 'modify_flights',
    description: 'Update fields on matching flights. Cascade: AirlineCode change rebuilds CallSign + resets AircraftType/Registration. Runway change resets Airway to first valid STAR.',
    inputSchema: {
      type: 'object',
      properties: {
        match: {
          type: 'object',
          properties: {
            callsigns: { type: 'array', items: { type: 'string' } },
            callsign: { type: 'string' }, airline: { type: 'string' },
            type: { type: 'string', enum: ['arrival', 'departure'] },
            stand: { type: 'string' }, runway: { type: 'string' }, aircraftType: { type: 'string' },
          },
        },
        updates: {
          type: 'object',
          properties: {
            AirlineCode: { type: 'string' }, FlightNum: { type: 'string' },
            Stand: { type: 'string' }, Runway: { type: 'string' },
            OffBlockTime: { type: 'string' }, TakeoffTime: { type: 'string' },
            LandingTime: { type: 'string' }, InBlockTime: { type: 'string' },
            AirlineName: { type: 'string' }, AircraftType: { type: 'string' }, Airway: { type: 'string' },
            Registration: { type: 'string' }, Voice: { type: 'string' }, Language: { type: 'string' },
            DepartureAirport: { type: 'string' }, ArrivalAirport: { type: 'string' },
          },
        },
      },
      required: ['match', 'updates'],
    },
  },
  {
    name: 'delete_flights',
    description: 'Delete flights matching the given criteria.',
    inputSchema: {
      type: 'object',
      properties: {
        match: {
          type: 'object',
          properties: {
            callsigns: { type: 'array', items: { type: 'string' } }, callsign: { type: 'string' },
            airline: { type: 'string' }, type: { type: 'string', enum: ['arrival', 'departure'] },
            stand: { type: 'string' }, runway: { type: 'string' }, aircraftType: { type: 'string' },
          },
        },
      },
      required: ['match'],
    },
  },
  { name: 'get_editor_status', description: 'Get the current editor state: which level is open, flight counts, dirty flag, timeline status.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_airport_info', description: 'Get the full constraint map for the current airport. MUST call this before creating or modifying flights.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_validation_issues', description: 'Run the full validation suite on the current flight list.', inputSchema: { type: 'object', properties: {} } },
];

// ── MCP Message Handler ─────────────────────────────────────────

/**
 * Process a JSON-RPC 2.0 MCP message. Calls internal API functions directly
 * (no HTTP round-trip needed — same process as the HTTP server).
 */
async function handleMcpMessage(msg) {
  const id = msg.id;
  const respond = (result) => ({ jsonrpc: '2.0', id, result });
  const errResp = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (msg.method === 'initialize') {
      return respond({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ac27-editor-mcp', version: '1.0.0' },
      });
    }

    if (msg.method === 'tools/list') {
      return respond({ tools: MCP_TOOLS });
    }

    if (msg.method === 'tools/call') {
      const toolName = msg.params?.name;
      const args = msg.params?.arguments || {};
      let result;

      switch (toolName) {
        case 'create_flights': {
          const state = await readStoreState();
          if (state.screen !== 'editor' || !state.currentPath) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No level is open.' }) }], isError: true });
          }
          const cache = getAirportCache ? getAirportCache() : null;
          const constraints = buildConstraints(state, cache);
          const issues = validateFlightObjects(args.flights, state.flights || [], constraints);
          if (issues) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: { code: 'VALIDATION_FAILED', message: issues.length + ' validation issue(s).', details: issues } }) }], isError: true });
          }
          const newFlights = [...(state.flights || []), ...args.flights];
          pushStoreUpdate({ flights: newFlights, modified: true });
          result = { success: true, created: args.flights.length };
          break;
        }

        case 'get_flights': {
          const state = await readStoreState();
          let flights = [...(state.flights || [])];
          if (args.type === 'arrival') flights = flights.filter(f => !!(f.LandingTime && f.LandingTime.trim()));
          if (args.type === 'departure') flights = flights.filter(f => !!(f.OffBlockTime && f.OffBlockTime.trim()));
          if (args.airline) flights = flights.filter(f => (f.CallSign || '').substring(0, 3).toUpperCase() === args.airline.toUpperCase());
          if (args.callsign) flights = flights.filter(f => f.CallSign === args.callsign);
          if (args.stand) flights = flights.filter(f => f.Stand === args.stand);
          if (args.runway) flights = flights.filter(f => f.Runway === args.runway);
          if (args.aircraftType) flights = flights.filter(f => f.AircraftType === args.aircraftType);
          if (args.timeAfter) { const s = parseTimeSeconds(args.timeAfter); if (!isNaN(s)) flights = flights.filter(f => { const ps = parseTimeSeconds(primaryTime(f)); return !isNaN(ps) && ps >= s; }); }
          if (args.timeBefore) { const s = parseTimeSeconds(args.timeBefore); if (!isNaN(s)) flights = flights.filter(f => { const ps = parseTimeSeconds(primaryTime(f)); return !isNaN(ps) && ps <= s; }); }
          const total = flights.length;
          flights = flights.slice(args.offset || 0, (args.offset || 0) + (args.limit || 100));
          result = { success: true, flights, total };
          break;
        }

        case 'modify_flights': {
          const state = await readStoreState();
          if (state.screen !== 'editor' || !state.currentPath) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No level is open.' }) }], isError: true });
          }
          const cache = getAirportCache ? getAirportCache() : null;
          const constraints = buildConstraints(state, cache);
          const matchCallsigns = new Set();
          if (args.match.callsigns) args.match.callsigns.forEach(cs => matchCallsigns.add(cs));
          if (args.match.callsign) matchCallsigns.add(args.match.callsign);
          let flights = [...(state.flights || [])];
          let matched = 0, modified = 0;
          for (let i = 0; i < flights.length; i++) {
            const f = flights[i];
            let isMatch = true;
            if (matchCallsigns.size > 0) isMatch = isMatch && matchCallsigns.has(f.CallSign);
            if (args.match.airline) isMatch = isMatch && (f.CallSign || '').substring(0, 3).toUpperCase() === args.match.airline.toUpperCase();
            if (args.match.type === 'arrival') isMatch = isMatch && isArrival(f);
            if (args.match.type === 'departure') isMatch = isMatch && !isArrival(f);
            if (args.match.stand) isMatch = isMatch && f.Stand === args.match.stand;
            if (args.match.runway) isMatch = isMatch && f.Runway === args.match.runway;
            if (args.match.aircraftType) isMatch = isMatch && f.AircraftType === args.match.aircraftType;
            if (isMatch) {
              matched++;
              const updated = applyCascades(f, args.updates, constraints);
              if (JSON.stringify(updated) !== JSON.stringify(f)) { flights[i] = updated; modified++; }
              else { flights[i] = updated; }
            }
          }
          const issues = validateFlightObjects([], flights, constraints);
          if (issues) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: { code: 'VALIDATION_FAILED', message: issues.length + ' validation issue(s).', details: issues } }) }], isError: true });
          }
          pushStoreUpdate({ flights, modified: true });
          result = { success: true, matched, modified };
          break;
        }

        case 'delete_flights': {
          const state = await readStoreState();
          if (state.screen !== 'editor' || !state.currentPath) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No level is open.' }) }], isError: true });
          }
          const matchCallsigns = new Set();
          if (args.match.callsigns) args.match.callsigns.forEach(cs => matchCallsigns.add(cs));
          if (args.match.callsign) matchCallsigns.add(args.match.callsign);
          if (matchCallsigns.size > 0) {
            const existingCallsigns = new Set((state.flights || []).map(f => f.CallSign));
            const missing = [...matchCallsigns].filter(cs => !existingCallsigns.has(cs));
            if (missing.length > 0 && missing.length === matchCallsigns.size) {
              return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Callsigns not found: [' + missing.join(', ') + ']' }) }], isError: true });
            }
          }
          let flights = [...(state.flights || [])];
          const before = flights.length;
          flights = flights.filter(f => {
            let isMatch = true;
            if (matchCallsigns.size > 0) isMatch = isMatch && matchCallsigns.has(f.CallSign);
            if (args.match.airline) isMatch = isMatch && (f.CallSign || '').substring(0, 3).toUpperCase() === args.match.airline.toUpperCase();
            if (args.match.type === 'arrival') isMatch = isMatch && isArrival(f);
            if (args.match.type === 'departure') isMatch = isMatch && !isArrival(f);
            if (args.match.stand) isMatch = isMatch && f.Stand === args.match.stand;
            if (args.match.runway) isMatch = isMatch && f.Runway === args.match.runway;
            if (args.match.aircraftType) isMatch = isMatch && f.AircraftType === args.match.aircraftType;
            return !isMatch;
          });
          pushStoreUpdate({ flights, modified: true });
          result = { success: true, deleted: before - flights.length };
          break;
        }

        case 'get_editor_status': {
          const state = await readStoreState();
          const arrCount = (state.flights || []).filter(f => f.LandingTime && f.LandingTime.trim()).length;
          const depCount = (state.flights || []).filter(f => f.OffBlockTime && f.OffBlockTime.trim()).length;
          result = {
            success: true,
            editorReady: state.screen === 'editor' && !!state.currentPath,
            currentPath: state.currentPath || null,
            currentAirport: state.currentAirport || null,
            flightCount: (state.flights || []).length,
            arrivalCount: arrCount, departureCount: depCount,
            configStartTime: state._configStartTime || null,
            configEndTime: state._configEndTime || null,
            isDemo: state.isDemo || false, modified: state.modified || false,
            hasTimelines: {
              weather: !!(state.weatherTimeline && state.weatherTimeline.length > 0),
              wind: !!(state.windTimeline && state.windTimeline.length > 0),
              runway: !!(state.runwayTimeline && state.runwayTimeline.timeline && state.runwayTimeline.timeline.length > 0),
            },
          };
          break;
        }

        case 'get_airport_info': {
          const state = await readStoreState();
          const cache = getAirportCache ? getAirportCache() : null;
          const constraints = buildConstraints(state, cache);
          result = {
            success: true,
            currentAirport: state.currentAirport,
            cacheReady: !!(cache && state.currentAirport && cache[state.currentAirport]),
            configTimeRange: { start: state._configStartTime || null, end: state._configEndTime || null },
            constraints: {
              flatLists: { Stand: constraints.stands, Runway: constraints.runways, Voice: constraints.voices, Language: constraints.languages, AirlineName: constraints.airlineNames },
              airlineCode: [...constraints.knownCodes],
              flightNumbers: constraints.flightNumbers,
              aircraftTypes: constraints.aircraftTypes,
              airlineAircraftCompat: constraints.airlineAircraftCompat,
              runwayStarCompat: constraints.runwayStarCompat,
              registrationsByPair: constraints.registrationsByPair,
              timeRules: { minTime: state._configStartTime || null, maxTime: state._configEndTime || null, timeOrderArrival: 'LandingTime < InBlockTime', timeOrderDeparture: 'OffBlockTime < TakeoffTime', format: 'HH:MM:SS' },
              standRules: { departureDepartureConflict: 'Two departures on same stand conflict', departureArrivalConflict: 'Dep+Arr on same stand conflict when OffBlockTime >= LandingTime' },
              registrationRules: { duplicateThreshold: 2, format: 'Country prefix + hyphen + alphanumeric' },
            },
            warning: (state.currentAirport && cache && !cache[state.currentAirport]) ? 'Airport cache not ready.' : null,
          };
          break;
        }

        case 'get_validation_issues': {
          const state = await readStoreState();
          const cache = getAirportCache ? getAirportCache() : null;
          const constraints = buildConstraints(state, cache);
          const issues = validateFlightObjects([], state.flights || [], constraints) || [];
          result = {
            success: true,
            issues: issues.filter(i => !['duplicate_callsign','stand_conflict','duplicate_registration'].includes(i.issue)).map(i => i.message),
            duplicateCallsigns: [...new Set(issues.filter(i => i.issue === 'duplicate_callsign').map(i => i.value))],
            standConflicts: issues.filter(i => i.issue === 'stand_conflict').map(i => ({ stand: i.value, message: i.message })),
            duplicateRegistrations: issues.filter(i => i.issue === 'duplicate_registration').map(i => ({ registration: i.value, message: i.message })),
          };
          break;
        }

        default:
          return errResp(-32601, 'Unknown tool: ' + toolName);
      }

      return respond({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    }

    return errResp(-32601, 'Method not found: ' + msg.method);
  } catch (err) {
    console.error('[MCP] Error:', err);
    return errResp(-32603, 'Internal error: ' + err.message);
  }
}

// ── Request Handler ─────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;
  const method = req.method;

  // CORS-like headers for local development
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // Parse JSON body for POST/PATCH/DELETE
  let body = null;
  if (['POST', 'PATCH', 'DELETE'].includes(method)) {
    try {
      body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
          try { resolve(data ? JSON.parse(data) : {}); }
          catch (e) { reject(e); }
        });
        req.on('error', reject);
      });
    } catch (e) {
      res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' })); return;
    }
  }

  try {
    // ── MCP SSE endpoint ────────────────────────────────────
    if (path === '/mcp') {
      if (method === 'GET') {
        // SSE connection — keep alive for server→client messages
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
        });
        // Flush headers immediately so client knows connection is established
        if (res.flushHeaders) res.flushHeaders();
        const clientId = nextSseClientId++;
        sseClients.set(clientId, res);
        // Send initial comment/ping so client knows the stream is alive
        res.write(': ok\n\n');
        // Send endpoint event per MCP SSE spec (absolute path)
        res.write('event: endpoint\ndata: /mcp?clientId=' + clientId + '\n\n');
        // Keep-alive ping every 30s
        const pingInterval = setInterval(() => {
          try { res.write(': ping\n\n'); } catch (_) { clearInterval(pingInterval); }
        }, 30000);
        req.on('close', () => {
          clearInterval(pingInterval);
          sseClients.delete(clientId);
        });
        return; // Keep connection open
      }

      if (method === 'POST') {
        if (!body) { res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'Missing body' })); return; }
        const response = await handleMcpMessage(body);
        // Push to SSE client if one is connected for this session
        const clientIdStr = url.searchParams.get('clientId');
        if (clientIdStr) {
          const clientId = parseInt(clientIdStr);
          const client = sseClients.get(clientId);
          if (client) {
            client.write('event: message\ndata: ' + JSON.stringify(response) + '\n\n');
          }
        }
        // Always return the JSON-RPC response directly in the HTTP body
        // (works for both SSE clients and stdio bridge scripts)
        res.writeHead(200);
        res.end(JSON.stringify(response));
        return;
      }

      // CORS preflight for /mcp
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }
    }

    // ── GET /api/status ──────────────────────────────────────
    if (method === 'GET' && path === '/api/status') {
      const state = await readStoreState();
      const arrCount = (state.flights || []).filter(f => f.LandingTime && f.LandingTime.trim()).length;
      const depCount = (state.flights || []).filter(f => f.OffBlockTime && f.OffBlockTime.trim()).length;
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        editorReady: state.screen === 'editor' && !!state.currentPath,
        currentPath: state.currentPath || null,
        currentAirport: state.currentAirport || null,
        flightCount: (state.flights || []).length,
        arrivalCount: arrCount,
        departureCount: depCount,
        configStartTime: state._configStartTime || null,
        configEndTime: state._configEndTime || null,
        isDemo: state.isDemo || false,
        modified: state.modified || false,
        hasTimelines: {
          weather: !!(state.weatherTimeline && state.weatherTimeline.length > 0),
          wind: !!(state.windTimeline && state.windTimeline.length > 0),
          runway: !!(state.runwayTimeline && state.runwayTimeline.timeline && state.runwayTimeline.timeline.length > 0),
        },
      }));
      return;
    }

    // ── GET /api/airport/values ──────────────────────────────
    if (method === 'GET' && path === '/api/airport/values') {
      const state = await readStoreState();
      const cache = getAirportCache ? getAirportCache() : null;
      const constraints = buildConstraints(state, cache);

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        currentAirport: state.currentAirport,
        cacheReady: !!(cache && state.currentAirport && cache[state.currentAirport]),
        configTimeRange: {
          start: state._configStartTime || null,
          end: state._configEndTime || null,
        },
        constraints: {
          flatLists: {
            Stand: constraints.stands,
            Runway: constraints.runways,
            Voice: constraints.voices,
            Language: constraints.languages,
            AirlineName: constraints.airlineNames,
          },
          airlineCode: [...constraints.knownCodes],
          flightNumbers: constraints.flightNumbers,
          aircraftTypes: constraints.aircraftTypes,
          airlineAircraftCompat: constraints.airlineAircraftCompat,
          runwayStarCompat: constraints.runwayStarCompat,
          registrationsByPair: constraints.registrationsByPair,
          timeRules: {
            minTime: state._configStartTime || null,
            maxTime: state._configEndTime || null,
            timeOrderArrival: 'LandingTime must be < InBlockTime',
            timeOrderDeparture: 'OffBlockTime must be < TakeoffTime',
            format: 'HH:MM:SS (HH:MM shorthand accepted)',
          },
          standRules: {
            departureDepartureConflict: 'Two departures on the same stand always conflict',
            departureArrivalConflict: 'Departure and arrival on same stand conflict when OffBlockTime >= LandingTime',
          },
          registrationRules: {
            duplicateThreshold: 2,
            format: 'Country prefix + hyphen + alphanumeric (e.g. B-1234, N123AB)',
          },
        },
        warning: (state.currentAirport && cache && !cache[state.currentAirport])
          ? 'Airport cache not ready for ' + state.currentAirport + '. Some validation may be unavailable.'
          : null,
      }));
      return;
    }

    // ── GET /api/flights ─────────────────────────────────────
    if (method === 'GET' && path === '/api/flights') {
      const state = await readStoreState();
      let flights = [...(state.flights || [])];

      // Filters from query params
      const fType = url.searchParams.get('type'); // 'arrival' | 'departure'
      const fAirline = url.searchParams.get('airline');
      const fCallsign = url.searchParams.get('callsign');
      const fStand = url.searchParams.get('stand');
      const fRunway = url.searchParams.get('runway');
      const fAircraftType = url.searchParams.get('aircraftType');
      const fTimeAfter = url.searchParams.get('timeAfter');
      const fTimeBefore = url.searchParams.get('timeBefore');
      const fLimit = parseInt(url.searchParams.get('limit')) || 100;
      const fOffset = parseInt(url.searchParams.get('offset')) || 0;

      if (fType === 'arrival') flights = flights.filter(f => !!(f.LandingTime && f.LandingTime.trim()));
      if (fType === 'departure') flights = flights.filter(f => !!(f.OffBlockTime && f.OffBlockTime.trim()));
      if (fAirline) flights = flights.filter(f => (f.CallSign || '').substring(0, 3).toUpperCase() === fAirline.toUpperCase());
      if (fCallsign) flights = flights.filter(f => f.CallSign === fCallsign);
      if (fStand) flights = flights.filter(f => f.Stand === fStand);
      if (fRunway) flights = flights.filter(f => f.Runway === fRunway);
      if (fAircraftType) flights = flights.filter(f => f.AircraftType === fAircraftType);
      if (fTimeAfter) {
        const afterSec = parseTimeSeconds(fTimeAfter);
        if (!isNaN(afterSec)) flights = flights.filter(f => {
          const s = parseTimeSeconds(primaryTime(f)); return !isNaN(s) && s >= afterSec;
        });
      }
      if (fTimeBefore) {
        const beforeSec = parseTimeSeconds(fTimeBefore);
        if (!isNaN(beforeSec)) flights = flights.filter(f => {
          const s = parseTimeSeconds(primaryTime(f)); return !isNaN(s) && s <= beforeSec;
        });
      }

      const total = flights.length;
      flights = flights.slice(fOffset, fOffset + fLimit);

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, flights, total }));
      return;
    }

    // ── POST /api/flights/create-batch ───────────────────────
    if (method === 'POST' && path === '/api/flights/create-batch') {
      if (!body || !Array.isArray(body.flights) || body.flights.length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Request body must have a non-empty "flights" array.' }));
        return;
      }

      const state = await readStoreState();
      if (state.screen !== 'editor' || !state.currentPath) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'No level is open. Please open a level in the editor first.' }));
        return;
      }

      const cache = getAirportCache ? getAirportCache() : null;
      const constraints = buildConstraints(state, cache);

      // Validate
      const issues = validateFlightObjects(body.flights, state.flights || [], constraints);
      if (issues) {
        res.writeHead(422);
        res.end(JSON.stringify({
          success: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: `${issues.length} validation issue(s) found. See details.`,
            details: issues,
          },
        }));
        return;
      }

      const newFlights = [...(state.flights || []), ...body.flights];
      pushStoreUpdate({ flights: newFlights, modified: true });

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, created: body.flights.length }));
      return;
    }

    // ── PATCH /api/flights/batch ─────────────────────────────
    if (method === 'PATCH' && path === '/api/flights/batch') {
      if (!body || !body.match || !body.updates) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Request body must have "match" and "updates" objects.' }));
        return;
      }

      const state = await readStoreState();
      if (state.screen !== 'editor' || !state.currentPath) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'No level is open.' }));
        return;
      }

      const cache = getAirportCache ? getAirportCache() : null;
      const constraints = buildConstraints(state, cache);

      // Build match set
      const matchCallsigns = new Set();
      if (body.match.callsigns) body.match.callsigns.forEach(cs => matchCallsigns.add(cs));
      if (body.match.callsign) matchCallsigns.add(body.match.callsign);

      let flights = [...(state.flights || [])];
      let matched = 0;
      let modified = 0;

      for (let i = 0; i < flights.length; i++) {
        const f = flights[i];
        let isMatch = true;
        if (matchCallsigns.size > 0) isMatch = isMatch && matchCallsigns.has(f.CallSign);
        if (body.match.airline) isMatch = isMatch && (f.CallSign || '').substring(0, 3).toUpperCase() === body.match.airline.toUpperCase();
        if (body.match.type === 'arrival') isMatch = isMatch && isArrival(f);
        if (body.match.type === 'departure') isMatch = isMatch && !isArrival(f);
        if (body.match.stand) isMatch = isMatch && f.Stand === body.match.stand;
        if (body.match.runway) isMatch = isMatch && f.Runway === body.match.runway;
        if (body.match.aircraftType) isMatch = isMatch && f.AircraftType === body.match.aircraftType;

        if (isMatch) {
          matched++;
          const updated = applyCascades(f, body.updates, constraints);
          if (JSON.stringify(updated) !== JSON.stringify(f)) {
            flights[i] = updated;
            modified++;
          } else {
            flights[i] = updated;
          }
        }
      }

      // Validate the resulting flight array
      const issues = validateFlightObjects([], flights, constraints);
      if (issues) {
        res.writeHead(422);
        res.end(JSON.stringify({
          success: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: `${issues.length} validation issue(s) found after applying updates. No changes were made.`,
            details: issues,
          },
        }));
        return;
      }

      pushStoreUpdate({ flights, modified: true });

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, matched, modified }));
      return;
    }

    // ── POST /api/flights/delete-batch ──────────────────────
    if (method === 'POST' && path === '/api/flights/delete-batch') {
      if (!body || !body.match) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Request body must have a "match" object.' }));
        return;
      }

      const state = await readStoreState();
      if (state.screen !== 'editor' || !state.currentPath) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'No level is open.' }));
        return;
      }

      // Build match set
      const matchCallsigns = new Set();
      if (body.match.callsigns) body.match.callsigns.forEach(cs => matchCallsigns.add(cs));
      if (body.match.callsign) matchCallsigns.add(body.match.callsign);

      // Check for non-existent callsigns (only when matching by callsign)
      if (matchCallsigns.size > 0) {
        const existingCallsigns = new Set((state.flights || []).map(f => f.CallSign));
        const missing = [...matchCallsigns].filter(cs => !existingCallsigns.has(cs));
        if (missing.length > 0 && missing.length === matchCallsigns.size) {
          res.writeHead(404);
          res.end(JSON.stringify({ success: false, error: `Callsigns not found: [${missing.join(', ')}]` }));
          return;
        }
      }

      let flights = [...(state.flights || [])];
      const before = flights.length;

      flights = flights.filter(f => {
        let isMatch = true;
        if (matchCallsigns.size > 0) isMatch = isMatch && matchCallsigns.has(f.CallSign);
        if (body.match.airline) isMatch = isMatch && (f.CallSign || '').substring(0, 3).toUpperCase() === body.match.airline.toUpperCase();
        if (body.match.type === 'arrival') isMatch = isMatch && isArrival(f);
        if (body.match.type === 'departure') isMatch = isMatch && !isArrival(f);
        if (body.match.stand) isMatch = isMatch && f.Stand === body.match.stand;
        if (body.match.runway) isMatch = isMatch && f.Runway === body.match.runway;
        if (body.match.aircraftType) isMatch = isMatch && f.AircraftType === body.match.aircraftType;
        return !isMatch;
      });

      const deleted = before - flights.length;
      pushStoreUpdate({ flights, modified: true });

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, deleted }));
      return;
    }

    // ── GET /api/validation ──────────────────────────────────
    if (method === 'GET' && path === '/api/validation') {
      const state = await readStoreState();
      const cache = getAirportCache ? getAirportCache() : null;
      const constraints = buildConstraints(state, cache);

      const issues = validateFlightObjects([], state.flights || [], constraints) || [];

      // Separate by type
      const dupCallsigns = issues.filter(i => i.issue === 'duplicate_callsign').map(i => i.value);
      const standConflicts = issues.filter(i => i.issue === 'stand_conflict').map(i => ({
        stand: i.value,
        message: i.message,
      }));
      const dupRegs = issues.filter(i => i.issue === 'duplicate_registration').map(i => ({
        registration: i.value,
        message: i.message,
      }));
      const otherIssues = issues.filter(i =>
        !['duplicate_callsign', 'stand_conflict', 'duplicate_registration'].includes(i.issue)
      ).map(i => i.message);

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        issues: otherIssues,
        duplicateCallsigns: [...new Set(dupCallsigns)],
        standConflicts,
        duplicateRegistrations: dupRegs,
      }));
      return;
    }

    // ── 404 ──────────────────────────────────────────────────
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: `Unknown endpoint: ${method} ${path}` }));

  } catch (err) {
    console.error('[API] Error handling request:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, error: 'Internal server error: ' + err.message }));
  }
}

// ── Public API ──────────────────────────────────────────────────

function startServer(window, port, cacheGetter) {
  if (server) return; // already running
  mainWindow = window;
  getAirportCache = cacheGetter;
  server = http.createServer(handleRequest);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('[API] Port ' + port + ' is in use — MCP/API unavailable. Is another instance running?');
    } else {
      console.error('[API] Server error:', err.message);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('[API] HTTP API + MCP SSE server listening on http://127.0.0.1:' + port);
  });
}

function stopServer() {
  // Close all SSE connections
  for (const [id, res] of sseClients) {
    try { res.end(); } catch (_) {}
  }
  sseClients.clear();
  if (server) {
    server.close();
    server = null;
    mainWindow = null;
    getAirportCache = null;
    console.log('[API] HTTP API server stopped');
  }
}

module.exports = { startServer, stopServer, validateFlightObjects, buildConstraints, applyCascades, parseTimeSeconds, isArrival, handleMcpMessage, MCP_TOOLS };
