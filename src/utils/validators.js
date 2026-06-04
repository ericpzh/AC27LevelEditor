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

export function runTripleValidation(flights, airportValues, currentAirport, audioCallsigns, _earliestTime, _configStartTime, _configEndTime, runwayTimeline) {
  const issues = [];
  const values = airportValues[currentAirport] || {};
  const audioData = audioCallsigns || { byAirline: {}, allCallsigns: [], allAirlines: [] };

  const airlineCodeSet = new Set(audioData.allAirlines || []);
  const validFlightNums = {};
  for (const code of Object.keys(audioData.byAirline || {})) {
    validFlightNums[code] = new Set(audioData.byAirline[code]);
  }
  for (const fl of flights) {
    const ac = (fl.CallSign || '').substring(0, 3);
    const num = (fl.CallSign || '').substring(3);
    if (ac) airlineCodeSet.add(ac);
    if (ac && num) {
      if (!validFlightNums[ac]) validFlightNums[ac] = new Set();
      validFlightNums[ac].add(num);
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

  if (_earliestTime && _configEndTime) {
    // _earliestTime = warm-up end (actual flights begin), _configEndTime = scenario end
    // Both bounds get +10min: 07:00~09:00 → valid range 07:10~09:10
    const etParts = String(_earliestTime).split(':');
    const ceParts = String(_configEndTime).split(':');
    const etH = parseInt(etParts[0], 10), etM = parseInt(etParts[1], 10);
    const ceH = parseInt(ceParts[0], 10), ceM = parseInt(ceParts[1], 10);

    const startTime = Math.floor((etH * 60 + etM + 10) / 60) * 100 + ((etH * 60 + etM + 10) % 60);
    const endTime = Math.floor((ceH * 60 + ceM + 10) / 60) * 100 + ((ceH * 60 + ceM + 10) % 60);

    const startH = Math.floor((etH * 60 + etM + 10) / 60) % 24;
    const startM = (etH * 60 + etM + 10) % 60;
    const startLabel = String(startH).padStart(2, '0') + ':' + String(startM).padStart(2, '0');

    const endH = Math.floor((ceH * 60 + ceM + 10) / 60) % 24;
    const endM = (ceH * 60 + ceM + 10) % 60;
    const endLabel = String(endH).padStart(2, '0') + ':' + String(endM).padStart(2, '0');

    flights.forEach((fl) => {
      for (const col of ['OffBlockTime', 'TakeoffTime', 'LandingTime', 'InBlockTime']) {
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

  const rw = runwayTimeline || { initialRunways: [], timeline: [] };
  if (rw.initialRunways && rw.timeline) {
    const initialRunways = rw.initialRunways || [];
    const changes = rw.timeline || [];
    flights.forEach((fl) => {
      if ((fl.LandingTime || '').trim()) { // only arrivals
        const rwy = fl.Runway;
        if (!rwy) return;
        const checkTime = fl.LandingTime;
        if (!checkTime) return;
        const parts = String(checkTime).split(':');
        if (parts.length < 2) return;
        const checkT = parseInt(parts[0], 10) * 100 + parseInt(parts[1], 10);
        let activeRunways = new Set(initialRunways);
        for (const change of changes) {
          let ct = typeof change.time === 'string' ? parseInt(change.time, 10) : change.time;
          if (ct != null && ct <= checkT) {
            const rwList = change.runways || change.activeRunways || change.Runways || change.changes || [];
            if (rwList.length > 0) activeRunways = new Set(rwList.map(c => typeof c === 'string' ? c : (c.source || c.dest || '')));
          }
        }
        if (activeRunways.size > 0 && !activeRunways.has(rwy)) {
          issues.push(T('val_runway_not_active', { cs: fl.CallSign || '?', time: checkTime, rwy: rwy }));
        }
      }
    });
  }

  return issues;
}
