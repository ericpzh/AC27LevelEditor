'use strict';

/**
 * GATCARC4 v3 Flight Schedule & Checkpoint Runtime Writer (`src/acl/v3/writers_flights.js`).
 *
 * Rebuilds `StaticData.StaticItems["flight-plan:<REG>"]` from editor `flights`
 * (including zero-flight schedules) and reconciles checkpoint frames (`container.frames`)
 * across `flight-plan:*`, `jetway:*`, `aircraft:*`, `aircraft-animator:aircraft:*`,
 * `singleton:game-event-schedule`, `singleton:scoring-state`, and `RecentMessages`.
 */

const fs = require('fs');
const path = require('path');
const {
  APPROACH_MIN_TTL,
  GRACE_TTL,
  CMD_CONTACT_TOWER,
  DEPARTURE_TAXI_SECONDS,
  ARRIVAL_TAXI_SECONDS,
  TAXI_SPEED,
  POSITIVE_TAXI_ACCEL,
  NEGATIVE_TAXI_ACCEL,
  DYNAMICS_POSITIVE_TAXI_ACCEL,
  DYNAMICS_NEGATIVE_TAXI_ACCEL,
  STATE5_OUTPUT_PROGRESS_RATIO,
  APPROACH_SPEED_MS,
  DEFAULT_AIRPORT_SCALE,
} = require('../constants');
const {
  computePathLength,
  computeApproachCap,
  computePosition,
  computeDirection,
  jetwayKeyStandCandidates,
} = require('../approach');
const {
  _validateStandConflicts,
  GAME_STAND_MIN_GAP_SEC,
} = require('../flight_plans');
const { getSchemaForHash } = require('./schema_registry');
const {
  dictEntries,
  dictGet,
  dictSet,
  dictDelete,
  makePkRef,
  makeReactive,
  makeTypedArray,
  indexDocumentGraph,
  resolveGraphNode,
  unwrapReactive,
  unwrapTypedArray,
  normalizeDocumentGraph,
} = require('./graph');
const {
  Q32_SCALE_NUM,
  GU_TO_METERS,
  KT_TO_MPS,
  UNSET_DATETIME_ISO,
  DEFAULT_BASE_DATE,
  decodeQ32,
  encodeQ32,
  encodeGuToPosition3,
  encodeDirection3,
  parseIsoWallClock,
  formatEditorTimeToIso,
  formatSecondsToIso,
} = require('./q32');
const readers = require('./readers');

const Q32_ONE = Q32_SCALE_NUM; // 4294967296 = 1.0 in Q32.32
const Q32_SLAT_APPROACH = 3221225472; // 0.75 * 2^32

// Built-in fallback table mirroring `StreamingAssets/aircraft_profiles.csv`
// (`wheelBase` in GU where 1 GU = 100 m; `hasDockingDoors` true iff DockingPositions non-empty).
const BUILTIN_AIRCRAFT_PROFILES = new Map([
  ['AIRBUS A-319ceo', { designator: 'A319', wheelBaseGu: 0.111, hasDockingDoors: true }],
  ['AIRBUS A-319neo', { designator: 'A19N', wheelBaseGu: 0.1108, hasDockingDoors: true }],
  ['AIRBUS A-320ceo', { designator: 'A320', wheelBaseGu: 0.1232, hasDockingDoors: true }],
  ['AIRBUS A-320P2F', { designator: 'A320', wheelBaseGu: 0.1232, hasDockingDoors: true }],
  ['AIRBUS A-320neo', { designator: 'A20N', wheelBaseGu: 0.123, hasDockingDoors: true }],
  ['AIRBUS A-321neo', { designator: 'A21N', wheelBaseGu: 0.1649, hasDockingDoors: true }],
  ['AIRBUS A-330-300', { designator: 'A333', wheelBaseGu: 0.2498, hasDockingDoors: true }],
  ['AIRBUS A-350-900', { designator: 'A359', wheelBaseGu: 0.2873, hasDockingDoors: true }],
  ['AIRBUS A-380-800', { designator: 'A388', wheelBaseGu: 0.2973, hasDockingDoors: true }],
  ['BOMBARDIER CRJ700', { designator: 'CRJ7', wheelBaseGu: 0.1488, hasDockingDoors: false }],
  ['BOMBARDIER CRJ900', { designator: 'CRJ9', wheelBaseGu: 0.1727, hasDockingDoors: false }],
  ['BOEING 737 MAX 8', { designator: 'B38M', wheelBaseGu: 0.156, hasDockingDoors: true }],
  ['BOEING 737-800', { designator: 'B738', wheelBaseGu: 0.1566, hasDockingDoors: true }],
  ['BOEING 737-800BCF', { designator: 'B738', wheelBaseGu: 0.1566, hasDockingDoors: true }],
  ['BOEING 747-8I', { designator: 'B748', wheelBaseGu: 0.2971, hasDockingDoors: true }],
  ['BOEING 777-300ER', { designator: 'B77W', wheelBaseGu: 0.3123, hasDockingDoors: true }],
  ['BOEING 787-9', { designator: 'B789', wheelBaseGu: 0.2552, hasDockingDoors: true }],
  ['COMAC C-919', { designator: 'C919', wheelBaseGu: 0.125, hasDockingDoors: true }],
  ['EMBRAER E-JET 170', { designator: 'E170', wheelBaseGu: 0.1045, hasDockingDoors: true }],
  ['EMBRAER E-JET 190', { designator: 'E190', wheelBaseGu: 0.1449, hasDockingDoors: true }],
  ['GULFSTREAM 650', { designator: 'GLF6', wheelBaseGu: 0.1331, hasDockingDoors: false }],
]);

function loadAircraftProfilesForLevel(filePath) {
  const map = new Map(BUILTIN_AIRCRAFT_PROFILES);
  // Also index by designator
  for (const [, prof] of BUILTIN_AIRCRAFT_PROFILES) {
    if (!map.has(prof.designator)) map.set(prof.designator, prof);
  }
  if (!filePath) return map;
  try {
    const csvPath = path.resolve(path.dirname(filePath), '..', '..', '..', 'aircraft_profiles.csv');
    if (!fs.existsSync(csvPath)) return map;
    const lines = fs.readFileSync(csvPath, 'utf-8').split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(',');
      if (cols.length < 9) continue;
      const acType = cols[0].trim();
      const designator = cols[1].trim();
      const wb = parseFloat(cols[5]);
      const dockStr = (cols[8] || '').trim();
      if (!acType || !Number.isFinite(wb)) continue;
      const entry = {
        designator: designator || acType,
        wheelBaseGu: wb,
        hasDockingDoors: dockStr.length > 0,
      };
      map.set(acType, entry);
      if (designator && !map.has(designator)) map.set(designator, entry);
    }
  } catch (_) {}
  return map;
}

function getAircraftProfile(acType, profilesMap, approachCache) {
  const key = String(acType || '').trim();
  if (key && profilesMap.has(key)) {
    return profilesMap.get(key);
  }
  if (key && approachCache) {
    const des = approachCache.designatorMap?.get(key) || key;
    const spec = approachCache.specDB?.get(des) || approachCache.specDB?.get(key);
    if (spec && Number.isFinite(spec.WheelBase)) {
      // In v2 specDB, WheelBase is in GU (< 2.0); if > 2.0 treat as meters and convert to GU
      const wbGu = spec.WheelBase > 2.0 ? spec.WheelBase * 0.01 : spec.WheelBase;
      return {
        designator: spec.Designator || des,
        wheelBaseGu: wbGu,
        hasDockingDoors: Array.isArray(spec.DockingPositions) ? spec.DockingPositions.length > 0 : true,
      };
    }
  }
  return { designator: key || 'B738', wheelBaseGu: 0.1566, hasDockingDoors: true };
}

function timeStrToSeconds(t) {
  if (!t || typeof t !== 'string') return null;
  const s = t.trim();
  if (!s) return null;
  const iso = parseIsoWallClock(s);
  if (iso) return iso.exactSecSinceMidnight;
  const p = s.split(':');
  if (p.length < 2) return null;
  const hh = Number(p[0]);
  const mm = Number(p[1]);
  const ss = p.length >= 3 ? Number(p[2]) : 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null;
  return hh * 3600 + mm * 60 + ss;
}

