/**
 * CSV input/output — import, export (game format), value scanning.
 */
const fs = require('fs');
const { FIELDS, DROPDOWN_FIELDS } = require('./constants');
const { timeToTicks } = require('./time_utils');

// ─── CSV import ─────────────────────────────────────────
function importCsvFromFile(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf-8').trim();
  const lines = text.split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].trim().toLowerCase().split(',');
  const colMap = {};
  header.forEach((name, i) => { colMap[name.trim()] = i; });

  const isNewFormat = 'registration' in colMap;
  const flights = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 7) continue;

    const get = (name) => {
      const idx = colMap[name];
      return idx !== undefined && idx < cols.length ? (cols[idx] || '').trim() : '';
    };

    if (isNewFormat) {
      const arrCall = get('arrivalcallsign');
      const depCall = get('departurecallsign');
      const isArrival = !!arrCall;

      const f = {
        CallSign: isArrival ? arrCall : depCall,
        DepartureAirport: isArrival ? get('originairport') : '',
        ArrivalAirport: isArrival ? '' : get('destinationairport'),
        Stand: isArrival ? get('arrivalstand') : get('departurestand'),
        Runway: isArrival ? get('arrivalrunway') : get('departurerunway'),
        LandingTime: isArrival ? get('landingtime') : '',
        InBlockTime: '',
        OffBlockTime: isArrival ? '' : get('offblocktime'),
        TakeoffTime: '',
        AirlineName: get('airline'),
        AircraftType: get('aircrafttype'),
        Airway: isArrival ? get('arrivalstar') : '',
        Voice: get('voice'),
        Language: get('language'),
        PrecedingFlight: '',
        _Registration: get('registration'),
        isDeparture: !isArrival,
      };
      flights.push(f);
    } else {
      const f = {
        CallSign: get('callsign'),
        DepartureAirport: get('departure'),
        ArrivalAirport: get('arrival'),
        Stand: get('stand'),
        Runway: get('runway'),
        OffBlockTime: get('offblocktime'),
        TakeoffTime: get('takeofftime'),
        LandingTime: get('landingtime'),
        InBlockTime: get('inblocktime'),
        AirlineName: get('airline'),
        AircraftType: get('aircrafttype'),
        Airway: get('airway'),
        Voice: get('voice'),
        Language: get('language'),
        PrecedingFlight: get('precedingflight'),
      };
      if ((f.OffBlockTime || '').trim()) f.isDeparture = true;
      else if ((f.LandingTime || '').trim()) f.isDeparture = false;
      flights.push(f);
    }
  }
  return flights;
}

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

