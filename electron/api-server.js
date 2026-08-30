/**
 * HTTP API Server for AC27 Editor
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
  SCENARIO_END_GRACE_MIN, SCENARIO_END_GRACE_SEC,
} = require('../src/acl/constants');
const { CHANNEL_TYPE_APPROACH } = require('../src/utils/constants/aviation');

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

// ── Ground Painter helpers (MCP must mirror the UI write path) ───────────
// Keep these helpers local to api-server.js so the main process can mutate
// the in-memory graph without touching the renderer Vite bundle.

// Deep clone using structuredClone when available, fallback to JSON
function _clone(obj) {
  if (obj == null) return obj;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(obj); } catch (_) {}
  }
  return JSON.parse(JSON.stringify(obj));
}
const STAND_LENGTH = 0.63; // mirrors src/utils/constants STAND_LENGTH
const RUNWAY_WIDTH = 0.50;
const RUNWAY_PAVEMENT_FLAGS = 4;
function _coordKey(x, z) { return (+x).toFixed(6) + ',' + (+z).toFixed(6); }
function _findNodeIndexByCoord(graph, x, z, eps) {
  eps = eps == null ? 1e-6 : eps;
  if (!graph || !graph.nodes) return -1;
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i];
    if (!n) continue;
    if (Math.abs(n.x - x) < eps && Math.abs(n.z - z) < eps) return i;
  }
  return -1;
}
function _normalizeHeading(h) {
  let n = Math.round(Number(h));
  if (!isFinite(n)) n = 360;
  n = ((n % 360) + 360) % 360;
  return n === 0 ? 360 : n;
}
function _segNodeIdxs(seg) {
  if (!seg) return [];
  if (Array.isArray(seg.nodeIdxs) && seg.nodeIdxs.length) return seg.nodeIdxs.slice();
  const a = seg.aIdx, b = seg.bIdx;
  if (a != null && b != null) return [a, b];
  return [];
}
function _ensurePainterMetaArrays(meta, graph) {
  if (!meta) return;
  if (!Array.isArray(meta.nodeOrigPk)) meta.nodeOrigPk = (graph ? graph.nodes.map(() => null) : []);
  if (!Array.isArray(meta.segOrigPk)) meta.segOrigPk = (graph ? graph.segments.map(() => null) : []);
  if (!Array.isArray(meta.runwayOrigPk)) meta.runwayOrigPk = (graph ? graph.runways.map(() => null) : []);
  if (!Array.isArray(meta.areaOrigId)) meta.areaOrigId = (graph ? graph.areas.map(() => null) : []);
  if (!Array.isArray(meta.standOrigPk)) meta.standOrigPk = (graph ? graph.stands.map(() => null) : []);
  if (!Array.isArray(meta.deletedPks)) meta.deletedPks = [];
  if (!Array.isArray(meta.deletedAreaIds)) meta.deletedAreaIds = [];
  if (!Array.isArray(meta.runwayPavement)) meta.runwayPavement = (graph ? graph.runways.map(() => []) : []);
  if (!Array.isArray(meta.runwayOrigInfo)) meta.runwayOrigInfo = (graph ? graph.runways.map((rw) => ({ pks: [], physicalName: rw.physicalName || '', names: rw.names || [], width: rw.width || RUNWAY_WIDTH })) : []);
}
function _pushPainterHistory(state) {
  const gClone = _clone(state.groundPainterGraph);
  const mClone = _clone(state.groundPainterMeta);
  return { groundPainterHistory: gClone, groundPainterMetaHistory: mClone };
}
function _groundPainterNotReady() {
  return { success: false, error: 'Ground Painter not yet initialized — open the Ground Painter UI once to seed the graph (it is null until first open).' };
}
// Distance helpers for delete_ground_objects picking (mirrors GroundPainter pickForeground thresholds loosely)
function _distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
function _pointInPoly(px, pz, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, zi = pts[i].z, xj = pts[j].x, zj = pts[j].z;
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function _minEdgeDist(px, pz, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    d = Math.min(d, _distToSeg(px, pz, pts[i].x, pts[i].z, pts[j].x, pts[j].z));
  }
  return d;
}
function _distToPoly(px, pz, pts) {
  if (!pts || pts.length < 2) return Infinity;
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, _distToSeg(px, pz, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z));
  return d;
}

/** Parse HH:MM or HH:MM:SS into total seconds */
function parseTimeSeconds(t) {
  if (!t || typeof t !== 'string') return NaN;
  const parts = t.split(':');
  if (parts.length === 2) parts.push('00');
  if (parts.length !== 3) return NaN;
  return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
}

