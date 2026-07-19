import { T } from './i18n.js';
import { FIELD_LABELS, STAND_DEP_BEFORE_ESTIMATE_MIN, STAND_ARR_AFTER_ESTIMATE_MIN, STAND_LANDING_BEFORE_INBLOCK_MIN, STAND_OCCUPANCY_START_OFFSET_MIN, STAND_OCCUPANCY_END_OFFSET_MIN, MINUTES_PER_DAY, VALID_LANGUAGES } from './constants.js';

// ── Stand conflict detection helpers ──

function _toMinutes(timeStr) {
  const p = String(timeStr).split(':');
  return parseInt(p[0], 10) * 60 + (parseInt(p[1], 10) || 0);
}

function _addMinutes(timeStr, mins) {
  const total = _toMinutes(timeStr) + mins;
  const wrapped = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function _subtractMinutes(timeStr, mins) {
  const total = _toMinutes(timeStr) - mins;
  const wrapped = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function _computeOccupancyWindow(fl) {
  const landing = (fl.LandingTime || '').trim();
  const inblock = (fl.InBlockTime || '').trim();
  const offblock = (fl.OffBlockTime || '').trim();
  const takeoff = (fl.TakeoffTime || '').trim();

  // Start: when the plane claims the stand.
  // The game allocates from landing time for arrivals — the stand is reserved
  // from touchdown, not from inblock.  For departures, estimate ~20 min before offblock.
  let startStr = null;
  if (landing) {
    startStr = landing.substring(0, 5);
  } else if (inblock) {
    // Arrival without explicit landing: estimate landing ~5 min before inblock
    startStr = _subtractMinutes(inblock.substring(0, 5), 5);
  } else if (offblock) {
    startStr = _subtractMinutes(offblock.substring(0, 5), 20);
  }

  // End: when the plane physically vacates the stand
  let endStr = null;
  if (offblock) {
    endStr = offblock.substring(0, 5);
  } else if (inblock) {
    endStr = _addMinutes(inblock.substring(0, 5), 20);
  } else if (takeoff) {
    endStr = takeoff.substring(0, 5);
  }

  // Skip if neither boundary is computable
  if (startStr === null && endStr === null) return null;

  // Default a missing boundary with a 20-minute estimate
  if (startStr === null) startStr = _subtractMinutes(endStr, 20);
  if (endStr === null) endStr = _addMinutes(startStr, 20);

  // Skip bad data (computed end <= start)
  if (_toMinutes(endStr) <= _toMinutes(startStr)) return null;

  return { start: _toMinutes(startStr), end: _toMinutes(endStr), startStr, endStr };
}

export function detectStandConflicts(flights) {
  const issues = [];
  const byStand = {};
  flights.forEach((fl) => {
    const stand = (fl.Stand || '').trim();
    if (!stand) return;
    const w = _computeOccupancyWindow(fl);
    if (!w) return;
    if (!byStand[stand]) byStand[stand] = [];
    byStand[stand].push({ fl, window: w });
  });
  const fmtTime = (t) => {
    if (!t) return '??:??:00';
    const s = String(t).trim();
    const p = s.split(':');
    // Take HH:MM from the stored value and normalise to HH:MM:00
    return (p[0] || '00').padStart(2, '0') + ':' + (p[1] || '00').padStart(2, '0') + ':00';
  };

  for (const [stand, entries] of Object.entries(byStand)) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i].window, b = entries[j].window;
        const flA = entries[i].fl, flB = entries[j].fl;
        const obA = (flA.OffBlockTime || '').trim(), obB = (flB.OffBlockTime || '').trim();
        const ldA = (flA.LandingTime || '').trim(), ldB = (flB.LandingTime || '').trim();

        // 1) dep + dep → always a conflict (unique stand per schedule)
        if (obA && obB) {
          issues.push(T('val_stand_conflict', {
            cs1: flA.CallSign || '?', cs2: flB.CallSign || '?', stand,
          }));
          continue;
        }

        // 2) dep + arr → conflict when offblock >= landing (strict bound)
        if (obA && ldB && _toMinutes(obA) >= _toMinutes(ldB)) {
          issues.push(T('val_stand_conflict_dep_arr', {
            cs1: flA.CallSign || '?', cs2: flB.CallSign || '?', stand,
            cs_dep: flA.CallSign || '?', cs_arr: flB.CallSign || '?',
            offblock: fmtTime(obA), landing: fmtTime(ldB),
          }));
          continue;
        }
        if (obB && ldA && _toMinutes(obB) >= _toMinutes(ldA)) {
          issues.push(T('val_stand_conflict_dep_arr', {
            cs1: flB.CallSign || '?', cs2: flA.CallSign || '?', stand,
            cs_dep: flB.CallSign || '?', cs_arr: flA.CallSign || '?',
            offblock: fmtTime(obB), landing: fmtTime(ldA),
          }));
          continue;
        }

        // Note: arr + arr stand overlap is NOT enforced by the game,
        // so we intentionally skip that check here.
      }
    }
  }
  return issues;
}