function isDepartureFlight(fl) {
  if (typeof fl.isDeparture === 'boolean') {
    if (fl.isDeparture && (fl.OffBlockTime || '').trim()) return true;
    if (!fl.isDeparture && (fl.LandingTime || '').trim()) return false;
  }
  if ((fl.OffBlockTime || '').trim() && !(fl.LandingTime || '').trim()) return true;
  if ((fl.LandingTime || '').trim() && !(fl.OffBlockTime || '').trim()) return false;
  return Boolean(fl.isDeparture);
}

function getEffectiveRegistration(fl, fallbackIdx) {
  // If caller explicitly set `fl.Registration` to a different non-empty value than `_Registration`,
  // honor `fl.Registration` (supports both UI edits to `_Registration` and programmatic `Registration` edits).
  const rExplicit = typeof fl.Registration === 'string' ? fl.Registration.trim() : '';
  const rInternal = typeof fl._Registration === 'string' ? fl._Registration.trim() : '';
  if (rExplicit && rInternal && rExplicit !== rInternal) {
    // Check `_fpGuid` to tell which one was original
    const origFromGuid = typeof fl._fpGuid === 'string' && fl._fpGuid.startsWith('flight-plan:')
      ? fl._fpGuid.slice('flight-plan:'.length)
      : '';
    if (rInternal === origFromGuid) return rExplicit;
    if (rExplicit === origFromGuid) return rInternal;
    return rExplicit;
  }
  const chosen = rExplicit || rInternal || String(fl.CallSign || '').trim() || `REG${fallbackIdx + 1}`;
  return chosen;
}

/**
 * Normalize flights in-place for v3 game compatibility (duplicate registrations,
 * docked stand occupancy, arrival separation, empty STAR fill, airline/voice language).
 */