// ─── Collect unique values from a single CSV file ───────
function collectUniqueValuesFromCSV(csvPath) {
  console.log('══════════════════════ [CSV-COLLECT] ══════════════════════');
  console.log('[CSV-COLLECT] csvPath:', csvPath);
  console.log('[CSV-COLLECT] exists:', fs.existsSync(csvPath));

  const result = {
    Stand: new Set(), Runway: new Set(),
    DepartureAirport: new Set(), ArrivalAirport: new Set(),
    AircraftType: new Set(), Voice: new Set(), Language: new Set(),
    Registration: new Set(), Airway: new Set(),
    _voiceOptions: new Set(),
  };
  const regMap = new Map();

  if (!fs.existsSync(csvPath)) {
    console.log('[CSV-COLLECT] FILE NOT FOUND, returning empty!');
    return { Stand:[], Runway:[], DepartureAirport:[], ArrivalAirport:[], AircraftType:[], Voice:[], Language:[], Registration:[], Airway:[], _voiceOptions:[], _registrationMap: {} };
  }

  const text = fs.readFileSync(csvPath, 'utf-8');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  console.log('[CSV-COLLECT] total lines:', lines.length);

  const knownFieldsLower = new Set([
    'registration', 'arrivalcallsign', 'departurecallsign', 'callsign',
    'originairport', 'destinationairport', 'departureairport', 'arrivalairport',
    'arrivalstand', 'departurestand', 'stand',
    'arrivalrunway', 'departurerunway', 'runway',
    'arrivalstar', 'airway', 'star',
    'aircrafttype', 'airline', 'airlinename',
    'voice', 'language',
    'landingtime', 'offblocktime', 'takeofftime', 'inblocktime',
  ]);

  let headerIdx = -1;
  let headers = [];
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const row = lines[i];
    const cols = row.split(',').map(c => c.replace(/^"|"$/g, '').trim().toLowerCase());
    const matchCount = cols.filter(c => knownFieldsLower.has(c)).length;
    console.log(`[CSV-COLLECT] header scan row ${i}: cols=${JSON.stringify(cols)} matchCount=${matchCount}`);
    if (matchCount >= 2) {
      headerIdx = i;
      headers = row.split(',').map(c => c.replace(/^"|"$/g, '').trim());
      console.log('[CSV-COLLECT] ✅ HEADER FOUND at row', i, '->', JSON.stringify(headers));
      break;
    }
  }

  if (headerIdx < 0) {
    console.log('[CSV-COLLECT] ❌ NO HEADER FOUND in first 10 rows!');
  }

  const startRow = headerIdx >= 0 ? headerIdx + 1 : 0;
  console.log('[CSV-COLLECT] parsing data rows from index', startRow, 'to', lines.length - 1);

  const keyMap = {
    'stand': 'Stand', 'arrivalstand': 'Stand', 'departurestand': 'Stand',
    'runway': 'Runway', 'arrivalrunway': 'Runway', 'departurerunway': 'Runway',
    'departureairport': 'DepartureAirport', 'originairport': 'DepartureAirport', 'departure': 'DepartureAirport',
    'arrivalairport': 'ArrivalAirport', 'destinationairport': 'ArrivalAirport', 'arrival': 'ArrivalAirport',
    'aircrafttype': 'AircraftType',
    'voice': 'Voice',
    'language': 'Language',
    'registration': 'Registration',
    'airway': 'Airway', 'arrivalstar': 'Airway', 'star': 'Airway',
  };

  const csvCompatAirlineToAircraft = new Map();
  const csvCompatAircraftToAirline = new Map();

  let rowsProcessed = 0;
  for (let i = startRow; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
    if (cols.length < 2) continue;
    rowsProcessed++;

    for (let j = 0; j < cols.length; j++) {
      const val = cols[j];
      if (!val) continue;
      const fieldName = (headers[j] || '').toLowerCase();
      if (keyMap[fieldName]) {
        result[keyMap[fieldName]].add(val);
      }
    }

    const getVal = (name) => {
      const idx = headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
      return idx >= 0 && idx < cols.length ? cols[idx] : '';
    };
    const reg = getVal('registration');
    const airline = getVal('airline');
    const acType = getVal('aircraftType');

    if (reg && airline && acType) {
      const key = airline + '|' + acType;
      if (!regMap.has(key)) regMap.set(key, new Set());
      regMap.get(key).add(reg);
    }
    if (airline && acType) {
      if (!csvCompatAirlineToAircraft.has(airline)) csvCompatAirlineToAircraft.set(airline, new Set());
      csvCompatAirlineToAircraft.get(airline).add(acType);
      if (!csvCompatAircraftToAirline.has(acType)) csvCompatAircraftToAirline.set(acType, new Set());
      csvCompatAircraftToAirline.get(acType).add(airline);
    }
  }
  console.log('[CSV-COLLECT] rows processed:', rowsProcessed);

  const output = {};
  for (const key of Object.keys(result)) {
    if (key === '_voiceOptions') {
      output[key] = [...result[key]].sort((a, b) => a.localeCompare(b));
      continue;
    }
    const arr = [...result[key]];
    const allNumeric = arr.length > 0 && arr.every(v => /^\d+(\.\d+)?$/.test(v));
    if (allNumeric) {
      arr.sort((a, b) => parseFloat(a) - parseFloat(b));
    } else {
      arr.sort((a, b) => a.localeCompare(b));
    }
    output[key] = arr;
  }

  output._registrationMap = {};
  for (const [k, v] of regMap) {
    output._registrationMap[k] = [...v].sort();
  }

  output._compat = { airlineToAircraft: {}, aircraftToAirline: {} };
  for (const [k, v] of csvCompatAirlineToAircraft) {
    output._compat.airlineToAircraft[k] = [...v].sort();
  }
  for (const [k, v] of csvCompatAircraftToAirline) {
    output._compat.aircraftToAirline[k] = [...v].sort();
  }

  console.log('[CSV-COLLECT] ═══ FINAL RESULTS ═══');
  for (const [k, v] of Object.entries(output)) {
    if (k === '_registrationMap') {
      console.log(`[CSV-COLLECT]   ${k}: ${Object.keys(v).length} keys`);
    } else {
      console.log(`[CSV-COLLECT]   ${k} (${v.length}):`, JSON.stringify(v));
    }
  }
  console.log('═════════════════════════════════════════════════════════');

  return output;
}

module.exports = {
  importCsvFromFile, exportCSV, exportGameCSV,
  collectUniqueValuesFromCSV,
};