export function detectDuplicateRegistrations(flights) {
  const issues = [];
  const byReg = {};
  flights.forEach((fl) => {
    const reg = (fl._Registration || fl.Registration || '').trim();
    if (!reg) return;
    if (!byReg[reg]) byReg[reg] = [];
    byReg[reg].push(fl);
  });

  for (const [reg, regFlights] of Object.entries(byReg)) {
    const deps = [];
    const arrs = [];
    for (const fl of regFlights) {
      const isArrival = (fl.isDeparture === false) ||
        (((fl.LandingTime || '').trim() && !(fl.OffBlockTime || '').trim()));
      if (isArrival) arrs.push(fl);
      else deps.push(fl);
    }
    if (deps.length > 1) {
      issues.push(T('val_duplicate_registration_dep', {
        reg, cs1: deps[0].CallSign || '?', cs2: deps[1].CallSign || '?',
      }));
    }
    if (arrs.length > 1) {
      issues.push(T('val_duplicate_registration_arr', {
        reg, cs1: arrs[0].CallSign || '?', cs2: arrs[1].CallSign || '?',
      }));
    }
  }
  return issues;
}

export function validateCallsigns(flights) {
  const seen = new Map();
  const dupes = [];
  flights.forEach((fl) => {
    const cs = (fl.CallSign || '').trim();
    if (!cs) return;
    if (seen.has(cs)) { if (!dupes.includes(cs)) dupes.push(cs); }
    else seen.set(cs, 1);
  });
  return dupes;
}

