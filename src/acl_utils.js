/**
 * ACL utility functions — enrichment, scanning, sorting, audio metadata.
 */
const fs = require('fs');
const path = require('path');
const { DROPDOWN_FIELDS } = require('./constants');
const { _parseWorldStateData, _extractFlightsFromWorldState } = require('./acl_world_state');
const { _parseSceneryData } = require('./acl_scenery');
const { _parseWorldStateFlightPlans } = require('./acl_flight_plans');

// ─── Enrich CSV flights from ACL source ───────────────────────

function _enrichFlightsFromSource(csvFlights, aclFlights) {
  const aclByCs = {};
  for (const a of aclFlights) {
    const cs = (a.CallSign || '').trim();
    if (cs) aclByCs[cs] = a;
  }
  for (const c of csvFlights) {
    const cs = (c.CallSign || '').trim();
    const acl = aclByCs[cs];
    if (!acl) continue;
    if (acl._Registration && !c._Registration) {
      c._Registration = acl._Registration;
    }
    if (acl.AirlineName && !(c.AirlineName || '').trim()) {
      c.AirlineName = acl.AirlineName;
    }
    if (acl.Voice && !(c.Voice || '').trim()) c.Voice = acl.Voice;
    if (acl.Language && !(c.Language || '').trim()) c.Language = acl.Language;
    if (acl._wsGuid) c._wsGuid = acl._wsGuid;
    // Copy time fields from ACL when CSV doesn't have them
    for (const f of ['LandingTime', 'OffBlockTime', 'TakeoffTime', 'InBlockTime']) {
      if (!c[f] && acl[f]) c[f] = acl[f];
    }
  }
}

// ─── Sort flights chronologically ─────────────────────────────

function sortFlightsChronologically(flights) {
  return flights.slice().sort((a, b) => {
    const ta = (a.LandingTime || a.OffBlockTime || '99:99').trim();
    const tb = (b.LandingTime || b.OffBlockTime || '99:99').trim();
    return ta.localeCompare(tb);
  });
}

// ─── Collect unique dropdown values from ACL files ────────────

function collectUniqueValues(aclPaths) {
  const values = {};
  for (const field of DROPDOWN_FIELDS) values[field] = new Set();

  const airlineAircraft = new Map();
  const aircraftAirline = new Map();
  const regMap = new Map();

  for (const aclPath of aclPaths) {
    const text = fs.readFileSync(aclPath, 'utf-8');
    let flights;
    const fpResult = _parseWorldStateFlightPlans(text);
    if (fpResult && fpResult.flights && fpResult.flights.length > 0) {
      flights = fpResult.flights;
    } else {
      const wsData = _parseWorldStateData(text);
      const sceneryMaps = _parseSceneryData(text);
      flights = _extractFlightsFromWorldState(wsData, text, sceneryMaps);
    }
    if (!flights || flights.length === 0) continue;
    for (const fl of flights) {
      for (const field of DROPDOWN_FIELDS) {
        if (field === 'AirlineCode') {
          const code = (fl.CallSign || '').trim().substring(0, 3);
          if (code) values[field].add(code);
        } else if (field === 'Registration') {
          const reg = fl._Registration || fl.Registration || '';
          if (reg) values[field].add(reg);
        } else if (fl[field] && fl[field].trim()) {
          values[field].add(fl[field].trim());
        }
      }
      const acCode = (fl.CallSign || '').trim().substring(0, 3);
      const acType = (fl.AircraftType || '').trim();
      if (acCode && acType) {
        if (!airlineAircraft.has(acCode)) airlineAircraft.set(acCode, new Set());
        airlineAircraft.get(acCode).add(acType);
        if (!aircraftAirline.has(acType)) aircraftAirline.set(acType, new Set());
        aircraftAirline.get(acType).add(acCode);
      }
      const reg = (fl._Registration || fl.Registration || '').trim();
      if (acCode && acType && reg) {
        const key = acCode + '|' + acType;
        if (!regMap.has(key)) regMap.set(key, new Set());
        regMap.get(key).add(reg);
      }
    }
  }
  const result = {};
  for (const [key, set] of Object.entries(values)) {
    const arr = [...set];
    const allNumeric = arr.every(v => /^\d+(\.\d+)?$/.test(v));
    if (allNumeric) {
      arr.sort((a, b) => parseFloat(a) - parseFloat(b));
    } else {
      arr.sort((a, b) => a.localeCompare(b));
    }
    result[key] = arr;
  }
  result._compat = { airlineToAircraft: {}, aircraftToAirline: {} };
  for (const [k, v] of airlineAircraft) {
    result._compat.airlineToAircraft[k] = [...v].sort();
  }
  for (const [k, v] of aircraftAirline) {
    result._compat.aircraftToAirline[k] = [...v].sort();
  }
  result._registrationMap = {};
  for (const [key, set] of regMap) {
    result._registrationMap[key] = [...set].sort();
  }
  return result;
}