function normalizeV3FlightsForGameCompat(container, flights, { standPool, approachCache, filePath }) {
  if (!Array.isArray(flights) || flights.length === 0) {
    return { renamed: 0, moved: 0, starred: 0, voiced: 0, relanguaged: 0 };
  }
  const result = { renamed: 0, moved: 0, starred: 0, voiced: 0, relanguaged: 0 };

  // Scan latest checkpoint frame for currently docked registrations & flight-plan directions
  const docked = new Map();
  const fpDir = new Map();
  if (Array.isArray(container.frames) && container.frames.length > 0) {
    const lastFrame = container.frames[container.frames.length - 1];
    const schema = getSchemaForHash(container.header.schemaHash);
    const rtIdx = indexDocumentGraph(lastFrame.runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(lastFrame.runtimeData?.RuntimeEntities, rtIdx);
    if (reDict) {
      for (const [k, rawV] of dictEntries(reDict)) {
        if (k.startsWith('jetway:')) {
          const jw = resolveGraphNode(rawV, rtIdx);
          const ac = jw ? resolveGraphNode(unwrapReactive(jw.DockingAircraft, rtIdx), rtIdx) : null;
          const fp = ac ? resolveGraphNode(ac._flightPlan, rtIdx) : null;
          const refStr = fp?.StaticItem?.$ref || '';
          const m = refStr.match(/flight-plan:(.+)$/);
          if (m) {
            const toIso = parseIsoWallClock(fp._departureTakeoffTime);
            docked.set(m[1], { takeoffSec: toIso ? toIso.secSinceMidnight : null });
          }
        } else if (k.startsWith('flight-plan:')) {
          const reg = k.slice('flight-plan:'.length);
          const fp = resolveGraphNode(rawV, rtIdx);
          if (fp) {
            if (fp._departureStand != null || fp._departureRunway != null) fpDir.set(reg, 'D');
            else if (fp._arrivalStand != null || fp._arrivalRunway != null) fpDir.set(reg, 'A');
          }
        }
      }
    }
  }

  // Ensure every flight has a non-empty `_Registration`
  for (let i = 0; i < flights.length; i++) {
    const reg = getEffectiveRegistration(flights[i], i);
    flights[i]._Registration = reg;
    if (flights[i].Registration !== undefined) flights[i].Registration = reg;
  }

  // 1. Deduplicate registrations
  {
    const byReg = new Map();
    const usedRegs = new Set();
    for (const fl of flights) {
      const r = fl._Registration;
      usedRegs.add(r);
      if (!byReg.has(r)) byReg.set(r, []);
      byReg.get(r).push(fl);
    }
    for (const [reg, list] of byReg) {
      if (list.length < 2) continue;
      let winner = null;
      if (docked.has(reg)) winner = list.find((f) => isDepartureFlight(f)) || null;
      if (!winner && fpDir.has(reg)) {
        const wantDep = fpDir.get(reg) === 'D';
        winner = list.find((f) => isDepartureFlight(f) === wantDep) || null;
      }
      if (!winner) winner = list.find((f) => isDepartureFlight(f)) || list[0];
      for (const fl of list) {
        if (fl === winner) continue;
        let newReg = null;
        for (const suffix of 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789') {
          const cand = reg + suffix;
          if (!usedRegs.has(cand)) { newReg = cand; break; }
        }
        if (!newReg) {
          for (let n = 0; n < 1000 && !newReg; n++) {
            const cand = `${reg}X${n}`;
            if (!usedRegs.has(cand)) newReg = cand;
          }
        }
        if (!newReg) continue;
        usedRegs.add(newReg);
        fl._Registration = newReg;
        if (fl.Registration !== undefined) fl.Registration = newReg;
        // Clear _fpGuid so it is treated as a distinct flight, not a rename of `winner`
        fl._fpGuid = '';
        result.renamed++;
      }
    }
  }

  // 2 & 3. Docked-stand occupancy + arrival separation
  {
    const endSec = timeStrToSeconds(container.metaData?.Config?.endTime);
    const standInfo = new Map();
    const dockedByStand = new Map();
    const bestDep = new Map();
    for (const fl of flights) {
      if (!isDepartureFlight(fl)) continue;
      const stand = String(fl.Stand || '').trim();
      const t = timeStrToSeconds(fl.OffBlockTime);
      if (!stand || t == null) continue;
      const ex = bestDep.get(stand);
      if (!ex || t < ex.t) bestDep.set(stand, { fl, t });
    }
    for (const [stand, { fl, t }] of bestDep) {
      const reg = fl._Registration;
      const frameD = docked.get(reg);
      dockedByStand.set(stand, {
        reg,
        offBlockSec: t,
        takeoffSec: fl.TakeoffTime ? timeStrToSeconds(fl.TakeoffTime) : (frameD?.takeoffSec ?? null),
      });
    }

    const standsInUse = new Set(dockedByStand.keys());
    for (const fl of flights) {
      const stand = String(fl.Stand || '').trim();
      if (!stand) continue;
      standsInUse.add(stand);
      if (!standInfo.has(stand)) standInfo.set(stand, { arrs: [], deps: [] });
      if (isDepartureFlight(fl)) {
        const dt = timeStrToSeconds(fl.OffBlockTime);
        if (dt != null) standInfo.get(stand).deps.push({ t: dt });
      }
    }
    if (Array.isArray(standPool)) {
      for (const s of standPool) {
        const v = String(s || '').trim();
        if (v) standsInUse.add(v);
      }
    }
    const candidateStands = [...standsInUse].sort(
      (a, b) => (parseInt(a, 10) || 9999) - (parseInt(b, 10) || 9999) || a.localeCompare(b),
    );

    const DEPARTURE_GRACE_SEC = 30 * 60;
    const dockedViolation = (stand, reg, t) => {
      const dk = dockedByStand.get(stand);
      if (!dk || dk.reg === reg) return false;
      const beyondScenario =
        (dk.offBlockSec != null && endSec != null && dk.offBlockSec > endSec + DEPARTURE_GRACE_SEC) ||
        (dk.takeoffSec != null && endSec != null && dk.takeoffSec > endSec + DEPARTURE_GRACE_SEC);
      if (beyondScenario) return true;
      if (dk.offBlockSec != null && t < dk.offBlockSec) return true;
      return false;
    };
    const arrDepViolation = (stand, t) => {
      const info = standInfo.get(stand);
      if (!info) return 0;
      let n = 0;
      for (const o of info.deps) if (o.t > t) n++;
      return n;
    };
    const arrGapViolationSec = (stand, t) => {
      const info = standInfo.get(stand);
      if (!info) return 0;
      let worst = 0;
      for (const o of info.arrs) {
        const v = GAME_STAND_MIN_GAP_SEC - Math.abs(o.t - t);
        if (v > worst) worst = v;
      }
      return worst;
    };
    const safeForArr = (stand, reg, t) =>
      !dockedViolation(stand, reg, t) && arrDepViolation(stand, t) === 0 && arrGapViolationSec(stand, t) <= 0;

    const arrs = flights.filter((f) => !isDepartureFlight(f));
    arrs.sort((a, b) => (timeStrToSeconds(a.LandingTime) ?? 0) - (timeStrToSeconds(b.LandingTime) ?? 0));
    for (const fl of arrs) {
      const t = timeStrToSeconds(fl.LandingTime);
      const reg = fl._Registration;
      const stand = String(fl.Stand || '').trim();
      if (!stand || t == null) continue;
      if (safeForArr(stand, reg, t)) {
        if (!standInfo.has(stand)) standInfo.set(stand, { arrs: [], deps: [] });
        standInfo.get(stand).arrs.push({ t, reg });
        continue;
      }
      let newStand = null;
      for (const cand of candidateStands) {
        if (safeForArr(cand, reg, t)) { newStand = cand; break; }
      }
      if (newStand === null) {
        let best = null, bestViol = Infinity;
        for (const cand of candidateStands) {
          if (dockedViolation(cand, reg, t) || arrDepViolation(cand, t) > 0) continue;
          const v = arrGapViolationSec(cand, t);
          if (v < bestViol) { bestViol = v; best = cand; }
        }
        newStand = best;
      }
      if (newStand === null) {
        let best = null, bestScore = Infinity;
        for (const cand of candidateStands) {
          if (dockedViolation(cand, reg, t)) continue;
          const score = arrDepViolation(cand, t) * 500 + arrGapViolationSec(cand, t);
          if (score < bestScore) { bestScore = score; best = cand; }
        }
        newStand = best;
      }
      if (newStand === null) {
        if (!standInfo.has(stand)) standInfo.set(stand, { arrs: [], deps: [] });
        standInfo.get(stand).arrs.push({ t, reg });
        continue;
      }
      fl.Stand = newStand;
      result.moved++;
      if (!standInfo.has(newStand)) standInfo.set(newStand, { arrs: [], deps: [] });
      standInfo.get(newStand).arrs.push({ t, reg });
    }
  }

  // 4. Arrival STAR repair (use approachCache.runwayStarMap or container's own Runway.Routes!)
  {
    const rsm = (approachCache && approachCache.runwayStarMap && Object.keys(approachCache.runwayStarMap).length > 0)
      ? approachCache.runwayStarMap
      : readers.readStarRunwayMappings(container).runwayStarMap;
    if (rsm && Object.keys(rsm).length > 0) {
      const arrivalRunways = Object.keys(rsm).sort();
      const starOf = (rwy) => {
        const list = rsm[rwy];
        return Array.isArray(list) && list.length > 0 ? String(list[0]) : null;
      };
      for (const fl of flights) {
        if (isDepartureFlight(fl) || String(fl.Airway || '').trim() !== '') continue;
        const rwy = String(fl.Runway || '').trim();
        let star = rwy ? starOf(rwy) : null;
        if (!star && rwy) {
          const altRwy = arrivalRunways.find((r) => r !== rwy && starOf(r));
          if (altRwy) {
            fl.Runway = altRwy;
            star = starOf(altRwy);
          }
        }
        if (star) {
          fl.Airway = star;
          result.starred++;
        }
      }
    }
  }

  return result;
}

function buildStaticFlightPlanItem(fl, baseDate, prevItem) {
  const reg = fl._Registration;
  const dep = isDepartureFlight(fl);
  const label = String(fl.CallSign || reg || 'unknown').trim();
  const language = String(fl.Language ?? '').trim();
  if (!language) {
    throw new Error(`Flight "${label}" is missing required Language`);
  }
  const voice = String(fl.Voice ?? '').trim();
  if (!voice) {
    throw new Error(`Flight "${label}" is missing required Voice`);
  }

  if (dep) {
    const offBlockIso = formatEditorTimeToIso(fl.OffBlockTime, baseDate);
    const takeoffIso = fl.TakeoffTime ? formatEditorTimeToIso(fl.TakeoffTime, baseDate) : UNSET_DATETIME_ISO;
    return {
      $type: 'ContextCross.Models.FlightPlanStaticItem',
      AircraftType: String(fl.AircraftType || ''),
      AirlineName: String(fl.AirlineName || ''),
      InitialArrival: null,
      InitialDeparture: {
        CallSign: String(fl.CallSign || ''),
        DestinationAirport: String(fl.ArrivalAirport || ''),
        OffBlockTime: offBlockIso,
        Runway: String(fl.Runway || ''),
        Stand: String(fl.Stand || ''),
        TakeoffTime: takeoffIso,
      },
      Language: language,
      Registration: reg,
      Voice: voice,
    };
  }

  const prevActualInBlock = prevItem?.InitialArrival?.ActualInBlockTime || UNSET_DATETIME_ISO;
  const landingIso = formatEditorTimeToIso(fl.LandingTime, baseDate);
  const inBlockIso = fl.InBlockTime ? formatEditorTimeToIso(fl.InBlockTime, baseDate) : UNSET_DATETIME_ISO;
  return {
    $type: 'ContextCross.Models.FlightPlanStaticItem',
    AircraftType: String(fl.AircraftType || ''),
    AirlineName: String(fl.AirlineName || ''),
    InitialArrival: {
      ActualInBlockTime: prevActualInBlock,
      CallSign: String(fl.CallSign || ''),
      InBlockTime: inBlockIso,
      LandingTime: landingIso,
      OriginAirport: String(fl.DepartureAirport || ''),
      Runway: String(fl.Runway || ''),
      STAR: String(fl.Airway || ''),
      Stand: String(fl.Stand || ''),
    },
    InitialDeparture: null,
    Language: language,
    Registration: reg,
    Voice: voice,
  };
}

function scheduleSpatialSignature(staticItem) {
  if (!staticItem) return '';
  if (staticItem.InitialDeparture) {
    const d = staticItem.InitialDeparture;
    return `D|${staticItem.AircraftType}|${d.Stand}|${d.Runway}|${d.OffBlockTime}|${d.TakeoffTime}`;
  }
  if (staticItem.InitialArrival) {
    const a = staticItem.InitialArrival;
    return `A|${staticItem.AircraftType}|${a.Stand}|${a.Runway}|${a.STAR}|${a.LandingTime}|${a.InBlockTime}`;
  }
  return '';
}

function buildStandMetersMap(staticData, sIdx) {
  const map = new Map(); // standIdent -> { noseM: [x,y,z], tailM: [x,y,z] }
  const pkDict = resolveGraphNode(staticData?.PKStaticEntities, sIdx);
  if (!pkDict) return map;
  for (const [pk, rawVal] of dictEntries(pkDict)) {
    if (!pk.startsWith('stand:')) continue;
    const st = resolveGraphNode(rawVal, sIdx);
    if (!st) continue;
    const noseNode = resolveGraphNode(st.NosePosition, sIdx);
    const tailNode = resolveGraphNode(st.TailPosition, sIdx);
    const nTuple = noseNode ? unwrapReactive(noseNode.ReactivePosition, sIdx) : null;
    const tTuple = tailNode ? unwrapReactive(tailNode.ReactivePosition, sIdx) : null;
    if (!Array.isArray(nTuple) || !Array.isArray(tTuple)) continue;
    const entry = {
      noseM: [decodeQ32(nTuple[0]), decodeQ32(nTuple[1]), decodeQ32(nTuple[2])],
      tailM: [decodeQ32(tTuple[0]), decodeQ32(tTuple[1]), decodeQ32(tTuple[2])],
    };
    const keys = new Set([
      String(st.Identifier || '').trim(),
      String(st.Name || '').trim(),
      pk.slice('stand:'.length).trim(),
    ]);
    for (const k of keys) {
      if (!k) continue;
      map.set(k, entry);
      if (/^\d+$/.test(k)) {
        map.set(String(parseInt(k, 10)), entry);
        map.set(k.padStart(2, '0'), entry);
      }
    }
  }
  return map;
}

function buildJetwayStandLookup(staticData, sIdx) {
  const jwToStands = new Map(); // "jetway:01" -> string[]
  const siDict = resolveGraphNode(staticData?.StaticItems, sIdx);
  if (!siDict) return jwToStands;
  for (const [pk, rawVal] of dictEntries(siDict)) {
    if (!pk.startsWith('jetway:')) continue;
    const jw = resolveGraphNode(rawVal, sIdx);
    const stands = [];
    if (jw && jw.Stands) {
      for (const sRef of unwrapTypedArray(jw.Stands, sIdx)) {
        const st = resolveGraphNode(sRef, sIdx);
        if (st?.Identifier) stands.push(String(st.Identifier).trim());
        else if (st?.Name) stands.push(String(st.Name).trim());
      }
    }
    const rawKey = pk.slice('jetway:'.length);
    for (const cand of jetwayKeyStandCandidates(rawKey)) {
      if (!stands.includes(cand)) stands.push(cand);
    }
    jwToStands.set(pk, stands);
  }
  return jwToStands;
}

function buildRadioChannelTypeMap(staticData, sIdx) {
  const map = new Map(); // "radio-channel:121.85" -> Type (2=Ground, 3=Tower, 5=Approach)
  const siDict = resolveGraphNode(staticData?.StaticItems, sIdx);
  if (!siDict) return map;
  for (const [pk, rawVal] of dictEntries(siDict)) {
    if (!pk.startsWith('radio-channel:')) continue;
    const rc = resolveGraphNode(rawVal, sIdx);
    if (rc && Number.isInteger(rc.Type)) {
      map.set(pk, rc.Type);
    }
  }
  return map;
}

function makeCoordinator(sharedEmptyStringArr) {
  return {
    CrossRunwayPermissions: makeReactive(sharedEmptyStringArr),
    HoldShortAcknowledgedRunwayNames: makeReactive(sharedEmptyStringArr),
    RunwayFenceCurrentEnterRunways: makeReactive(sharedEmptyStringArr),
    RunwayGuardCurrentEnterRunway: makeReactive(sharedEmptyStringArr),
    RunwaySetter: 0,
    TaxiBlockingRunwayNames: makeReactive(sharedEmptyStringArr),
    TaxiPathUnPassedIntersectionRunwayNames: makeReactive(sharedEmptyStringArr),
  };
}

function makeAnimator(acObj, { gearRatio = Q32_ONE, gearTargetRatio = Q32_ONE, flapRatio = 0, slatRatio = 0 } = {}) {
  return {
    $type: 'ContextCross.Models.AircraftAnimator',
    Aircraft: acObj,
    FlapRatio: flapRatio,
    GearRatio: gearRatio,
    GearRetractIssued: false,
    GearTargetRatio: gearTargetRatio,
    GoAroundCommandTick: 0,
    GoAroundPhase: 0,
    HasGoAroundCommandTick: false,
    HasSnapshot: true,
    IsGearMoving: false,
    SlatRatio: slatRatio,
    TakeoffPitch: 0,
    TakeoffPitchActive: false,
    TakeoffPitchElapsed: 0,
    Version: 3,
  };
}

function synthesizeDepartureAircraft({
  fl,
  fpObj,
  standMetersMap,
  profile,
  isDocked,
  groundChannelObj,
  sharedEmptyStringArr,
  sharedEmptyEventsArr,
  sharedEmptyCmdsArr,
}) {
  const standKey = String(fl.Stand || '').trim();
  const standGeom = standMetersMap.get(standKey)
    || (/^\d+$/.test(standKey) ? standMetersMap.get(String(parseInt(standKey, 10))) : null);
  if (!standGeom) return null;

  const sdx = standGeom.noseM[0] - standGeom.tailM[0];
  const sdz = standGeom.noseM[2] - standGeom.tailM[2];
  const slen = Math.hypot(sdx, sdz);
  const dirX = slen > 1e-4 ? sdx / slen : 0;
  const dirZ = slen > 1e-4 ? sdz / slen : 1;
  const wbMeters = (profile?.wheelBaseGu ?? 0.1566) * GU_TO_METERS;
  const posXM = standGeom.noseM[0] - wbMeters * dirX;
  const posZM = standGeom.noseM[2] - wbMeters * dirZ;

  const posTuple = [
    encodeQ32(posXM, 'Aircraft._position.x'),
    0,
    encodeQ32(posZM, 'Aircraft._position.z'),
  ];
  const dirTuple = encodeDirection3({ x: dirX, y: 0, z: dirZ });

  const rcTarget = isDocked ? null : (groundChannelObj || null);
  const waitingCmds = isDocked
    ? sharedEmptyCmdsArr
    : makeTypedArray('ContextCross.Enums.ECommand[]', [1]);

  const acObj = {
    $type: 'ContextCross.Aircrafts.Aircraft',
    AircraftRunwayCoordinator: makeCoordinator(sharedEmptyStringArr),
    DynamicsData: {
      DynamicsNegativeTaxiAcceleration: 0,
      DynamicsParams: null,
      DynamicsPositiveTaxiAcceleration: 0,
      DynamicsState: makeReactive(0),
      DynamicsTargetTaxiSpeed: 0,
      ForwardSpeed: true,
      FrontWheelSteeringAngle: 0,
      NegativeTaxiAcceleration: 0,
      PositiveTaxiAcceleration: 0,
      PushbackStopRequested: false,
      TargetTaxiSpeed: 0,
      TaxiArrivalToHoldingPointPath: null,
      TaxiArrivalToSpotPath: null,
      TaxiSpeed: 0,
    },
    RollingPresetTaxiPathStartingPosition: [0, 0, 0],
    SelectedPushbackLimitPosition: null,
    SelectedRunwayEntryIndex: -1,
    SelectedRunwayExitIndex: -1,
    SelectedTowPosition: null,
    TaxiPathStartingPosition: [0, 0, 0],
    _direction: makeReactive(dirTuple),
    _flightDirection: makeReactive(0),
    _flightPlan: fpObj,
    _groundIdleTimerState: {
      AccumulatedTicks: 0,
      IsRunning: false,
      StartedAtTick: 0,
    },
    _isFirstTaxi: !isDocked,
    _jurisdictionRadioChannel: makeReactive(rcTarget),
    _position: makeReactive(posTuple),
    _radioChannel: makeReactive(rcTarget),
    _receivedEvents: makeReactive(sharedEmptyEventsArr),
    _rollingPresetTaxiPath: makeReactive(null),
    _route: makeReactive(''),
    _selectedRunwayEntryRunway: null,
    _state: makeReactive(10),
    _taxiPath: makeReactive(null),
    _waitingForCommands: makeReactive(waitingCmds),
  };

  const animObj = makeAnimator(acObj, {
    gearRatio: Q32_ONE,
    gearTargetRatio: Q32_ONE,
    flapRatio: 0,
    slatRatio: 0,
  });

  return { acObj, animObj };
}

function synthesizeArrivalAircraft({
  container,
  fl,
  fpObj,
  snapshotSec,
  approachCache,
  towerChannelObj,
  apprChannelObj,
  sharedEmptyStringArr,
  sharedEmptyEventsArr,
  sharedEmptyCmdsArr,
}) {
  const star = String(fl.Airway || '').trim();
  const runway = String(fl.Runway || '').trim();
  const landingSec = timeStrToSeconds(fl.LandingTime);
  if (!star || !runway || landingSec == null || snapshotSec == null) return null;

  const timeToLanding = landingSec - snapshotSec;
  if (timeToLanding < GRACE_TTL) return null;

  const appKey = `${star}|${runway}`;
  let flyPoints = [];
  try {
    flyPoints = readers.resolveFlyApproachPoints(container, star, runway) || [];
  } catch (_) {}

  let state5Params = null;
  try {
    const hintPos = flyPoints.length > 0 ? flyPoints[flyPoints.length - 1] : null;
    state5Params = readers.resolveApproachProcedureData(container, runway, hintPos);
  } catch (_) {}
  if (!state5Params) {
    state5Params = approachCache?.state5ParamsMap?.get(appKey)
      || approachCache?.state5ParamsMap?.get(runway)
      || null;
  }

  let appPoints = state5Params?.pathPointList?.length >= 2
    ? state5Params.pathPointList
    : (approachCache?.appPointMap?.get(appKey) || null);
  if (!appPoints || appPoints.length === 0) return null;

  const tdPos = state5Params?.touchDownPosition || approachCache?.runwayThresholds?.[runway] || null;
  const flyLen = flyPoints.length > 0 ? computePathLength(flyPoints) : 0;
  const combined = flyPoints.length > 0 ? flyPoints.concat(appPoints) : appPoints;
  let totalLen = computePathLength(combined);
  if (tdPos && tdPos.x != null && appPoints.length > 0) {
    const lastApp = appPoints[appPoints.length - 1];
    totalLen += Math.hypot(lastApp.x - tdPos.x, lastApp.z - tdPos.z);
  }

  let totalApproachTime = approachCache?.totalApproachTimes?.get(star) || null;
  if (!totalApproachTime && totalLen > 0) {
    // Convert totalLen in GU (100 m/unit) to meters and divide by approach speed (m/s)
    totalApproachTime = (totalLen * GU_TO_METERS) / APPROACH_SPEED_MS;
  }
  if (!totalApproachTime || totalApproachTime <= 0) return null;

  const clampedTTL = Math.max(timeToLanding, APPROACH_MIN_TTL);
  const progressRatio = 1.0 - clampedTTL / totalApproachTime;
  if (progressRatio <= 0.0) return null;

  const airportScale = approachCache?.airportScale || DEFAULT_AIRPORT_SCALE;
  const approachCap = computeApproachCap(airportScale);

  const rawTargetDist = (1.0 - timeToLanding / totalApproachTime) * totalLen;
  let aircraftState = 30;
  let dynState = 1;
  if (flyPoints.length > 0 && rawTargetDist >= flyLen && state5Params) {
    aircraftState = 5;
    dynState = 2;
  } else if (flyPoints.length === 0 && state5Params) {
    aircraftState = 5;
    dynState = 2;
  }

  const posGu = flyPoints.length > 0
    ? computePosition(flyPoints, appPoints, progressRatio, tdPos, approachCap)
    : computePosition([], appPoints, progressRatio, null, approachCap);
  const dirVec = flyPoints.length > 0
    ? computeDirection(flyPoints, appPoints, progressRatio, tdPos)
    : computeDirection([], appPoints, progressRatio, null);
  if (!posGu || posGu.x == null) return null;

  let dynParams = null;
  if (aircraftState === 30) {
    dynParams = {
      $type: 'ContextCross.Dynamics.States.FlyApproachDynamicsParams',
      AppPointList: appPoints.map((p) => encodeGuToPosition3({ x: p.x, y: 0, z: p.z })),
      FlyApproachPathPointList: flyPoints.map((p) => encodeGuToPosition3({ x: p.x, y: 0, z: p.z })),
      ProgressRatio: encodeQ32(Math.max(0, Math.min(1, progressRatio)), 'ProgressRatio'),
    };
  } else {
    const ppList = state5Params.pathPointList || [];
    dynParams = {
      $type: 'ContextCross.Dynamics.States.ApproachDynamicsParams',
      ApproachDirection: encodeDirection3({
        x: state5Params.approachDirection.x,
        y: state5Params.approachDirection.y || 0,
        z: state5Params.approachDirection.z,
      }),
      CommandedGoAround: false,
      InitialPosition: encodeGuToPosition3({
        x: state5Params.initialPosition.x,
        y: 15.24,
        z: state5Params.initialPosition.z,
      }),
      PathPointList: ppList.map((p) => encodeGuToPosition3({ x: p.x, y: 0, z: p.z })),
      ProgressRatio: encodeQ32(STATE5_OUTPUT_PROGRESS_RATIO, 'ProgressRatio'),
      TouchDownPosition: encodeGuToPosition3({
        x: state5Params.touchDownPosition.x,
        y: state5Params.touchDownPosition.y || 0,
        z: state5Params.touchDownPosition.z,
      }),
    };
  }

  const speedQ32 = encodeQ32(TAXI_SPEED * KT_TO_MPS, 'TaxiSpeed');
  const posAccelQ32 = encodeQ32(POSITIVE_TAXI_ACCEL * KT_TO_MPS, 'PositiveTaxiAcceleration');
  const negAccelQ32 = encodeQ32(NEGATIVE_TAXI_ACCEL * KT_TO_MPS, 'NegativeTaxiAcceleration');
  const dynPosAccelQ32 = dynState === 2
    ? encodeQ32(DYNAMICS_POSITIVE_TAXI_ACCEL * KT_TO_MPS, 'DynamicsPositiveTaxiAcceleration')
    : posAccelQ32;
  const dynNegAccelQ32 = dynState === 2
    ? encodeQ32(DYNAMICS_NEGATIVE_TAXI_ACCEL * KT_TO_MPS, 'DynamicsNegativeTaxiAcceleration')
    : negAccelQ32;

  const routeVal = aircraftState === 5 && state5Params?.routeName
    ? state5Params.routeName
    : star;
  const rcTarget = aircraftState === 5 ? (towerChannelObj || null) : (apprChannelObj || null);
  const jrcTarget = aircraftState === 5 ? (towerChannelObj || null) : null;
  const waitingCmds = aircraftState === 5
    ? makeTypedArray('ContextCross.Enums.ECommand[]', [CMD_CONTACT_TOWER])
    : sharedEmptyCmdsArr;

  const acObj = {
    $type: 'ContextCross.Aircrafts.Aircraft',
    AircraftRunwayCoordinator: makeCoordinator(sharedEmptyStringArr),
    DynamicsData: {
      DynamicsNegativeTaxiAcceleration: dynNegAccelQ32,
      DynamicsParams: dynParams,
      DynamicsPositiveTaxiAcceleration: dynPosAccelQ32,
      DynamicsState: makeReactive(dynState),
      DynamicsTargetTaxiSpeed: 0,
      ForwardSpeed: true,
      FrontWheelSteeringAngle: 0,
      NegativeTaxiAcceleration: negAccelQ32,
      PositiveTaxiAcceleration: posAccelQ32,
      PushbackStopRequested: false,
      TargetTaxiSpeed: speedQ32,
      TaxiArrivalToHoldingPointPath: null,
      TaxiArrivalToSpotPath: null,
      TaxiSpeed: speedQ32,
    },
    RollingPresetTaxiPathStartingPosition: [0, 0, 0],
    SelectedPushbackLimitPosition: null,
    SelectedRunwayEntryIndex: -1,
    SelectedRunwayExitIndex: -1,
    SelectedTowPosition: null,
    TaxiPathStartingPosition: [0, 0, 0],
    _direction: makeReactive(encodeDirection3({ x: dirVec.x, y: 0, z: dirVec.z })),
    _flightDirection: makeReactive(1),
    _flightPlan: fpObj,
    _groundIdleTimerState: {
      AccumulatedTicks: 0,
      IsRunning: false,
      StartedAtTick: 0,
    },
    _isFirstTaxi: false,
    _jurisdictionRadioChannel: makeReactive(jrcTarget),
    _position: makeReactive(encodeGuToPosition3(posGu)),
    _radioChannel: makeReactive(rcTarget),
    _receivedEvents: makeReactive(sharedEmptyEventsArr),
    _rollingPresetTaxiPath: makeReactive(null),
    _route: makeReactive(routeVal),
    _selectedRunwayEntryRunway: null,
    _state: makeReactive(aircraftState),
    _taxiPath: makeReactive(null),
    _waitingForCommands: makeReactive(waitingCmds),
  };

  const animObj = makeAnimator(acObj, {
    gearRatio: aircraftState === 5 ? Q32_ONE : 0,
    gearTargetRatio: Q32_ONE,
    flapRatio: aircraftState === 5 ? Q32_ONE : 0,
    slatRatio: aircraftState === 5 ? Q32_SLAT_APPROACH : 0,
  });

  return { acObj, animObj };
}

function scrubRuntimeDependentsForFlightEdits(reDict, frame, rtIdx, validRegs, validCallsigns, renamedRegs) {
  const validAircraftPks = new Set([...validRegs].map((r) => `aircraft:${r}`));
  const remapAircraftPk = (pk) => {
    if (typeof pk !== 'string' || !pk.startsWith('aircraft:')) return pk;
    const oldReg = pk.slice('aircraft:'.length);
    const mapped = renamedRegs.get(oldReg);
    return mapped ? `aircraft:${mapped}` : pk;
  };

  // 1. EventQueue inside `singleton:game-event-schedule`
  const evSched = resolveGraphNode(dictGet(reDict, 'singleton:game-event-schedule'), rtIdx);
  if (evSched && Array.isArray(evSched.EventQueue) && evSched.EventQueue.length > 0) {
    evSched.EventQueue = evSched.EventQueue.filter((rawEv) => {
      const ev = resolveGraphNode(rawEv, rtIdx);
      if (!ev || typeof ev !== 'object') return false;
      for (const field of ['Source', 'Target', 'AircraftPk']) {
        if (typeof ev[field] === 'string' && ev[field].startsWith('aircraft:')) {
          ev[field] = remapAircraftPk(ev[field]);
          if (!validAircraftPks.has(ev[field])) return false;
        }
      }
      if (ev.Aircraft && typeof ev.Aircraft === 'object') {
        const targetAc = resolveGraphNode(ev.Aircraft, rtIdx);
        const fp = targetAc ? resolveGraphNode(targetAc._flightPlan, rtIdx) : null;
        const refStr = fp?.StaticItem?.$ref || '';
        const m = refStr.match(/flight-plan:(.+)$/);
        if (m && !validRegs.has(m[1])) return false;
      }
      return true;
    });
  }

  // 2. ScoringStateEntity inside `singleton:scoring-state`
  const scoring = resolveGraphNode(dictGet(reDict, 'singleton:scoring-state'), rtIdx);
  if (scoring && typeof scoring === 'object') {
    const filterByCallsign = (arr) => {
      if (!Array.isArray(arr) || arr.length === 0) return arr;
      return arr.filter((rec) => {
        const r = resolveGraphNode(rec, rtIdx);
        if (!r) return false;
        if (typeof r.CallSign === 'string' && r.CallSign && !validCallsigns.has(r.CallSign)) return false;
        if (typeof r.LeadingAircraftPk === 'string' && r.LeadingAircraftPk.startsWith('aircraft:')) {
          r.LeadingAircraftPk = remapAircraftPk(r.LeadingAircraftPk);
          if (!validAircraftPks.has(r.LeadingAircraftPk)) return false;
        }
        if (typeof r.TrailingAircraftPk === 'string' && r.TrailingAircraftPk.startsWith('aircraft:')) {
          r.TrailingAircraftPk = remapAircraftPk(r.TrailingAircraftPk);
          if (!validAircraftPks.has(r.TrailingAircraftPk)) return false;
        }
        if (typeof r.AircraftPk === 'string' && r.AircraftPk.startsWith('aircraft:')) {
          r.AircraftPk = remapAircraftPk(r.AircraftPk);
          if (!validAircraftPks.has(r.AircraftPk)) return false;
        }
        return true;
      });
    };
    for (const listKey of [
      'CompletedLegs',
      'Conversations',
      'GoArounds',
      'Handovers',
      'PendingConversations',
      'StartedLegs',
      'WakeChecks',
      'ActiveIncursions',
      'Incursions',
    ]) {
      if (Array.isArray(scoring[listKey]) && scoring[listKey].length > 0) {
        scoring[listKey] = filterByCallsign(scoring[listKey]);
      }
    }
    if (Array.isArray(scoring.PlayerRequestedDepartureContacts) && scoring.PlayerRequestedDepartureContacts.length > 0) {
      scoring.PlayerRequestedDepartureContacts = scoring.PlayerRequestedDepartureContacts
        .map((s) => (typeof s === 'string' ? remapAircraftPk(s) : s))
        .filter((s) => typeof s !== 'string' || !s.startsWith('aircraft:') || validAircraftPks.has(s));
    }
  }

  // 2b. PhysicalRunway._latestDepartureRoll & AircraftGroundIdleScoreStateEntity.RecordsByLeg
  for (const [k, rawV] of dictEntries(reDict)) {
    if (k.startsWith('physical-runway:')) {
      const pr = resolveGraphNode(rawV, rtIdx);
      if (pr && pr._latestDepartureRoll) {
        const roll = resolveGraphNode(pr._latestDepartureRoll, rtIdx);
        if (roll && typeof roll._aircraftPk === 'string') {
          roll._aircraftPk = remapAircraftPk(roll._aircraftPk);
          if (!validAircraftPks.has(roll._aircraftPk)) {
            pr._latestDepartureRoll = null;
          }
        }
      }
    } else {
      const ent = resolveGraphNode(rawV, rtIdx);
      if (ent && ent.$type === 'ContextCross.Aircrafts.AircraftGroundIdleScoreStateEntity' && ent.RecordsByLeg) {
        const recDict = resolveGraphNode(ent.RecordsByLeg, rtIdx);
        if (recDict) {
          for (const [legKey] of dictEntries(recDict)) {
            if (legKey.startsWith('aircraft:')) {
              const parts = legKey.split(':');
              const acPk = parts.length >= 2 ? `aircraft:${parts[1]}` : legKey;
              const mappedPk = remapAircraftPk(acPk);
              if (!validAircraftPks.has(mappedPk)) {
                dictDelete(recDict, legKey);
              } else if (mappedPk !== acPk) {
                const val = dictGet(recDict, legKey);
                dictDelete(recDict, legKey);
                dictSet(recDict, [mappedPk, ...parts.slice(2)].join(':'), val);
              }
            }
          }
        }
      }
    }
  }

  // 3. RecentMessages on checkpoint frame
  if (Array.isArray(frame.recentMessages) && frame.recentMessages.length > 0) {
    const prevLen = frame.recentMessages.length;
    frame.recentMessages = frame.recentMessages.filter((msg) => {
      if (!msg || !Array.isArray(msg.Arguments)) return true;
      for (const arg of msg.Arguments) {
        if (typeof arg === 'string' && arg.startsWith('aircraft:')) {
          const mapped = remapAircraftPk(arg);
          if (!validAircraftPks.has(mapped)) return false;
        }
      }
      return true;
    });
    if (frame.recentMessages.length !== prevLen) {
      frame.dirtyMessages = true;
    }
  }
}

function computeEstimatedIso(explicitStr, baseTimeStr, taxiSec, baseDate) {
  if (explicitStr && String(explicitStr).trim()) {
    return formatEditorTimeToIso(explicitStr, baseDate);
  }
  const baseSec = timeStrToSeconds(baseTimeStr);
  if (baseSec == null) return UNSET_DATETIME_ISO;
  return formatSecondsToIso(baseSec + taxiSec, baseDate);
}

function applyFlightEdits(container, editIntent, context = {}) {
  const schema = getSchemaForHash(container.header.schemaHash);
  const filePath = editIntent.filePath || context.filePath || null;
  const approachCache = editIntent.approachCache || null;
  const flights = editIntent.flights;
  if (!Array.isArray(flights)) {
    throw new Error('applyFlightEdits: editIntent.flights must be an array');
  }

  // 1. Validate stand turnaround conflicts before mutating container
  if (flights.length > 0) {
    _validateStandConflicts(flights);
  }

  // Snapshot original static items & capture pre-mutation StaticData index
  const preStaticIdx = indexDocumentGraph(container.staticData, schema.roots.static, schema);
  const siDict = resolveGraphNode(container.staticData.StaticItems, preStaticIdx);
  if (!siDict) {
    throw new Error('applyFlightEdits: StaticData.StaticItems is missing');
  }

  const origStaticByReg = new Map();
  for (const [pk, rawVal] of dictEntries(siDict)) {
    if (!pk.startsWith('flight-plan:')) continue;
    const reg = pk.slice('flight-plan:'.length);
    const resolved = resolveGraphNode(rawVal, preStaticIdx);
    if (resolved) origStaticByReg.set(reg, resolved);
  }

  // Collect full stand pool from scenery for game-compat stand allocation
  const standMetersMap = buildStandMetersMap(container.staticData, preStaticIdx);
  const standPool = [
    ...Object.keys(editIntent.sceneryMaps?.standIdToGuid || {}),
    ...readers.readSceneryMaps(container).standGuidToId
      ? Object.values(readers.readSceneryMaps(container).standGuidToId)
      : [],
  ];

  // Track original registration per flight object before normalization so renames are traceable
  const origRegForFlight = new WeakMap();
  for (const fl of flights) {
    if (typeof fl._fpGuid === 'string' && fl._fpGuid.startsWith('flight-plan:')) {
      origRegForFlight.set(fl, fl._fpGuid.slice('flight-plan:'.length));
    }
  }

  const compatStats = normalizeV3FlightsForGameCompat(container, flights, {
    standPool,
    approachCache,
    filePath,
  });

  // Build oldReg -> newReg map for genuinely renamed flights
  const newRegsSet = new Set(flights.map((f) => f._Registration));
  const renamedRegs = new Map(); // oldReg -> newReg
  const renamedFromNewReg = new Map(); // newReg -> oldReg
  for (const fl of flights) {
    const oldReg = origRegForFlight.get(fl);
    const newReg = fl._Registration;
    if (oldReg && newReg && oldReg !== newReg && !newRegsSet.has(oldReg) && !renamedRegs.has(oldReg)) {
      renamedRegs.set(oldReg, newReg);
      renamedFromNewReg.set(newReg, oldReg);
    }
    fl._fpGuid = `flight-plan:${newReg}`;
  }

  // 2. Rebuild `StaticData.StaticItems["flight-plan:<REG>"]`
  const baseDate = parseIsoWallClock(container.metaData?.BaseTime)?.datePrefix || DEFAULT_BASE_DATE;
  for (const [pk] of dictEntries(siDict)) {
    if (pk.startsWith('flight-plan:')) {
      dictDelete(siDict, pk);
    }
  }

  const newStaticByReg = new Map();
  for (const fl of flights) {
    const reg = fl._Registration;
    const prevReg = renamedFromNewReg.get(reg) || reg;
    const prevItem = origStaticByReg.get(prevReg) || null;
    const item = buildStaticFlightPlanItem(fl, baseDate, prevItem);
    dictSet(siDict, `flight-plan:${reg}`, item);
    newStaticByReg.set(reg, item);
  }

  container.staticData = normalizeDocumentGraph(
    container.staticData,
    schema.roots.static,
    schema,
    preStaticIdx,
  );
  container.dirtyStaticData = true;

  // Re-index normalized StaticData for runtime reconciliation lookups
  const postStaticIdx = indexDocumentGraph(container.staticData, schema.roots.static, schema);
  const jwStandMap = buildJetwayStandLookup(container.staticData, postStaticIdx);
  const rcTypeMap = buildRadioChannelTypeMap(container.staticData, postStaticIdx);
  const postStandMetersMap = buildStandMetersMap(container.staticData, postStaticIdx);
  const profilesMap = loadAircraftProfilesForLevel(filePath);
  const icao = String(container.header?.airportIcao || container.metaData?.Config?.prototypeName || '').toUpperCase();
  const depTaxiSec = DEPARTURE_TAXI_SECONDS[icao] ?? DEPARTURE_TAXI_SECONDS.default;
  const arrTaxiSec = ARRIVAL_TAXI_SECONDS[icao] ?? ARRIVAL_TAXI_SECONDS.default;
  const validCallsigns = new Set(flights.map((f) => String(f.CallSign || '').trim()).filter(Boolean));

  // 3. Reconcile every checkpoint frame in `container.frames`
  for (let fi = 0; fi < (container.frames || []).length; fi++) {
    const frame = container.frames[fi];
    if (!frame?.runtimeData) continue;

    const preRtIdx = indexDocumentGraph(frame.runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(frame.runtimeData.RuntimeEntities, preRtIdx);
    if (!reDict) continue;
    frame.runtimeData.RuntimeEntities = reDict;

    // Determine snapshot seconds for this frame
    let snapshotSec = editIntent._saveSec ?? null;
    const gt = resolveGraphNode(dictGet(reDict, 'singleton:game-time'), preRtIdx);
    const cdtIso = gt ? unwrapReactive(gt.CurrentDateTime, preRtIdx) : null;
    const parsedCdt = typeof cdtIso === 'string' ? parseIsoWallClock(cdtIso) : null;
    if (parsedCdt) {
      snapshotSec = parsedCdt.exactSecSinceMidnight;
    } else if (snapshotSec == null) {
      const parsedBt = parseIsoWallClock(container.metaData?.BaseTime);
      if (parsedBt) snapshotSec = parsedBt.exactSecSinceMidnight;
    }

    // Resolve runtime radio channel objects by channel Type (2=Ground, 3=Tower, 5=Approach)
    let groundChannelObj = null;
    let towerChannelObj = null;
    let apprChannelObj = null;
    for (const [k, rawV] of dictEntries(reDict)) {
      if (!k.startsWith('radio-channel:')) continue;
      const rcObj = resolveGraphNode(rawV, preRtIdx);
      dictSet(reDict, k, rcObj);
      const t = rcTypeMap.get(k);
      if (t === 2 && !groundChannelObj) groundChannelObj = rcObj;
      else if (t === 3 && !towerChannelObj) towerChannelObj = rcObj;
      else if (t === 5 && !apprChannelObj) apprChannelObj = rcObj;
    }
    if (!groundChannelObj) groundChannelObj = towerChannelObj;
    if (!apprChannelObj) apprChannelObj = towerChannelObj;

    // Reuse canonical shared empty typed arrays if present, else create fresh ones per frame
    const sharedEmptyStringArr = makeTypedArray('System.String[]', []);
    const sharedEmptyEventsArr = makeTypedArray('ContextCross.Events.AircraftEvent[]', []);
    const sharedEmptyCmdsArr = makeTypedArray('ContextCross.Enums.ECommand[]', []);

    // Collect existing runtime flight plans, aircraft, animators, and jetway docking before clearing
    const prevFpByReg = new Map();
    const prevAcByReg = new Map();
    const prevAnimByReg = new Map();
    const prevDockedJwByReg = new Map(); // prevReg -> jetwayPk
    for (const [k, rawV] of dictEntries(reDict)) {
      if (k.startsWith('flight-plan:')) {
        prevFpByReg.set(k.slice('flight-plan:'.length), resolveGraphNode(rawV, preRtIdx));
      } else if (k.startsWith('aircraft:')) {
        prevAcByReg.set(k.slice('aircraft:'.length), resolveGraphNode(rawV, preRtIdx));
      } else if (k.startsWith('aircraft-animator:aircraft:')) {
        prevAnimByReg.set(k.slice('aircraft-animator:aircraft:'.length), resolveGraphNode(rawV, preRtIdx));
      } else if (k.startsWith('jetway:')) {
        const jw = resolveGraphNode(rawV, preRtIdx);
        const dockAc = jw ? resolveGraphNode(unwrapReactive(jw.DockingAircraft, preRtIdx), preRtIdx) : null;
        if (dockAc) {
          const fp = resolveGraphNode(dockAc._flightPlan, preRtIdx);
          const m = (fp?.StaticItem?.$ref || '').match(/flight-plan:(.+)$/);
          if (m) prevDockedJwByReg.set(m[1], k);
        }
      }
    }

    // Decide which departure flight docks at each jetway in this frame
    // Rule: earliest departure on a stand served by `jetway:*` whose `OffBlockTime > snapshotSec`
    // (or surviving already-docked unchanged departure) and whose aircraft type has docking doors.
    const standCandidatesForJw = new Map(); // normStand -> jetwayPk
    for (const [jwPk] of dictEntries(reDict)) {
      if (!jwPk.startsWith('jetway:')) continue;
      const stands = jwStandMap.get(jwPk) || jetwayKeyStandCandidates(jwPk.slice('jetway:'.length));
      for (const st of stands) {
        if (st && !standCandidatesForJw.has(st)) {
          standCandidatesForJw.set(st, jwPk);
        }
      }
    }

    const bestDockForJw = new Map(); // jwPk -> { fl, offBlockSec }
    for (const fl of flights) {
      if (!isDepartureFlight(fl)) continue;
      const prof = getAircraftProfile(fl.AircraftType, profilesMap, approachCache);
      if (!prof.hasDockingDoors) continue;
      const stand = String(fl.Stand || '').trim();
      const jwPk = standCandidatesForJw.get(stand)
        || (/^\d+$/.test(stand) ? standCandidatesForJw.get(String(parseInt(stand, 10))) : null);
      if (!jwPk) continue;
      const obSec = timeStrToSeconds(fl.OffBlockTime);
      const prevReg = renamedFromNewReg.get(fl._Registration) || fl._Registration;
      const wasDockedHere = prevDockedJwByReg.get(prevReg) === jwPk;
      const uneditedSpatial = origStaticByReg.has(prevReg)
        && scheduleSpatialSignature(origStaticByReg.get(prevReg)) === scheduleSpatialSignature(newStaticByReg.get(fl._Registration));
      // Only dock if not yet pushed back at snapshotSec (or was already docked at this exact jetway unedited)
      if (!wasDockedHere || !uneditedSpatial) {
        if (snapshotSec != null && obSec != null && obSec <= snapshotSec) continue;
      }
      const cur = bestDockForJw.get(jwPk);
      const scoreSec = obSec ?? Infinity;
      if (!cur || scoreSec < cur.offBlockSec) {
        bestDockForJw.set(jwPk, { fl, offBlockSec: scoreSec });
      }
    }

    const dockedJwByNewReg = new Map(); // newReg -> jwPk
    for (const [jwPk, { fl }] of bestDockForJw) {
      dockedJwByNewReg.set(fl._Registration, jwPk);
    }

    // Build runtime `FlightPlan`, `Aircraft`, and `AircraftAnimator` objects
    const nextFpByReg = new Map();
    const nextAcByReg = new Map();
    const nextAnimByReg = new Map();

    for (const fl of flights) {
      const reg = fl._Registration;
      const prevReg = renamedFromNewReg.get(reg) || reg;
      const dep = isDepartureFlight(fl);
      const prevStatic = origStaticByReg.get(prevReg) || null;
      const nextStatic = newStaticByReg.get(reg);
      const spatialUnchanged = Boolean(
        prevStatic && scheduleSpatialSignature(prevStatic) === scheduleSpatialSignature(nextStatic),
      );
      const prevFp = prevFpByReg.get(prevReg) || null;

      let fpObj;
      if (spatialUnchanged && prevFp) {
        fpObj = {
          StaticItem: makePkRef('ContextCross.Models.FlightPlanStaticItem', `flight-plan:${reg}`),
          _arrivalActualInBlockTime: prevFp._arrivalActualInBlockTime || UNSET_DATETIME_ISO,
          _arrivalInBlockTime: dep ? UNSET_DATETIME_ISO : (prevFp._arrivalInBlockTime || computeEstimatedIso(fl.InBlockTime, fl.LandingTime, arrTaxiSec, baseDate)),
          _arrivalRunway: dep ? null : String(fl.Runway || ''),
          _arrivalStand: dep ? null : String(fl.Stand || ''),
          _departureRunway: dep ? String(fl.Runway || '') : null,
          _departureStand: dep ? String(fl.Stand || '') : null,
          _departureTakeoffTime: dep ? (prevFp._departureTakeoffTime || computeEstimatedIso(fl.TakeoffTime, fl.OffBlockTime, depTaxiSec, baseDate)) : UNSET_DATETIME_ISO,
        };
      } else {
        fpObj = {
          StaticItem: makePkRef('ContextCross.Models.FlightPlanStaticItem', `flight-plan:${reg}`),
          _arrivalActualInBlockTime: UNSET_DATETIME_ISO,
          _arrivalInBlockTime: dep ? UNSET_DATETIME_ISO : computeEstimatedIso(fl.InBlockTime, fl.LandingTime, arrTaxiSec, baseDate),
          _arrivalRunway: dep ? null : String(fl.Runway || ''),
          _arrivalStand: dep ? null : String(fl.Stand || ''),
          _departureRunway: dep ? String(fl.Runway || '') : null,
          _departureStand: dep ? String(fl.Stand || '') : null,
          _departureTakeoffTime: dep ? computeEstimatedIso(fl.TakeoffTime, fl.OffBlockTime, depTaxiSec, baseDate) : UNSET_DATETIME_ISO,
        };
      }
      nextFpByReg.set(reg, fpObj);

      // Preserve live checkpoint aircraft + animator if spatial/time schedule did NOT change
      // AND docking status at jetway did NOT flip!
      const prevAc = prevAcByReg.get(prevReg) || null;
      const prevAnim = prevAnimByReg.get(prevReg) || null;
      const wasDocked = prevDockedJwByReg.has(prevReg);
      const nowDocked = dockedJwByNewReg.has(reg);
      if (spatialUnchanged && wasDocked === nowDocked) {
        if (prevAc) {
          prevAc.$type = 'ContextCross.Aircrafts.Aircraft';
          prevAc._flightPlan = fpObj;
          nextAcByReg.set(reg, prevAc);
          const anim = prevAnim || makeAnimator(prevAc);
          anim.$type = 'ContextCross.Models.AircraftAnimator';
          anim.Aircraft = prevAc;
          nextAnimByReg.set(reg, anim);
        }
        continue;
      }

      // Synthesize fresh runtime Aircraft + AircraftAnimator when active at `snapshotSec`
      if (dep) {
        const obSec = timeStrToSeconds(fl.OffBlockTime);
        if (snapshotSec != null && obSec != null && obSec <= snapshotSec && !nowDocked) {
          // Already departed prior to checkpoint snapshot
          continue;
        }
        const prof = getAircraftProfile(fl.AircraftType, profilesMap, approachCache);
        const built = synthesizeDepartureAircraft({
          fl,
          fpObj,
          standMetersMap: postStandMetersMap,
          profile: prof,
          isDocked: nowDocked,
          groundChannelObj,
          sharedEmptyStringArr,
          sharedEmptyEventsArr,
          sharedEmptyCmdsArr,
        });
        if (built) {
          nextAcByReg.set(reg, built.acObj);
          nextAnimByReg.set(reg, built.animObj);
        }
      } else {
        const built = synthesizeArrivalAircraft({
          container,
          fl,
          fpObj,
          snapshotSec,
          approachCache,
          towerChannelObj,
          apprChannelObj,
          sharedEmptyStringArr,
          sharedEmptyEventsArr,
          sharedEmptyCmdsArr,
        });
        if (built) {
          nextAcByReg.set(reg, built.acObj);
          nextAnimByReg.set(reg, built.animObj);
        }
      }
    }

    // Update all `jetway:*` entries so docked aircraft share exact JS object identity with `aircraft:<reg>`
    for (const [k, rawV] of dictEntries(reDict)) {
      if (!k.startsWith('jetway:')) continue;
      const prevJw = resolveGraphNode(rawV, preRtIdx);
      const dockEntry = bestDockForJw.get(k);
      const dockReg = dockEntry ? dockEntry.fl._Registration : null;
      const dockAcObj = dockReg ? nextAcByReg.get(dockReg) : null;

      if (dockAcObj) {
        const prevReg = renamedFromNewReg.get(dockReg) || dockReg;
        if (prevJw && prevDockedJwByReg.get(prevReg) === k) {
          prevJw.$type = 'ContextCross.Models.Jetway';
          prevJw.DockingAircraft = makeReactive(dockAcObj);
          dictSet(reDict, k, prevJw);
        } else {
          dictSet(reDict, k, {
            $type: 'ContextCross.Models.Jetway',
            AutoUndockFinished: false,
            DockingAircraft: makeReactive(dockAcObj),
            DockingDoorIndex: makeReactive(0),
            Progress: makeReactive(Q32_ONE),
            Status: 2,
            TrigEvent: true,
          });
        }
      } else {
        dictSet(reDict, k, {
          $type: 'ContextCross.Models.Jetway',
          AutoUndockFinished: false,
          DockingAircraft: makeReactive(null),
          DockingDoorIndex: makeReactive(-1),
          Progress: makeReactive(0),
          Status: 0,
          TrigEvent: false,
        });
      }
    }

    // Remove all old flight-plan / aircraft / aircraft-animator keys and insert reconciled ones
    for (const [k] of dictEntries(reDict)) {
      if (
        k.startsWith('flight-plan:') ||
        k.startsWith('aircraft:') ||
        k.startsWith('aircraft-animator:')
      ) {
        dictDelete(reDict, k);
      }
    }

    for (const [reg, fpObj] of nextFpByReg) {
      fpObj.$type = 'ContextCross.Models.FlightPlan';
      dictSet(reDict, `flight-plan:${reg}`, fpObj);
    }
    for (const [reg, acObj] of nextAcByReg) {
      acObj.$type = 'ContextCross.Aircrafts.Aircraft';
      dictSet(reDict, `aircraft:${reg}`, acObj);
    }
    for (const [reg, animObj] of nextAnimByReg) {
      animObj.$type = 'ContextCross.Models.AircraftAnimator';
      dictSet(reDict, `aircraft-animator:aircraft:${reg}`, animObj);
    }

    scrubRuntimeDependentsForFlightEdits(reDict, frame, preRtIdx, newRegsSet, validCallsigns, renamedRegs);

    frame.runtimeData = normalizeDocumentGraph(
      frame.runtimeData,
      schema.roots.runtime,
      schema,
      preRtIdx,
    );
    frame.dirtyRuntimeData = true;
  }

  return {
    flightsUpdated: true,
    flightCount: flights.length,
    compatStats,
  };
}

module.exports = {
  applyFlightEdits,
  loadAircraftProfilesForLevel,
};