export function runTripleValidation(flights, airportValues, currentAirport, audioCallsigns, _saveSec, _configStartTime, _configEndTime, runwayTimeline, isV4) {
  const issues = [];
  const values = airportValues[currentAirport] || {};
  const audioData = audioCallsigns || { byAirline: {}, allCallsigns: [], allAirlines: [] };

  const airlineCodeSet = new Set(audioData.allAirlines || []);
  const validFlightNums = {};
  // Canonical flight numbers from root scan cache (audio + ALL .acl files merged)
  const canonByAirline = values._flightNums || {};
  for (const [code, nums] of Object.entries(canonByAirline)) {
    airlineCodeSet.add(code);
    validFlightNums[code] = new Set(nums);
  }
  // Fallback: audio callsigns (if cache hasn't been built yet)
  for (const code of Object.keys(audioData.byAirline || {})) {
    airlineCodeSet.add(code);
    if (!validFlightNums[code]) validFlightNums[code] = new Set();
    for (const n of (audioData.byAirline[code] || [])) {
      validFlightNums[code].add(n);
    }
  }
  const validSets = {
    AirlineCode: airlineCodeSet,
    Stand: new Set(values.Stand || []),
    Runway: new Set(values.Runway || []),
    AircraftType: new Set(values.AircraftType || []),
    Voice: new Set(values.Voice || []),
    Language: VALID_LANGUAGES,
  };

  flights.forEach((fl) => {
    const airlineCode = (fl.CallSign || '').substring(0, 3);
    if (airlineCode && !validSets.AirlineCode.has(airlineCode)) {
      issues.push(T('val_airline_not_in_whitelist', { cs: fl.CallSign || '?', code: airlineCode }));
    }
    const flightNum = (fl.CallSign || '').substring(3);
    if (airlineCode && flightNum) {
      const vNums = validFlightNums[airlineCode];
      if (vNums && vNums.size > 0 && !vNums.has(flightNum)) {
        issues.push(T('val_flightnum_not_valid', { cs: fl.CallSign || '?', num: flightNum, code: airlineCode }));
      }
    }
    for (const col of ['Stand', 'Runway', 'AircraftType', 'Voice', 'Language']) {
      const val = fl[col];
      if (val && validSets[col] && validSets[col].size > 0 && !validSets[col].has(val)) {
        issues.push(T('val_field_not_in_options', { cs: fl.CallSign || '?', field: T('field_' + col) || FIELD_LABELS[col] || col, val: val }));
      }
    }
  });

  // STAR/runway combination validation — flag flights where the assigned
  // STAR is not valid for the assigned runway according to scenery data.
  const starRunwayMap = values._starRunwayMap || {};
  if (Object.keys(starRunwayMap).length > 0) {
    flights.forEach((fl) => {
      const runway = (fl.Runway || '').trim();
      const airway = (fl.Airway || '').trim();
      if (runway && airway) {
        const validRunways = starRunwayMap[airway] || [];
        if (validRunways.length > 0 && !validRunways.includes(runway)) {
          issues.push(T('val_star_runway_invalid', {
            cs: fl.CallSign || '?',
            star: airway,
            runway: runway,
          }));
        }
      }
    });
  }

  if (_saveSec != null && _configEndTime) {
    // _saveSec = scenario snapshot time (warmup end), _configEndTime = scenario end
    // Only OffBlockTime and LandingTime are bounded; InBlockTime and TakeoffTime are free
    const ceParts = String(_configEndTime).split(':');
    const ceH = parseInt(ceParts[0], 10), ceM = parseInt(ceParts[1], 10);

    const sh = Math.floor(_saveSec / 3600) % 24;
    const sm = Math.floor((_saveSec % 3600) / 60);
    const startTime = sh * 100 + sm;
    const startLabel = String(sh).padStart(2, '0') + ':' + String(sm).padStart(2, '0');
    const endTime = ceH * 100 + ceM;
    const endLabel = String(ceH).padStart(2, '0') + ':' + String(ceM).padStart(2, '0');

    flights.forEach((fl) => {
      for (const col of ['OffBlockTime', 'LandingTime']) {
        const timeVal = fl[col];
        if (!timeVal) continue;
        const parts = String(timeVal).split(':');
        if (parts.length < 2) continue;
        const t = parseInt(parts[0], 10) * 100 + parseInt(parts[1], 10);
        if (t < startTime || t > endTime) {
          let hint = '';
          if (t < startTime && t > endTime) hint = '≥ ' + startLabel + ' / ≤ ' + endLabel;
          else if (t < startTime) hint = '≥ ' + startLabel;
          else hint = '≤ ' + endLabel;
          issues.push(T('val_time_out_of_range', { cs: fl.CallSign || '?', field: T('field_' + col) || FIELD_LABELS[col] || col, time: timeVal, hint: hint }));
        }
      }
    });
  }

  // Time order validation (skipped for v4 — InBlockTime/TakeoffTime are always 0/unset)
  if (!isV4) {
    flights.forEach((fl) => {
      const landing = (fl.LandingTime || '').trim(), inblock = (fl.InBlockTime || '').trim();
      if (landing && inblock && inblock <= landing) {
        issues.push(T('val_inblock_after_landing', { cs: fl.CallSign || '?', ib: inblock, ld: landing }));
      }
      const offblock = (fl.OffBlockTime || '').trim(), takeoff = (fl.TakeoffTime || '').trim();
      if (offblock && takeoff && offblock >= takeoff) {
        issues.push(T('val_offblock_before_takeoff', { cs: fl.CallSign || '?', ob: offblock, to: takeoff }));
      }
    });
  }

  // Runway timeline validation
  if (_configStartTime && _configEndTime && runwayTimeline && runwayTimeline.timeline) {
    const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
    const startMin = toMin(_configStartTime), endMin = toMin(_configEndTime);
    runwayTimeline.timeline.forEach((entry, i) => {
      if (!entry.time) return;
      const t = toMin(entry.time);
      if (t <= startMin || t >= endMin) {
        issues.push(T('val_runway_change_bounds', { i: i + 1, time: entry.time, min: _configStartTime, max: _configEndTime }));
      }
    });
  }

  // Stand conflict detection
  issues.push(...detectStandConflicts(flights));

  // Duplicate registration detection
  issues.push(...detectDuplicateRegistrations(flights));

  return issues;
}