// ─── Get basic file info without deep parsing ─────────────────

function getFileInfo(aclPath) {
  try {
    const stat = fs.statSync(aclPath);
    const text = fs.readFileSync(aclPath, 'utf-8');
    let flights;
    let error = null;
    const fpResult = _parseWorldStateFlightPlans(text);
    if (fpResult && fpResult.flights && fpResult.flights.length > 0) {
      flights = fpResult.flights;
    } else {
      const wsData = _parseWorldStateData(text);
      const sceneryMaps = _parseSceneryData(text);
      flights = _extractFlightsFromWorldState(wsData, text, sceneryMaps);
    }
    if (!flights || flights.length === 0) {
      error = 'No WorldState flight data';
    }
    if (error) return { error, filename: path.basename(aclPath), size: stat.size };

    let arrivals = 0, departures = 0;
    let earliestTime = null;
    for (const fl of flights) {
      if ((fl.LandingTime || '').trim()) arrivals++;
      else if ((fl.OffBlockTime || '').trim()) departures++;
      for (const field of ['LandingTime', 'OffBlockTime']) {
        const t = fl[field];
        if (t && (!earliestTime || t < earliestTime)) earliestTime = t;
      }
    }
    return {
      filename: path.basename(aclPath),
      path: aclPath,
      size: stat.size,
      flightCount: flights.length,
      arrivals,
      departures,
      earliestTime,
    };
  } catch (err) {
    return { error: err.message, filename: path.basename(aclPath), size: 0 };
  }
}

// ─── Audio callsign loading ───────────────────────────────────

function loadAudioCallsigns(jsonPath) {
  const empty = { byAirline: {}, allCallsigns: [], allAirlines: [] };
  if (!fs.existsSync(jsonPath)) return empty;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const clips = (data.audioClips || []).filter(c => (c.types || []).includes('AircraftCallSign'));
    const byAirline = {};
    const allCallsigns = [];
    for (const clip of clips) {
      const name = (clip.name || '').trim();
      if (!name) continue;
      allCallsigns.push(name);
      const m = name.match(/^([A-Z]{3})(\S+)/);
      if (m) {
        const code = m[1];
        const num = m[2];
        if (!byAirline[code]) byAirline[code] = [];
        byAirline[code].push(num);
      }
    }
    for (const code of Object.keys(byAirline)) {
      byAirline[code].sort((a, b) => {
        const na = parseInt(a, 10), nb = parseInt(b, 10);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });
    }
    const allAirlines = Object.keys(byAirline).sort();
    return { byAirline, allCallsigns, allAirlines };
  } catch (_) {
    return empty;
  }
}

// ─── Merge audio callsign dictionaries ────────────────────────

function mergeAudioCallsigns(primary, secondary) {
  if (!primary) primary = { byAirline: {}, allCallsigns: [], allAirlines: [] };
  if (!secondary) secondary = { byAirline: {}, allCallsigns: [], allAirlines: [] };
  const allAirlines = [...new Set([...primary.allAirlines, ...secondary.allAirlines])].sort();
  const byAirline = {};
  for (const code of allAirlines) {
    byAirline[code] = [...new Set([
      ...(primary.byAirline[code] || []), ...(secondary.byAirline[code] || [])
    ])].sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }
  const allCallsigns = [...new Set([...primary.allCallsigns, ...secondary.allCallsigns])].sort();
  return { byAirline, allCallsigns, allAirlines };
}

module.exports = {
  _enrichFlightsFromSource,
  sortFlightsChronologically,
  collectUniqueValues,
  getFileInfo,
  loadAudioCallsigns,
  mergeAudioCallsigns,
};