/** Format total seconds back into HH:MM:SS */
function formatTimeSeconds(sec) {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
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

    // 7. Arrival legs must carry a STAR — the game's FlightPlan.Init() drops
    //    a STAR-less arrival leg at level load ("Flight plan '...' has
    //    neither an arrival nor a departure leg").
    if (isArrival(f) && !(f.Airway || '').trim()) {
      details.push({
        index: idx, field: 'Airway', value: f.Airway,
        issue: 'missing_star',
        message: `Arrival ${f.CallSign || '?'} has no STAR — the game drops STAR-less arrival legs at level load.`,
      });
    }

    // 7b. Airway compatible with runway (arrivals only)
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
        // Flights may run up to SCENARIO_END_GRACE_MIN past scenario end.
        if (!isNaN(sec) && !isNaN(endSec) && sec > endSec + SCENARIO_END_GRACE_SEC) {
          details.push({
            index: idx, field: isArrival(f) ? 'LandingTime' : 'OffBlockTime', value: pt,
            issue: 'time_after_range',
            message: `${isArrival(f) ? 'LandingTime' : 'OffBlockTime'} ${pt} is after config end ${constraints.configEndTime} (max +${SCENARIO_END_GRACE_MIN} min).`,
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
    // AirlineName stores the 3-letter code (game format)
    result.AirlineName = newCode;
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
  {
    name: 'send_voice_command',
    description: 'Parse a spoken-style command sentence against the LIVE aircraft list (same pipeline as the PTT mic) and dispatch the patch frames to the game. e.g. "CSC6918: climb and maintain 9000, reduce speed to 180 knots". Selection-only transcripts (bare callsign) parse but send nothing. Fails if no aircraft matches, or the aircraft is not on the approach channel (controlSeat 5).',
    inputSchema: {
      type: 'object',
      properties: {
        transcript: { type: 'string', description: 'Full human sentence, as the mic would hear it. Language auto-detected (en/zh).' },
      },
      required: ['transcript'],
    },
  },
  { name: 'get_ground_painter_state', description: 'Read the Ground Painter current state (id-free graph, tool, dirty, isOpen). Null graph means painter not yet seeded — open the Ground Painter UI once.', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_taxiway_lines', description: 'Add straight taxiway segments to the Ground Painter graph (in-memory until Save). Deduplicates nodes by coordinate (1e-6), validates distinct endpoints, pushes history so undo works. Uses flags 2 (wider) by default.', inputSchema: { type: 'object', properties: { lines: { type: 'array', items: { type: 'object', properties: { a: { type: 'object', required: ['x', 'z'], properties: { x: { type: 'number' }, z: { type: 'number' } } }, b: { type: 'object', required: ['x', 'z'], properties: { x: { type: 'number' }, z: { type: 'number' } } }, name: { type: 'string' }, flags: { type: 'number' } }, required: ['a', 'b'] } } }, required: ['lines'] } },
  { name: 'create_areas', description: 'Add Area polygons to the Ground Painter graph (areaType 0=boundary/perimeter, 1=apron, 2=building). Each polygon needs ≥3 vertices, auto-closed.', inputSchema: { type: 'object', properties: { areas: { type: 'array', items: { type: 'object', properties: { areaType: { type: 'number', enum: [0, 1, 2] }, points: { type: 'array', minItems: 3, items: { type: 'object', required: ['x', 'z'], properties: { x: { type: 'number' }, z: { type: 'number' } } } } }, required: ['areaType', 'points'] } } }, required: ['areas'] } },
  { name: 'create_area', description: 'Add a single Area polygon (deprecated, use create_areas).', inputSchema: { type: 'object', properties: { areaType: { type: 'number' }, points: { type: 'array', items: { type: 'object' } } }, required: ['areaType', 'points'] } },
  { name: 'create_stands', description: 'Add stand placements to the Ground Painter graph (nose x/z + heading 1..360). Heading 0/unset folds to 360 (north). Creates nose+tail nodes (STAND_LENGTH=0.63) and persists with heading.', inputSchema: { type: 'object', properties: { stands: { type: 'array', items: { type: 'object', required: ['x', 'z'], properties: { x: { type: 'number' }, z: { type: 'number' }, heading: { type: 'number', minimum: 0, maximum: 360 } } } } }, required: ['stands'] } },
  { name: 'create_runways', description: 'Add physical runways (paired thresholds + collinear pavement strip). Each runway is defined by two threshold points a/b; names are derived from heading (e.g. 01/19) and pavement strip Flags=4 is auto-synthesized.', inputSchema: { type: 'object', properties: { runways: { type: 'array', minItems: 1, items: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'object', required: ['x', 'z'], properties: { x: { type: 'number' }, z: { type: 'number' } } }, b: { type: 'object', required: ['x', 'z'], properties: { x: { type: 'number' }, z: { type: 'number' } } } } } } }, required: ['runways'] } },
  { name: 'create_taxiway_fillet', description: 'Round the corner between two straight taxiway segments (fillet/arc). Picks two segment indices and a radius (0.5..5.0 GU, default 2.0). Supports both connected and virtual (disconnected) fillets. Validates angle 5..175°, parallel check, and pushes paired history.', inputSchema: { type: 'object', properties: { segA: { type: 'integer', minimum: 0 }, segB: { type: 'integer', minimum: 0 }, radius: { type: 'number', minimum: 0.5, maximum: 5.0 } }, required: ['segA', 'segB'] } },
  { name: 'delete_ground_objects', description: 'Delete the nearest ground object to a point (stand > segment/runway > area priority, same as UI Select). Uses hit threshold ~0.6 GU. Records deletedPks/deletedAreaIds so save persists; pushes history.', inputSchema: { type: 'object', properties: { target: { type: 'object', required: ['x', 'z'], properties: { x: { type: 'number' }, z: { type: 'number' } } }, threshold: { type: 'number' } }, required: ['target'] } },
  { name: 'delete_all_ground_objects', description: 'Clear every ground object (destructive). Records deletedPks/deletedAreaIds for all survivors so save persists; pushes history.', inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } },
  { name: 'undo_ground_painter', description: 'Restore the last Ground Painter graph+meta snapshot (depth-1 undo, paired graph+meta).', inputSchema: { type: 'object', properties: {} } },
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
          // Enrich rows: derive isDeparture from OffBlockTime (same convention as
          // the get_flights departure filter) and default AirlineName to the
          // callsign's 3-letter airline code (the game stores codes, not names).
          const newFlights = [...(state.flights || []), ...args.flights.map(f => ({
            ...f,
            isDeparture: !!(f.OffBlockTime && f.OffBlockTime.trim()),
            AirlineName: (f.AirlineName || '').trim() || (f.CallSign || '').substring(0, 3),
          }))];
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

        case 'get_ground_painter_state': {
          const s = await readStoreState();
          const g = s.groundPainterGraph || null;
          result = {
            success: true,
            isOpen: !!s.showGroundPainter,
            hasEdited: !!s.groundPainterHasEdited,
            tool: s.groundPainterTool || 'select',
            historyDepth: s.groundPainterHistory ? 1 : 0,
            graph: g,
            summary: g ? { nodes: g.nodes.length, segments: g.segments.length, runways: g.runways.length, areas: g.areas.length, stands: g.stands.length } : null,
            metaSummary: s.groundPainterMeta ? { nodeOrigPk: s.groundPainterMeta.nodeOrigPk?.length || 0, segOrigPk: s.groundPainterMeta.segOrigPk?.length || 0, deletedPks: s.groundPainterMeta.deletedPks?.length || 0, deletedAreaIds: s.groundPainterMeta.deletedAreaIds?.length || 0 } : null,
          };
          break;
        }
        case 'create_taxiway_lines': {
          const s = await readStoreState();
          const g = s.groundPainterGraph;
          if (!g) {
            return respond({ content: [{ type: 'text', text: JSON.stringify(_groundPainterNotReady()) }], isError: true });
          }
          const lines = args.lines || [];
          if (!Array.isArray(lines) || lines.length === 0) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'lines array required (≥1)' }) }], isError: true });
          }
          const newGraph = _clone(g);
          const newMeta = _clone(s.groundPainterMeta) || { nodeOrigPk: [], segOrigPk: [], runwayOrigPk: [], areaOrigId: [], standOrigPk: [], deletedPks: [], deletedAreaIds: [], runwayPavement: [], runwayOrigInfo: [] };
          _ensurePainterMetaArrays(newMeta, newGraph);
          let added = 0;
          const errors = [];
          const getOrCreate = (pt) => {
            const existing = _findNodeIndexByCoord(newGraph, pt.x, pt.z);
            if (existing >= 0) return existing;
            const idx = newGraph.nodes.length;
            newGraph.nodes.push({ x: pt.x, z: pt.z, type: 2, flags: 0 });
            newMeta.nodeOrigPk.push(null);
            return idx;
          };
          for (let i = 0; i < lines.length; i++) {
            const ln = lines[i];
            if (!ln || !ln.a || !ln.b) { errors.push({ index: i, issue: 'missing a/b' }); continue; }
            if (typeof ln.a.x !== 'number' || typeof ln.a.z !== 'number' || typeof ln.b.x !== 'number' || typeof ln.b.z !== 'number') { errors.push({ index: i, issue: 'a/b x/z must be numbers' }); continue; }
            if (Math.hypot(ln.a.x - ln.b.x, ln.a.z - ln.b.z) < 1e-6) { errors.push({ index: i, issue: 'Segment needs distinct endpoints' }); continue; }
            const aIdx = getOrCreate(ln.a);
            const bIdx = getOrCreate(ln.b);
            if (aIdx === bIdx) { errors.push({ index: i, issue: 'Segment needs distinct endpoints (same node)' }); continue; }
            newGraph.segments.push({ aIdx, bIdx, nodeIdxs: [aIdx, bIdx], flags: ln.flags ?? 2, directed: false, ...(ln.name ? { name: String(ln.name) } : {}) });
            newMeta.segOrigPk.push(null);
            added++;
          }
          if (added === 0 && errors.length) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No segments added', details: errors }) }], isError: true });
          }
          const hist = _pushPainterHistory(s);
          pushStoreUpdate({ groundPainterGraph: newGraph, groundPainterMeta: newMeta, ...hist, groundPainterHasEdited: true });
          result = { success: true, added, errors: errors.length ? errors : undefined, totalSegments: newGraph.segments.length };
          break;
        }
        case 'create_areas': {
          const s = await readStoreState();
          const g = s.groundPainterGraph;
          if (!g) return respond({ content: [{ type: 'text', text: JSON.stringify(_groundPainterNotReady()) }], isError: true });
          const areas = args.areas || [];
          if (!Array.isArray(areas) || areas.length === 0) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'areas array required (≥1)' }) }], isError: true });
          const newGraph = _clone(g);
          const newMeta = _clone(s.groundPainterMeta) || { nodeOrigPk: [], segOrigPk: [], runwayOrigPk: [], areaOrigId: [], standOrigPk: [], deletedPks: [], deletedAreaIds: [], runwayPavement: [], runwayOrigInfo: [] };
          _ensurePainterMetaArrays(newMeta, newGraph);
          let added = 0;
          const errors = [];
          for (let i = 0; i < areas.length; i++) {
            const ar = areas[i];
            if (!ar || !Array.isArray(ar.points) || ar.points.length < 3) { errors.push({ index: i, issue: 'Area needs at least 3 vertices' }); continue; }
            const at = ar.areaType;
            if (at !== 0 && at !== 1 && at !== 2) { errors.push({ index: i, issue: 'areaType must be 0|1|2' }); continue; }
            const pts = ar.points.map((p) => ({ x: Number(p.x), z: Number(p.z) }));
            if (pts.some((p) => !isFinite(p.x) || !isFinite(p.z))) { errors.push({ index: i, issue: 'points x/z must be numbers' }); continue; }
            newGraph.areas.push({ areaType: at, points: pts, owner: null });
            newMeta.areaOrigId.push(null);
            added++;
          }
          if (added === 0 && errors.length) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No areas added', details: errors }) }], isError: true });
          const hist = _pushPainterHistory(s);
          pushStoreUpdate({ groundPainterGraph: newGraph, groundPainterMeta: newMeta, ...hist, groundPainterHasEdited: true });
          result = { success: true, added, errors: errors.length ? errors : undefined, totalAreas: newGraph.areas.length };
          break;
        }
        case 'create_area': {
          // Back-compat single-area wrapper
          const single = args.areaType != null || args.points ? [{ areaType: args.areaType, points: args.points }] : (Array.isArray(args.areas) ? args.areas : []);
          const s = await readStoreState();
          const g = s.groundPainterGraph;
          if (!g) return respond({ content: [{ type: 'text', text: JSON.stringify(_groundPainterNotReady()) }], isError: true });
          if (!single.length) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'areaType and points required' }) }], isError: true });
          const ar = single[0];
          if (!Array.isArray(ar.points) || ar.points.length < 3) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Area needs at least 3 vertices' }) }], isError: true });
          if (ar.areaType !== 0 && ar.areaType !== 1 && ar.areaType !== 2) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'areaType must be 0|1|2' }) }], isError: true });
          const newGraph = _clone(g);
          const newMeta = _clone(s.groundPainterMeta) || { nodeOrigPk: [], segOrigPk: [], runwayOrigPk: [], areaOrigId: [], standOrigPk: [], deletedPks: [], deletedAreaIds: [], runwayPavement: [], runwayOrigInfo: [] };
          _ensurePainterMetaArrays(newMeta, newGraph);
          newGraph.areas.push({ areaType: ar.areaType, points: ar.points.map((p) => ({ x: Number(p.x), z: Number(p.z) })), owner: null });
          newMeta.areaOrigId.push(null);
          const hist = _pushPainterHistory(s);
          pushStoreUpdate({ groundPainterGraph: newGraph, groundPainterMeta: newMeta, ...hist, groundPainterHasEdited: true });
          result = { success: true, added: 1 };
          break;
        }
        case 'create_stands': {
          const s = await readStoreState();
          const g = s.groundPainterGraph;
          if (!g) return respond({ content: [{ type: 'text', text: JSON.stringify(_groundPainterNotReady()) }], isError: true });
          const stands = args.stands || [];
          if (!Array.isArray(stands) || stands.length === 0) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'stands array required (≥1)' }) }], isError: true });
          const newGraph = _clone(g);
          const newMeta = _clone(s.groundPainterMeta) || { nodeOrigPk: [], segOrigPk: [], runwayOrigPk: [], areaOrigId: [], standOrigPk: [], deletedPks: [], deletedAreaIds: [], runwayPavement: [], runwayOrigInfo: [] };
          _ensurePainterMetaArrays(newMeta, newGraph);
          let added = 0;
          const errors = [];
          for (let i = 0; i < stands.length; i++) {
            const st = stands[i];
            if (!st || typeof st.x !== 'number' || typeof st.z !== 'number') { errors.push({ index: i, issue: 'x/z required' }); continue; }
            const hdg = _normalizeHeading(st.heading);
            const rad = (hdg * Math.PI) / 180;
            const nose = { x: st.x, z: st.z };
            const tail = { x: st.x - Math.cos(rad) * STAND_LENGTH, z: st.z + Math.sin(rad) * STAND_LENGTH };
            const ni = newGraph.nodes.length; newGraph.nodes.push(nose); newMeta.nodeOrigPk.push(null);
            const ti = newGraph.nodes.length; newGraph.nodes.push(tail); newMeta.nodeOrigPk.push(null);
            newGraph.stands.push({ noseIdx: ni, tailIdx: ti, heading: hdg, pushbackIdxs: [], parkingType: 1, egressType: 0, ...(st.name ? { name: String(st.name) } : {}) });
            newMeta.standOrigPk.push(null);
            added++;
          }
          if (added === 0 && errors.length) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No stands added', details: errors }) }], isError: true });
          const hist = _pushPainterHistory(s);
          pushStoreUpdate({ groundPainterGraph: newGraph, groundPainterMeta: newMeta, ...hist, groundPainterHasEdited: true });
          result = { success: true, added, errors: errors.length ? errors : undefined };
          break;
        }
        case 'create_runways': {
          const s = await readStoreState();
          const g = s.groundPainterGraph;
          if (!g) return respond({ content: [{ type: 'text', text: JSON.stringify(_groundPainterNotReady()) }], isError: true });
          const runways = args.runways || [];
          if (!Array.isArray(runways) || runways.length === 0) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'runways array required (≥1)' }) }], isError: true });
          const newGraph = _clone(g);
          const newMeta = _clone(s.groundPainterMeta) || { nodeOrigPk: [], segOrigPk: [], runwayOrigPk: [], areaOrigId: [], standOrigPk: [], deletedPks: [], deletedAreaIds: [], runwayPavement: [], runwayOrigInfo: [] };
          _ensurePainterMetaArrays(newMeta, newGraph);
          let added = 0;
          const errors = [];
          for (let i = 0; i < runways.length; i++) {
            const rw = runways[i];
            if (!rw || !rw.a || !rw.b || typeof rw.a.x !== 'number' || typeof rw.a.z !== 'number' || typeof rw.b.x !== 'number' || typeof rw.b.z !== 'number') { errors.push({ index: i, issue: 'a/b x/z required' }); continue; }
            const a = { x: rw.a.x, z: rw.a.z }, b = { x: rw.b.x, z: rw.b.z };
            const dx = b.x - a.x, dz = b.z - a.z;
            const len = Math.hypot(dx, dz);
            if (len < 1e-6) { errors.push({ index: i, issue: 'Runway needs distinct endpoints' }); continue; }
            const h = Math.round(((Math.atan2(-dz, dx) * 180) / Math.PI % 360 + 360) % 360);
            let num = Math.round(h / 10) % 36; if (num === 0) num = 36;
            const name1 = String(num).padStart(2, '0'), name2 = String((num + 18) % 36).padStart(2, '0');
            const physicalName = name1 + '/' + name2;
            const OH = 0.6; const ux = dx / len, uz = dz / len;
            const overA = { x: a.x - ux * OH, z: a.z - uz * OH }, overB = { x: b.x + ux * OH, z: b.z + uz * OH };
            const iOA = newGraph.nodes.length, iA = iOA + 1, iB = iOA + 2, iOB = iOA + 3;
            newGraph.nodes.push({ x: overA.x, z: overA.z, type: 2, flags: 0 }, { x: a.x, z: a.z, type: 2, flags: 0 }, { x: b.x, z: b.z, type: 2, flags: 0 }, { x: overB.x, z: overB.z, type: 2, flags: 0 });
            newMeta.nodeOrigPk.push(null, null, null, null);
            newGraph.segments.push({ aIdx: iA, bIdx: iB, nodeIdxs: [iOA, iA, iB, iOB], name: physicalName, flags: RUNWAY_PAVEMENT_FLAGS, directed: false });
            newMeta.segOrigPk.push(null);
            newGraph.runways.push({ thAIdx: iA, thBIdx: iB, names: [name1, name2], name: name1, physicalName, width: RUNWAY_WIDTH });
            newMeta.runwayOrigPk.push(null);
            newMeta.runwayPavement.push([iOA, iA, iB, iOB]);
            newMeta.runwayOrigInfo.push({ pks: [null, null], physicalName, names: [name1, name2], width: RUNWAY_WIDTH });
            added++;
          }
          if (added === 0 && errors.length) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No runways added', details: errors }) }], isError: true });
          const hist = _pushPainterHistory(s);
          pushStoreUpdate({ groundPainterGraph: newGraph, groundPainterMeta: newMeta, ...hist, groundPainterHasEdited: true });
          result = { success: true, added, errors: errors.length ? errors : undefined, totalRunways: newGraph.runways.length };
          break;
        }
        case 'create_taxiway_fillet': {
          const s = await readStoreState();
          const g = s.groundPainterGraph;
          if (!g) return respond({ content: [{ type: 'text', text: JSON.stringify(_groundPainterNotReady()) }], isError: true });
          let segA = args.segA, segB = args.segB;
          const radius = args.radius != null ? Number(args.radius) : 2.0;
          if (segA == null || segB == null) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'segA and segB segment indices required' }) }], isError: true });
          segA = parseInt(segA, 10); segB = parseInt(segB, 10);
          if (!Number.isFinite(segA) || !Number.isFinite(segB) || segA < 0 || segB < 0 || segA >= g.segments.length || segB >= g.segments.length) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'segA/segB out of range (0..' + (g.segments.length - 1) + ')' }) }], isError: true });
          }
          if (segA === segB) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'segA and segB must be different segments' }) }], isError: true });
          if (!isFinite(radius) || radius < 0.5 || radius > 5.0) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'radius must be 0.5..5.0' }) }], isError: true });
          // Dynamic import of fillet helpers (ESM) — reuse the renderer's pure math
          let fillet;
          try {
            const u = require('url');
            const p = require('path');
            const filletPath = p.join(__dirname, '..', 'src', 'components', 'EditorScreen', 'GroundPainter', 'fillet.js');
            const fileUrl = u.pathToFileURL(filletPath).href;
            fillet = await import(fileUrl);
          } catch (e) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'fillet module load failed: ' + e.message }) }], isError: true });
          }
          if (fillet.isStraightSegment && !fillet.isStraightSegment(g.segments[segA])) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'segA is not a straight segment (only straight segments can be filleted)' }) }], isError: true });
          if (fillet.isStraightSegment && !fillet.isStraightSegment(g.segments[segB])) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'segB is not a straight segment (only straight segments can be filleted)' }) }], isError: true });
          const res = fillet.computeFillet(g, segA, segB, radius);
          if (!res.ok) {
            const msg = res.error || 'fillet compute failed';
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: msg }) }], isError: true });
          }
          // Clone for mutation
          const newGraph = _clone(g);
          const newMeta = _clone(s.groundPainterMeta) || { nodeOrigPk: [], segOrigPk: [], runwayOrigPk: [], areaOrigId: [], standOrigPk: [], deletedPks: [], deletedAreaIds: [], runwayPavement: [], runwayOrigInfo: [] };
          _ensurePainterMetaArrays(newMeta, newGraph);
          if (!Array.isArray(newMeta.deletedPks)) newMeta.deletedPks = [];
          const isVirtual = !!res.virtualO;
          if (isVirtual) {
            // Virtual: additive (no deletions) — reuse helper
            const toDelete = [];
            // No segment deletions; wire additively
            try {
              fillet.applyVirtualFillet(newGraph, newMeta, res, segA, segB);
            } catch (e) {
              return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'virtual fillet failed: ' + e.message }) }], isError: true });
            }
          } else {
            // Connected: truncate both picked legs and insert arc
            const toDelete = [segA, segB].sort((a, b) => b - a);
            for (const idx of toDelete) {
              const pk = newMeta.segOrigPk[idx];
              if (pk != null && !newMeta.deletedPks.includes(pk)) newMeta.deletedPks.push(pk);
              newGraph.segments.splice(idx, 1);
              newMeta.segOrigPk.splice(idx, 1);
            }
            // Ghost-delete O nodes if they become orphaned degree==2 (simple case)
            // Count incident by coordinate to decide if O is shared
            const coordEqual = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
            const countAtCoord = (x, z) => {
              let c = 0;
              for (const sg of g.segments) { const idxs = _segNodeIdxs(sg); for (const ni of idxs) { const n = g.nodes[ni]; if (n && Math.abs(n.x - x) < 1e-6 && Math.abs(n.z - z) < 1e-6) { c++; break; } } }
              for (const rw of g.runways) { for (const ni of [rw.thAIdx, rw.thBIdx]) { const n = g.nodes[ni]; if (n && Math.abs(n.x - x) < 1e-6 && Math.abs(n.z - z) < 1e-6) { c++; break; } } }
              return c;
            };
            const deg = countAtCoord(res.o.x, res.o.z);
            if (deg === 2) {
              const oIdxs = res.duplicate ? [res.oIdxA, res.oIdxB].filter(v => v != null) : (res.oIdx != null ? [res.oIdx] : []);
              for (const oi of oIdxs) {
                const pk = newMeta.nodeOrigPk[oi];
                if (pk != null && !newMeta.deletedPks.includes(pk)) newMeta.deletedPks.push(pk);
              }
            }
            // Create truncated legs far->T
            const base = newGraph.nodes.length;
            for (const pt of res.arcPoints) { newGraph.nodes.push({ x: pt.x, z: pt.z, type: 2, flags: 0 }); newMeta.nodeOrigPk.push(null); }
            const idxT1 = base, idxT2 = base + res.arcPoints.length - 1;
            const segAOrig = g.segments[segA], segBOrig = g.segments[segB];
            const aFlags = segAOrig.flags ?? 2, bFlags = segBOrig.flags ?? 2;
            const aName = segAOrig.name, bName = segBOrig.name;
            const p1Idx = res.p1Idx, p2Idx = res.p2Idx;
            // Need to map p1/p2 original node indices to still-valid ones? For degree==2 O deletion they are distinct from O, so safe.
            // For deg>2 with duplicate O nodes, the far endpoints remain.
            newGraph.segments.push({ aIdx: p1Idx, bIdx: idxT1, nodeIdxs: [p1Idx, idxT1], flags: aFlags, directed: false, ...(aName ? { name: aName } : {}) }); newMeta.segOrigPk.push(null);
            newGraph.segments.push({ aIdx: p2Idx, bIdx: idxT2, nodeIdxs: [p2Idx, idxT2], flags: bFlags, directed: false, ...(bName ? { name: bName } : {}) }); newMeta.segOrigPk.push(null);
            // Arc segment
            const arcIdxs = []; for (let i = 0; i < res.arcPoints.length; i++) arcIdxs.push(idxT1 + i);
            newGraph.segments.push({ aIdx: idxT1, bIdx: idxT2, nodeIdxs: arcIdxs, flags: 2, directed: false }); newMeta.segOrigPk.push(null);
          }
          // Ghost invariance repair (re-point new entities away from ghost nodes)
          if (fillet.repairGhostRefs) {
            try { fillet.repairGhostRefs(newGraph, newMeta); } catch (_) {}
          }
          const hist = _pushPainterHistory(s);
          pushStoreUpdate({ groundPainterGraph: newGraph, groundPainterMeta: newMeta, ...hist, groundPainterHasEdited: true });
          result = { success: true, virtual: isVirtual, radius: res.rEff, center: res.center, t1: res.t1, t2: res.t2 };
          break;
        }
        case 'delete_ground_objects': {
          const s = await readStoreState();
          const g = s.groundPainterGraph;
          const m = s.groundPainterMeta;
          if (!g) return respond({ content: [{ type: 'text', text: JSON.stringify(_groundPainterNotReady()) }], isError: true });
          const target = args.target;
          if (!target || typeof target.x !== 'number' || typeof target.z !== 'number') return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'target {x,z} required' }) }], isError: true });
          const TH = typeof args.threshold === 'number' ? args.threshold : 0.6;
          const TH_STAND = 0.7;
          let best = null; let bestDist = Infinity;
          const consider = (kind, idx, dist) => { if (dist <= TH && dist < bestDist) { bestDist = dist; best = { kind, idx }; } };
          const considerStand = (idx, dist) => { if (dist <= TH_STAND && dist < bestDist) { bestDist = dist; best = { kind: 'stand', idx }; } };
          // Stands: nose prioritized
          for (let i = 0; i < (g.stands || []).length; i++) {
            const st = g.stands[i];
            const n = g.nodes[st.noseIdx]; if (n) { const d = Math.hypot(target.x - n.x, target.z - n.z); considerStand(i, d); }
            const t = g.nodes[st.tailIdx]; if (t) { const d = Math.hypot(target.x - t.x, target.z - t.z); considerStand(i, d * 1.1); }
          }
          // Segments (skip runway pavement strips by name)
          const runwayStripNames = new Set((g.runways || []).map((r) => r.physicalName));
          for (let i = 0; i < (g.segments || []).length; i++) {
            const sg = g.segments[i];
            if (sg.name && runwayStripNames.has(sg.name)) continue;
            const pts = _segNodeIdxs(sg).map((ni) => g.nodes[ni]).filter(Boolean);
            if (pts.length < 2) continue;
            const d = _distToPoly(target.x, target.z, pts);
            consider('segment', i, d);
          }
          for (let i = 0; i < (g.runways || []).length; i++) {
            const rw = g.runways[i];
            const a = g.nodes[rw.thAIdx], b = g.nodes[rw.thBIdx];
            if (!a || !b) continue;
            const d = _distToSeg(target.x, target.z, a.x, a.z, b.x, b.z);
            const halfW = (rw.width || 0.50) / 2;
            consider('runway', i, Math.max(0, d - halfW * 0.5));
          }
          for (let i = 0; i < (g.areas || []).length; i++) {
            const ar = g.areas[i];
            const pts = (ar.points || []);
            if (pts.length < 3) continue;
            const inside = _pointInPoly(target.x, target.z, pts);
            const edge = _minEdgeDist(target.x, target.z, pts);
            let cost = Infinity;
            if (ar.areaType === 0) { if (edge <= TH) cost = 100 + edge; }
            else if (ar.areaType === 2) { if (inside || edge <= TH) cost = inside ? 0 : edge; }
            else { if (inside || edge <= TH) cost = inside ? 1 : edge + 1; }
            if (cost < bestDist) { bestDist = cost; best = { kind: 'area', idx: i }; }
          }
          if (!best) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No object within threshold ' + TH }) }], isError: true });
          // Perform delete with meta handling (mirrors GroundPainter deleteSelected for single)
          const newGraph = _clone(g);
          const newMeta = _clone(m) || { nodeOrigPk: [], segOrigPk: [], runwayOrigPk: [], areaOrigId: [], standOrigPk: [], deletedPks: [], deletedAreaIds: [], runwayPavement: [], runwayOrigInfo: [] };
          _ensurePainterMetaArrays(newMeta, newGraph);
          const markDeletedPk = (pk) => { if (pk != null && !newMeta.deletedPks.includes(pk)) newMeta.deletedPks.push(pk); };
          // Orphan GC helper (collect orphan node indices and splice descending)
          const doOrphanGC = (candidateNodes) => {
            const orphans = [];
            for (const ni of candidateNodes) {
              if (ni == null || ni < 0) continue;
              let used = false;
              for (const sg of newGraph.segments) { const idxs = _segNodeIdxs(sg); if (idxs.includes(ni)) { used = true; break; } }
              if (used) continue;
              for (const rw of newGraph.runways) { if (rw.thAIdx === ni || rw.thBIdx === ni) { used = true; break; } }
              if (used) continue;
              for (const st of newGraph.stands) { if (st.noseIdx === ni || st.tailIdx === ni) { used = true; break; } if (st.pushbackIdxs && st.pushbackIdxs.includes(ni)) { used = true; break; } }
              if (!used) orphans.push(ni);
            }
            orphans.sort((a, b) => b - a);
            for (const delIdx of orphans) {
              if (newMeta.nodeOrigPk && delIdx < newMeta.nodeOrigPk.length) { const pk = newMeta.nodeOrigPk[delIdx]; if (pk != null) markDeletedPk(pk); }
              newGraph.nodes.splice(delIdx, 1);
              if (newMeta.nodeOrigPk) newMeta.nodeOrigPk.splice(delIdx, 1);
              for (const sg of newGraph.segments) {
                if (sg.nodeIdxs) { for (let i = 0; i < sg.nodeIdxs.length; i++) if (sg.nodeIdxs[i] > delIdx) sg.nodeIdxs[i]--; if (sg.aIdx != null && sg.aIdx > delIdx) sg.aIdx--; if (sg.bIdx != null && sg.bIdx > delIdx) sg.bIdx--; }
                else { if (sg.aIdx != null && sg.aIdx > delIdx) sg.aIdx--; if (sg.bIdx != null && sg.bIdx > delIdx) sg.bIdx--; }
              }
              for (const rw of newGraph.runways) { if (rw.thAIdx > delIdx) rw.thAIdx--; if (rw.thBIdx > delIdx) rw.thBIdx--; }
              for (const st of newGraph.stands) { if (st.noseIdx > delIdx) st.noseIdx--; if (st.tailIdx > delIdx) st.tailIdx--; if (st.pushbackIdxs) for (let i = 0; i < st.pushbackIdxs.length; i++) if (st.pushbackIdxs[i] > delIdx) st.pushbackIdxs[i]--; }
              if (newMeta.runwayPavement) for (const arr of newMeta.runwayPavement) for (let i = 0; i < arr.length; i++) if (arr[i] > delIdx) arr[i]--;
            }
          };
          let deletedKind = best.kind, deletedIdx = best.idx;
          if (best.kind === 'segment') {
            const delSeg = newGraph.segments[best.idx];
            const delNodes = _segNodeIdxs(delSeg);
            const uniq = [...new Set(delNodes.filter(v => v != null))];
            if (newMeta.segOrigPk) { markDeletedPk(newMeta.segOrigPk[best.idx]); newMeta.segOrigPk.splice(best.idx, 1); }
            newGraph.segments.splice(best.idx, 1);
            doOrphanGC(uniq);
          } else if (best.kind === 'runway') {
            if (newMeta.runwayOrigPk) { markDeletedPk(newMeta.runwayOrigPk[best.idx]); newMeta.runwayOrigPk.splice(best.idx, 1); }
            if (newMeta.runwayPavement) newMeta.runwayPavement.splice(best.idx, 1);
            if (newMeta.runwayOrigInfo) newMeta.runwayOrigInfo.splice(best.idx, 1);
            newGraph.runways.splice(best.idx, 1);
          } else if (best.kind === 'area') {
            if (newMeta.areaOrigId) { const id = newMeta.areaOrigId[best.idx]; if (id != null && !newMeta.deletedAreaIds.includes(id)) newMeta.deletedAreaIds.push(id); newMeta.areaOrigId.splice(best.idx, 1); }
            newGraph.areas.splice(best.idx, 1);
          } else if (best.kind === 'stand') {
            if (newMeta.standOrigPk) { markDeletedPk(newMeta.standOrigPk[best.idx]); newMeta.standOrigPk.splice(best.idx, 1); }
            const st = newGraph.stands[best.idx];
            const delNodes = [st.noseIdx, st.tailIdx, ...(st.pushbackIdxs || [])].filter(v => v != null);
            newGraph.stands.splice(best.idx, 1);
            doOrphanGC(delNodes);
          }
          const hist = _pushPainterHistory(s);
          pushStoreUpdate({ groundPainterGraph: newGraph, groundPainterMeta: newMeta, ...hist, groundPainterHasEdited: true });
          result = { success: true, deleted: { kind: deletedKind, idx: deletedIdx }, remaining: { nodes: newGraph.nodes.length, segments: newGraph.segments.length, runways: newGraph.runways.length, areas: newGraph.areas.length, stands: newGraph.stands.length } };
          break;
        }
        case 'delete_all_ground_objects': {
          const s = await readStoreState();
          const g = s.groundPainterGraph;
          const m = s.groundPainterMeta;
          if (!g) return respond({ content: [{ type: 'text', text: JSON.stringify(_groundPainterNotReady()) }], isError: true });
          if (!args.confirm) return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'confirm:true required' }) }], isError: true });
          const newMeta = _clone(m) || { nodeOrigPk: [], segOrigPk: [], runwayOrigPk: [], areaOrigId: [], standOrigPk: [], deletedPks: [], deletedAreaIds: [], runwayPavement: [], runwayOrigInfo: [] };
          _ensurePainterMetaArrays(newMeta, g);
          // Record all surviving PKs as deleted so patchSceneryBlob drops them
          if (newMeta.nodeOrigPk) for (const pk of newMeta.nodeOrigPk) if (pk != null && !newMeta.deletedPks.includes(pk)) newMeta.deletedPks.push(pk);
          if (newMeta.segOrigPk) for (const pk of newMeta.segOrigPk) if (pk != null && !newMeta.deletedPks.includes(pk)) newMeta.deletedPks.push(pk);
          if (newMeta.runwayOrigPk) for (const pk of newMeta.runwayOrigPk) if (pk != null && !newMeta.deletedPks.includes(pk)) newMeta.deletedPks.push(pk);
          if (newMeta.standOrigPk) for (const pk of newMeta.standOrigPk) if (pk != null && !newMeta.deletedPks.includes(pk)) newMeta.deletedPks.push(pk);
          if (newMeta.areaOrigId) for (const id of newMeta.areaOrigId) if (id != null && !newMeta.deletedAreaIds.includes(id)) newMeta.deletedAreaIds.push(id);
          const hist = _pushPainterHistory(s);
          pushStoreUpdate({ groundPainterGraph: { nodes: [], segments: [], runways: [], areas: [], stands: [] }, groundPainterMeta: { ...newMeta, nodeOrigPk: [], segOrigPk: [], runwayOrigPk: [], areaOrigId: [], standOrigPk: [], runwayPavement: [], runwayOrigInfo: [] }, ...hist, groundPainterHasEdited: true });
          result = { success: true, cleared: true };
          break;
        }
        case 'undo_ground_painter': {
          const s = await readStoreState();
          if (!s.groundPainterHistory) { result = { success: true, undone: false }; break; }
          const restore = { groundPainterGraph: s.groundPainterHistory, groundPainterHistory: null, groundPainterHasEdited: true };
          if (s.groundPainterMetaHistory) { restore.groundPainterMeta = s.groundPainterMetaHistory; restore.groundPainterMetaHistory = null; }
          pushStoreUpdate(restore);
          result = { success: true, undone: true };
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
              // maxTime = scenario end + SCENARIO_END_GRACE_MIN, the effective validation bound
              timeRules: { minTime: state._configStartTime || null, maxTime: (state._configEndTime && !isNaN(parseTimeSeconds(state._configEndTime))) ? formatTimeSeconds(parseTimeSeconds(state._configEndTime) + SCENARIO_END_GRACE_SEC) : null, timeOrderArrival: 'LandingTime < InBlockTime', timeOrderDeparture: 'OffBlockTime < TakeoffTime', format: 'HH:MM:SS' },
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

        case 'send_voice_command': {
          const { transcript } = args;
          if (!transcript || !String(transcript).trim()) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'transcript is required' }, null, 2) }], isError: true });
          }
          // Same pipeline as the PTT mic path (FlightStripsWindow dispatch effect):
          // parse against the LIVE UDP aircraft list, gate on the approach channel,
          // send each command as a 0x00E7 patch frame. Runs in the main process, so
          // console.log here IS the npm terminal log.
          const { getUdpAircraftState, sendCommand } = require('./udp_listener');
          const { buildPatchPayload } = require('./patchFrame');
          const { parseVoiceTranscript } = await import('../src/components/MapWindows/voiceTranscriptParser.js');

          const { aircraft } = getUdpAircraftState();
          if (!aircraft || !aircraft.length) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'no live aircraft telemetry — is the game running with the BepInEx plugin?' }, null, 2) }], isError: true });
          }

          // Waypoint target set for 'fly direct to X' — from the airport
          // cache (same source as collect-values._airwayNodes).
          const state = await readStoreState();
          const cache = getAirportCache ? getAirportCache() : null;
          const ad = cache && state.currentAirport ? cache[state.currentAirport]?.approachData : null;
          const waypoints = (ad && Array.isArray(ad.airwayNodes) ? ad.airwayNodes : [])
            .map((n) => ({ name: n.name, x: n.x, z: n.z }));

          const text = String(transcript).trim();
          const r = parseVoiceTranscript(text, aircraft, waypoints);
          console.log('[VOICE-PARSE]', JSON.stringify(text), 'ok=' + r.ok,
            'callsign=' + r.callsign,
            'a/c=' + (r.aircraft?.callSign ?? '-') + ' seat=' + (r.aircraft?.controlSeat ?? '-'),
            'wps=' + waypoints.length,
            'commands=' + JSON.stringify(r.commands),
            'notices=' + JSON.stringify(r.notices),
            'rendered=' + JSON.stringify(r.renderedLine),
            'reason=' + (r.reason ?? '-'));

          if (!r.ok) {
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'no aircraft matched', transcript: text }, null, 2) }], isError: true });
          }
          if (r.aircraft.controlSeat !== CHANNEL_TYPE_APPROACH) {
            console.log('[VOICE-DISPATCH] BLOCKED', r.aircraft.callSign, 'controlSeat=' + r.aircraft.controlSeat, '(approach=5) — no frames sent');
            return respond({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: `not on approach channel (controlSeat ${r.aircraft.controlSeat}, approach=5) — no frames sent`, callsign: r.aircraft.callSign }, null, 2) }], isError: true });
          }
          for (const c of r.commands) {
            sendCommand(0x00E7, buildPatchPayload(c.payload));
          }
          result = {
            success: true,
            callsign: r.callsign,
            renderedLine: r.renderedLine,
            sent: r.commands.map(c => ({ type: c.type, label: c.label })),
            notices: r.notices,
            aircraft: { callSign: r.aircraft.callSign, controlSeat: r.aircraft.controlSeat },
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
