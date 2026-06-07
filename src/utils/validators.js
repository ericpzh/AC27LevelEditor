import { T } from './i18n';
import { FIELD_LABELS } from './constants';

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

export function runTripleValidation(flights, airportValues, currentAirport, audioCallsigns, _saveSec, _configStartTime, _configEndTime, runwayTimeline) {
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
    Language: new Set(['en', 'zh']),
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

  // Time order validation
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

  return issues;
}
