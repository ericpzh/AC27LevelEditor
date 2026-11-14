'use strict';

/**
 * GATCARC4 v3 Editor Read Projections (`src/acl/v3/readers.js`).
 *
 * Maps parsed v3 container state (`header`, `metaData`, `staticData`, `frames`)
 * to the exact editor-shaped contracts expected by existing workflows.
 */

const fs = require('fs');
const path = require('path');
const { RAD_TO_DEG, FIX_NAME_RE, TICKS_PER_DAY } = require('../constants');
const { coordKey, _headingDeg } = require('../scenery_graph');
const {
  decodeQ32,
  decodePosition3ToGu,
  decodeRadiansQ32ToDeg,
  decodeWindDirectionDeg,
  decodeWindSpeedKnots,
  parseIsoWallClock,
} = require('./q32');
const { getSchemaForHash } = require('./schema_registry');
const {
  dictEntries,
  indexDocumentGraph,
  resolveGraphNode,
  unwrapReactive,
  unwrapTypedArray,
} = require('./graph');

// ─── Graph cache per container ──────────────────────────────────

function getStaticGraph(container) {
  if (!container._staticGraphCache) {
    const schema = getSchemaForHash(container.header.schemaHash);
    container._staticGraphCache = indexDocumentGraph(
      container.staticData,
      'ContextCross.Saves.StaticField',
      schema,
    );
  }
  return container._staticGraphCache;
}

function getRuntimeGraph(container, frameIndex) {
  const frame = container.frames[frameIndex];
  if (!frame) return null;
  if (!frame._runtimeGraphCache) {
    const schema = getSchemaForHash(container.header.schemaHash);
    frame._runtimeGraphCache = indexDocumentGraph(
      frame.runtimeData,
      'ContextCross.Saves.RuntimeField',
      schema,
    );
  }
  return frame._runtimeGraphCache;
}

function invalidateContainerCaches(container) {
  delete container._staticGraphCache;
  if (Array.isArray(container.frames)) {
    for (const f of container.frames) {
      if (f) delete f._runtimeGraphCache;
    }
  }
}

// ─── Time & Config Projections ──────────────────────────────────

function isoToEditorTime(isoStr) {
  if (!isoStr || typeof isoStr !== 'string') return '';
  const parsed = parseIsoWallClock(isoStr);
  if (!parsed) return '';
  return parsed.timeString;
}

function isoToDotNetTicks(isoStr) {
  const parsed = parseIsoWallClock(isoStr);
  if (!parsed) return 0n;
  return parsed.ticks;
}

function readConfig(container) {
  const cfg = container?.metaData?.Config;
  if (!cfg) return null;
  const refLat = cfg.referenceLatitude != null ? decodeRadiansQ32ToDeg(cfg.referenceLatitude) : null;
  const refLon = cfg.referenceLongitude != null ? decodeRadiansQ32ToDeg(cfg.referenceLongitude) : null;
  const offset = Array.isArray(cfg.offset) && cfg.offset.length >= 2
    ? { x: decodeQ32(cfg.offset[0]), y: decodeQ32(cfg.offset[1]) }
    : { x: 0, y: 0 };
  return {
    name: cfg.name || '',
    prototypeName: cfg.prototypeName || '',
    startTime: cfg.startTime || null,
    endTime: cfg.endTime || null,
    flightScheduleFile: cfg.flightScheduleFile || '',
    runwayTimelineFile: cfg.runwayTimelineFile || '',
    channelFile: cfg.channelFile || '',
    geoDataFile: cfg.geoDataFile || 'geo_data',
    visualGeoDataFile: cfg.visualGeoDataFile || '',
    taxiNavigationDataFile: cfg.taxiNavigationDataFile || '',
    generatedTaxiNavigationDataFile: cfg.generatedTaxiNavigationDataFile || '',
    radioAudioClipNamesFileEN: cfg.radioAudioClipNamesFileEN || '',
    radioAudioClipNamesFileZH: cfg.radioAudioClipNamesFileZH || '',
    radioTemplateFileEN: cfg.radioTemplateFileEN || '',
    radioTemplateFileZH: cfg.radioTemplateFileZH || '',
    isSurfaceRadarTrafficHidden: !!cfg.isSurfaceRadarTrafficHidden,
    tutorialScenario: Number(cfg.tutorialScenario || 0),
    usePercentOffset: !!cfg.usePercentOffset,
    offset,
    offsetDistance: cfg.offsetDistance != null ? decodeQ32(cfg.offsetDistance) : 0,
    offsetRatio: cfg.offsetRatio != null ? decodeQ32(cfg.offsetRatio) : 0,
    scaleFactor: cfg.scaleFactor != null ? decodeQ32(cfg.scaleFactor) : 0.01,
    refPoint: (refLat != null && refLon != null) ? { lat: refLat, lon: refLon } : null,
  };
}

/**
 * Extract CurrentDateTime with v3 checkpoint precedence:
 *   1. Latest checkpoint frame's `singleton:game-time.CurrentDateTime.value`
 *   2. Fallback to `MetaData.BaseTime`
 */
function readCurrentDateTime(container) {
  if (Array.isArray(container.frames) && container.frames.length > 0) {
    for (let i = container.frames.length - 1; i >= 0; i--) {
      const rt = container.frames[i]?.runtimeData;
      const re = rt?.RuntimeEntities;
      if (!re) continue;
      const g = getRuntimeGraph(container, i);
      const gtRaw = re['singleton:game-time'];
      const gt = gtRaw ? resolveGraphNode(gtRaw, g) : null;
      const cdtStr = gt ? unwrapReactive(gt.CurrentDateTime, g) : null;
      if (typeof cdtStr === 'string') {
        const parsed = parseIsoWallClock(cdtStr);
        if (parsed && !parsed.isUnset) {
          return {
            ticks: isoToDotNetTicks(cdtStr),
            secSinceMidnight: parsed.secSinceMidnight,
            timeString: parsed.timeString,
            iso: cdtStr,
            fromCheckpoint: true,
          };
        }
      }
    }
  }

  const baseIso = container?.metaData?.BaseTime;
  if (typeof baseIso === 'string') {
    const parsed = parseIsoWallClock(baseIso);
    if (parsed && !parsed.isUnset) {
      return {
        ticks: isoToDotNetTicks(baseIso),
        secSinceMidnight: parsed.secSinceMidnight,
        timeString: parsed.timeString,
        iso: baseIso,
        fromCheckpoint: false,
      };
    }
  }
  return null;
}

/**
 * Return GameTime seconds since midnight ONLY when a checkpoint `singleton:game-time`
 * exists (returning `null` on 0-frame levels so callers apply `config.startTime + WARMUP_SEC`).
 */
function readGameTimeSec(container) {
  if (!Array.isArray(container.frames) || container.frames.length === 0) return null;
  for (let i = container.frames.length - 1; i >= 0; i--) {
    const rt = container.frames[i]?.runtimeData;
    const re = rt?.RuntimeEntities;
    if (!re) continue;
    const g = getRuntimeGraph(container, i);
    const gtRaw = re['singleton:game-time'];
    const gt = gtRaw ? resolveGraphNode(gtRaw, g) : null;
    const cdtStr = gt ? unwrapReactive(gt.CurrentDateTime, g) : null;
    if (typeof cdtStr === 'string') {
      const parsed = parseIsoWallClock(cdtStr);
      if (parsed && !parsed.isUnset) return parsed.secSinceMidnight;
    }
  }
  return null;
}

function readConfigResolved(container) {
  const { roundSecondsToMinute, minutesToTimeStr } = require('../../utils/timeUtils');
  const config = readConfig(container);
  if (!config) return null;
  const cdt = readCurrentDateTime(container);
  if (cdt && cdt.timeString) {
    const startMin = roundSecondsToMinute(cdt.secSinceMidnight, true);
    config.startTime = minutesToTimeStr(startMin);
  }
  return config;
}

// ─── Scenery Maps & Flights ─────────────────────────────────────

function readSceneryMaps(container) {
  const runwayNameToGuid = {};
  const standIdToGuid = {};
  const runwayGuidToName = {};
  const standGuidToId = {};

  const pkDict = container?.staticData?.PKStaticEntities;
  if (!pkDict) return { runwayNameToGuid, standIdToGuid, runwayGuidToName, standGuidToId };
  const g = getStaticGraph(container);

  for (const [pk, rawVal] of dictEntries(pkDict)) {
    const val = resolveGraphNode(rawVal, g);
    if (!val || typeof val !== 'object') continue;
    if (pk.startsWith('runway:')) {
      const name = val.Name;
      if (name) {
        runwayNameToGuid[name] = pk;
        runwayGuidToName[pk] = name;
      }
    } else if (pk.startsWith('stand:')) {
      const id = val.Identifier;
      if (id) {
        standIdToGuid[id] = pk;
        standGuidToId[pk] = id;
      }
    }
  }

  return { runwayNameToGuid, standIdToGuid, runwayGuidToName, standGuidToId };
}

function _flightFromV3StaticItem(pk, item, g) {
  if (!item || typeof item !== 'object') return null;
  const f = {
    _Registration: item.Registration || '',
    AircraftType: item.AircraftType || '',
    AirlineName: item.AirlineName || '',
    Voice: item.Voice || '',
    Language: item.Language || '',
    _fpGuid: pk,
  };

  const arrLeg = item.InitialArrival ? resolveGraphNode(item.InitialArrival, g) : null;
  const depLeg = item.InitialDeparture ? resolveGraphNode(item.InitialDeparture, g) : null;

  if (arrLeg) {
    f.isDeparture = false;
    f.CallSign = arrLeg.CallSign || '';
    f.DepartureAirport = arrLeg.OriginAirport || '';
    f.ArrivalAirport = '';
    f.Runway = arrLeg.Runway || '';
    f.Stand = arrLeg.Stand || '';
    f.Airway = arrLeg.STAR || '';
    f.LandingTime = isoToEditorTime(arrLeg.LandingTime);
    f.InBlockTime = isoToEditorTime(arrLeg.InBlockTime);
    f.OffBlockTime = '';
    f.TakeoffTime = '';
    return f;
  }

  if (depLeg) {
    f.isDeparture = true;
    f.CallSign = depLeg.CallSign || '';
    f.DepartureAirport = '';
    f.ArrivalAirport = depLeg.DestinationAirport || '';
    f.Runway = depLeg.Runway || '';
    f.Stand = depLeg.Stand || '';
    f.Airway = '';
    f.LandingTime = '';
    f.InBlockTime = '';
    f.OffBlockTime = isoToEditorTime(depLeg.OffBlockTime);
    f.TakeoffTime = isoToEditorTime(depLeg.TakeoffTime);
    return f;
  }

  return null;
}

function readFlights(container, filePath = null) {
  const sceneryMaps = readSceneryMaps(container);
  const flights = [];
  const siDict = container?.staticData?.StaticItems;
  const g = getStaticGraph(container);

  if (siDict) {
    for (const [pk, rawVal] of dictEntries(siDict)) {
      if (!pk.startsWith('flight-plan:')) continue;
      const item = resolveGraphNode(rawVal, g);
      const flight = _flightFromV3StaticItem(pk, item, g);
      if (flight) flights.push(flight);
    }
  }

  let csvPath = null;
  const cfg = readConfig(container);
  if (filePath && cfg && cfg.flightScheduleFile) {
    const candidate = path.join(path.dirname(filePath), cfg.flightScheduleFile + '.csv');
    if (fs.existsSync(candidate)) csvPath = candidate;
  }

  const worldStateData = flights.length > 0
    ? { fpEntries: flights.map((fl) => ({ k: fl._fpGuid })) }
    : null;

  return {
    flights,
    sceneryMaps,
    csvPath,
    before: '',
    after: '',
    arrayContent: '',
    originalBlocks: [],
    worldStateData,
    _rawText: null,
  };
}

function readSummary(container, { filePath = null, size = 0 } = {}) {
  const filename = filePath ? path.basename(filePath) : '';
  const { flights } = readFlights(container, filePath);
  if (!flights || flights.length === 0) {
    return { error: 'No WorldState flight data', filename, size };
  }
  const config = readConfigResolved(container);
  let arrivals = 0;
  let departures = 0;
  for (const fl of flights) {
    if ((fl.LandingTime || '').trim()) arrivals++;
    else if ((fl.OffBlockTime || '').trim()) departures++;
  }
  return {
    filename,
    path: filePath,
    size,
    flightCount: flights.length,
    arrivals,
    departures,
    startTime: config ? config.startTime : null,
    endTime: config ? config.endTime : null,
  };
}

// ─── Timelines ──────────────────────────────────────────────────

function readTimelines(container) {
  const md = container?.metaData || {};
  const weatherFrames = Array.isArray(md.WeatherFrames)
    ? md.WeatherFrames.map((f) => ({
        preset: f.preset || 'Sunny',
        time: f.time || '00:00:00',
      }))
    : [];

  const windFrames = Array.isArray(md.WindFrames)
    ? md.WindFrames.map((f) => ({
        direction: decodeWindDirectionDeg(f.direction),
        speed: decodeWindSpeedKnots(f.speed),
        time: f.time || '00:00:00',
      }))
    : [];

  const rt = md.RunwayTimeline;
  const runwayTimeline = rt
    ? {
        initialRunways: Array.isArray(rt.initialRunways) ? [...rt.initialRunways] : [],
        timeline: Array.isArray(rt.timeline)
          ? rt.timeline.map((entry) => ({
              time: entry.time || '00:00:00',
              changes: Array.isArray(entry.changes)
                ? entry.changes.map((ch) => ({ source: ch.source || '', dest: ch.dest || '' }))
                : [],
            }))
          : [],
      }
    : null;

  return {
    weatherTimeline: weatherFrames,
    windTimeline: windFrames,
    runwayTimeline: runwayTimeline || { initialRunways: [], timeline: [] },
    windSpeedUnit: 'knots',
  };
}

// ─── Runway Helpers & Pairs ─────────────────────────────────────

function _resolveRunwayPhysicalName(rwObj, g) {
  if (!rwObj || typeof rwObj !== 'object') return null;
  if (rwObj.PhysicalRunwayStaticItem) {
    const physObj = resolveGraphNode(rwObj.PhysicalRunwayStaticItem, g);
    if (physObj && typeof physObj.PhysicalName === 'string' && physObj.PhysicalName) {
      return physObj.PhysicalName;
    }
  }
  if (typeof rwObj.PhysicalName === 'string' && rwObj.PhysicalName) {
    return rwObj.PhysicalName;
  }
  return null;
}

function _resolveTaxiwayNodePos(nodeRef, g) {
  if (!nodeRef) return null;
  const node = resolveGraphNode(nodeRef, g);
  if (!node || typeof node !== 'object') return null;
  const posTuple = unwrapReactive(node.ReactivePosition, g);
  if (!Array.isArray(posTuple) || posTuple.length < 3) return null;
  return decodePosition3ToGu(posTuple);
}

function _resolveAirwayNodeObj(nodeRef, g) {
  if (!nodeRef) return null;
  const node = resolveGraphNode(nodeRef, g);
  if (!node || typeof node !== 'object' || !Array.isArray(node.Position)) return null;
  const pos = decodePosition3ToGu(node.Position);
  return { node, pos };
}

function readRunwayPairs(container) {
  const pkDict = container?.staticData?.PKStaticEntities;
  if (!pkDict) return [];
  const g = getStaticGraph(container);
  const groups = new Map();

  for (const [pk, rawVal] of dictEntries(pkDict)) {
    if (!pk.startsWith('runway:')) continue;
    const rw = resolveGraphNode(rawVal, g);
    if (!rw) continue;
    const name = rw.Name;
    const phys = _resolveRunwayPhysicalName(rw, g);
    if (!name || !phys || !phys.includes('/')) continue;
    if (!groups.has(phys)) groups.set(phys, []);
    const arr = groups.get(phys);
    if (!arr.includes(name)) arr.push(name);
  }

  const pairSet = new Set();
  for (const names of groups.values()) {
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        pairSet.add(names[i] + '|' + names[j]);
        pairSet.add(names[j] + '|' + names[i]);
      }
    }
  }
  if (pairSet.size === 0) return [];
  return Array.from(pairSet).sort().map((s) => {
    const [source, dest] = s.split('|');
    return { source, dest };
  });
}

// ─── Scenery Projections (Map / Overlays / Live Scenery) ────────

function readStandPositions(container) {
  const result = {};
  const pkDict = container?.staticData?.PKStaticEntities;
  if (!pkDict) return result;
  const g = getStaticGraph(container);

  for (const [pk, rawVal] of dictEntries(pkDict)) {
    if (!pk.startsWith('stand:')) continue;
    const st = resolveGraphNode(rawVal, g);
    if (!st || !st.Identifier) continue;
    const identifier = st.Identifier;
    const tailPos = _resolveTaxiwayNodePos(st.TailPosition, g);
    const nosePos = _resolveTaxiwayNodePos(st.NosePosition, g);

    if (tailPos && nosePos) {
      const dx = nosePos.x - tailPos.x;
      const dz = nosePos.z - tailPos.z;
      let heading = Math.atan2(-dz, dx) * RAD_TO_DEG;
      heading = ((heading % 360) + 360) % 360;
      result[identifier] = {
        x: (tailPos.x + nosePos.x) / 2,
        y: (tailPos.z + nosePos.z) / 2,
        heading,
        tailX: tailPos.x,
        tailZ: tailPos.z,
        noseX: nosePos.x,
        noseZ: nosePos.z,
      };
    } else if (tailPos) {
      result[identifier] = { x: tailPos.x, y: tailPos.z, heading: 0 };
    } else if (nosePos) {
      result[identifier] = { x: nosePos.x, y: nosePos.z, heading: 0 };
    }
  }
  return result;
}

function readAreas(container) {
  const result = {};
  const npk = container?.staticData?.NonPKStaticEntities;
  if (!Array.isArray(npk)) return result;
  const g = getStaticGraph(container);

  for (const rawEntry of npk) {
    const entry = resolveGraphNode(rawEntry, g);
    if (!entry || entry.$type !== 'ContextCross.Models.Area') continue;
    const areaType = Number(entry.AreaType);
    if (!Number.isFinite(areaType)) continue;
    const rawPts = unwrapReactive(entry.NodePositions, g);
    if (!Array.isArray(rawPts)) continue;
    const points = [];
    for (const pt of rawPts) {
      if (Array.isArray(pt) && pt.length >= 3) {
        const gu = decodePosition3ToGu(pt);
        points.push({ x: gu.x, z: gu.z });
      }
    }
    if (points.length >= 3) {
      if (!result[areaType]) result[areaType] = [];
      result[areaType].push({
        guid: String(entry.$id || result[areaType].length + 1),
        enabled: true,
        points,
      });
    }
  }
  return result;
}

function readRunwayThresholds(container) {
  const result = {};
  const pkDict = container?.staticData?.PKStaticEntities;
  if (!pkDict) return result;
  const g = getStaticGraph(container);

  for (const [pk, rawVal] of dictEntries(pkDict)) {
    if (!pk.startsWith('runway:')) continue;
    const rw = resolveGraphNode(rawVal, g);
    if (!rw) continue;
    const physName = _resolveRunwayPhysicalName(rw, g);
    if (!physName || !physName.includes('/') || result[physName]) continue;
    const tpRefs = unwrapTypedArray(rw.ThresholdPoints, g);
    if (!Array.isArray(tpRefs) || tpRefs.length < 2) continue;
    const p0 = _resolveTaxiwayNodePos(tpRefs[0], g);
    const p1 = _resolveTaxiwayNodePos(tpRefs[1], g);
    if (p0 && p1) {
      result[physName] = {
        thresholds: [
          { x: p0.x, z: p0.z },
          { x: p1.x, z: p1.z },
        ],
      };
    }
  }
  return result;
}

function readTaxiwayPaths(container) {
  const paths = [];
  const pkDict = container?.staticData?.PKStaticEntities;
  if (!pkDict) return { paths };
  const g = getStaticGraph(container);

  const standNodes = new Set();
  for (const [pk, rawVal] of dictEntries(pkDict)) {
    if (!pk.startsWith('stand:')) continue;
    const st = resolveGraphNode(rawVal, g);
    if (!st) continue;
    const tail = resolveGraphNode(st.TailPosition, g);
    const nose = resolveGraphNode(st.NosePosition, g);
    if (tail) standNodes.add(tail);
    if (nose) standNodes.add(nose);
  }

  for (const [pk, rawVal] of dictEntries(pkDict)) {
    if (!pk.startsWith('taxiway-segment:')) continue;
    const seg = resolveGraphNode(rawVal, g);
    if (!seg) continue;
    const name = seg.Name || '';
    const flags = seg.Flags != null ? Number(seg.Flags) : 1;
    const nodeRefs = unwrapReactive(seg.Nodes, g);
    if (!Array.isArray(nodeRefs) || nodeRefs.length < 2) continue;

    const segPoints = [];
    let isStandAccess = false;
    for (const nRef of nodeRefs) {
      const nodeObj = resolveGraphNode(nRef, g);
      if (!nodeObj) continue;
      if (standNodes.has(nodeObj)) isStandAccess = true;
      const posTuple = unwrapReactive(nodeObj.ReactivePosition, g);
      if (Array.isArray(posTuple) && posTuple.length >= 3) {
        const gu = decodePosition3ToGu(posTuple);
        segPoints.push({ x: gu.x, z: gu.z });
      }
    }
    if (segPoints.length >= 2) {
      paths.push({
        name,
        flags,
        points: segPoints,
        ...(isStandAccess && { isStandAccess: true }),
      });
    }
  }

  return { paths };
}

// ─── Route / Procedure Projections (STAR / APPR / SID / MISS) ───

function _iterRunways(container) {
  const out = [];
  const pkDict = container?.staticData?.PKStaticEntities;
  if (!pkDict) return out;
  const g = getStaticGraph(container);
  for (const [pk, rawVal] of dictEntries(pkDict)) {
    if (!pk.startsWith('runway:')) continue;
    const rw = resolveGraphNode(rawVal, g);
    if (!rw || !rw.Name) continue;
    const physName = _resolveRunwayPhysicalName(rw, g);
    if (physName && !physName.includes('/')) continue;
    out.push({ pk, rw, runwayName: rw.Name, physName: physName || rw.Name, g });
  }
  return out;
}

function readRouteMappingsByType(container, targetRouteType) {
  const routeRunwayMap = {};
  const runwayRouteMap = {};
  for (const { rw, runwayName, g } of _iterRunways(container)) {
    const routes = unwrapTypedArray(rw.Routes, g) || [];
    for (const rawRoute of routes) {
      const route = resolveGraphNode(rawRoute, g);
      if (!route || Number(route.RouteType) !== targetRouteType) continue;
      const routeName = route.Name;
      const airwayRefs = unwrapTypedArray(route.AirwayNodes, g) || [];
      if (routeName && airwayRefs.length > 0) {
        if (!routeRunwayMap[routeName]) routeRunwayMap[routeName] = [];
        if (!routeRunwayMap[routeName].includes(runwayName)) routeRunwayMap[routeName].push(runwayName);
        if (!runwayRouteMap[runwayName]) runwayRouteMap[runwayName] = [];
        if (!runwayRouteMap[runwayName].includes(routeName)) runwayRouteMap[runwayName].push(routeName);
      }
    }
  }
  return { routeRunwayMap, runwayRouteMap };
}

function buildRoutePaths(container, routeRunwayMap, targetRouteType = null) {
  const paths = {};
  if (!routeRunwayMap) return paths;
  const runwaysByName = new Map();
  for (const item of _iterRunways(container)) {
    if (!runwaysByName.has(item.runwayName)) runwaysByName.set(item.runwayName, item);
  }

  for (const [routeName, runways] of Object.entries(routeRunwayMap)) {
    const runwaySegments = [];
    for (const runway of runways) {
      const item = runwaysByName.get(runway);
      if (!item) continue;
      const routes = unwrapTypedArray(item.rw.Routes, item.g) || [];
      let matched = null;
      for (const rawRoute of routes) {
        const route = resolveGraphNode(rawRoute, item.g);
        if (!route || route.Name !== routeName) continue;
        if (targetRouteType != null && Number(route.RouteType) !== targetRouteType) continue;
        matched = route;
        break;
      }
      if (!matched) continue;
      const airwayRefs = unwrapTypedArray(matched.AirwayNodes, item.g) || [];
      const points = [];
      for (const ref of airwayRefs) {
        const res = _resolveAirwayNodeObj(ref, item.g);
        if (res) points.push({ x: res.pos.x, z: res.pos.z });
      }
      if (points.length >= 2) {
        runwaySegments.push({ runway, points });
      }
    }
    if (runwaySegments.length > 0) {
      paths[routeName] = runwaySegments;
    }
  }
  return paths;
}

function readStarRunwayMappings(container) {
  const { routeRunwayMap, runwayRouteMap } = readRouteMappingsByType(container, 0);
  return { starRunwayMap: routeRunwayMap, runwayStarMap: runwayRouteMap };
}

function readStarWaypoints(container) {
  const result = {};
  for (const { rw, runwayName, g } of _iterRunways(container)) {
    const routes = unwrapTypedArray(rw.Routes, g) || [];
    for (const rawRoute of routes) {
      const route = resolveGraphNode(rawRoute, g);
      if (!route || Number(route.RouteType) !== 0 || !route.Name) continue;
      const airwayRefs = unwrapTypedArray(route.AirwayNodes, g) || [];
      const waypoints = [];
      for (const ref of airwayRefs) {
        const res = _resolveAirwayNodeObj(ref, g);
        if (res && res.node.Name) {
          waypoints.push({ name: res.node.Name, x: res.pos.x, z: res.pos.z });
        }
      }
      if (waypoints.length > 0) {
        const key = route.Name + '|' + runwayName;
        if (!result[key]) result[key] = waypoints;
      }
    }
  }
  return result;
}

function _normalizeRunway(name) {
  if (!name) return '';
  return String(name).replace(/^0+(\d)/, '$1');
}

function _findV3Runway(container, runwayName) {
  if (!runwayName) return null;
  const items = _iterRunways(container);
  for (const item of items) {
    if (item.runwayName === runwayName) return item;
  }
  const norm = _normalizeRunway(runwayName);
  for (const item of items) {
    if (_normalizeRunway(item.runwayName) === norm) return item;
  }
  return null;
}

function resolveFlyApproachPoints(container, routeName, runwayName) {
  if (!routeName || !runwayName) return [];
  const item = _findV3Runway(container, runwayName);
  if (!item) return [];
  const routes = unwrapTypedArray(item.rw.Routes, item.g) || [];
  for (const rawRoute of routes) {
    const route = resolveGraphNode(rawRoute, item.g);
    if (!route || Number(route.RouteType) !== 0 || route.Name !== routeName) continue;
    const airwayRefs = unwrapTypedArray(route.AirwayNodes, item.g) || [];
    const points = [];
    for (const ref of airwayRefs) {
      const res = _resolveAirwayNodeObj(ref, item.g);
      if (res) points.push({ x: res.pos.x, y: res.pos.y, z: res.pos.z });
    }
    return points;
  }
  return [];
}

function resolveApproachProcedureData(container, runwayName, hintPosition) {
  if (!runwayName) return null;
  const item = _findV3Runway(container, runwayName);
  if (!item) return null;
  const { rw, g } = item;
  const routes = unwrapTypedArray(rw.Routes, g) || [];
  const variants = [];

  for (const rawRoute of routes) {
    const route = resolveGraphNode(rawRoute, g);
    if (!route || Number(route.RouteType) !== 1) continue;
    const airwayRefs = unwrapTypedArray(route.AirwayNodes, g) || [];
    if (airwayRefs.length < 2) continue;
    const points = [];
    for (const ref of airwayRefs) {
      const res = _resolveAirwayNodeObj(ref, g);
      if (res) points.push({ x: res.pos.x, y: res.pos.y, z: res.pos.z });
    }
    if (points.length >= 2) {
      variants.push({ pathPointList: points, firstPoint: points[0], routeName: route.Name || '' });
    }
  }

  if (variants.length === 0) return null;

  let chosen = variants[0];
  if (hintPosition && variants.length > 1) {
    let bestDist = Infinity;
    for (const v of variants) {
      const dx = v.firstPoint.x - hintPosition.x;
      const dz = v.firstPoint.z - hintPosition.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist) {
        bestDist = d2;
        chosen = v;
      }
    }
  }

  const pts = chosen.pathPointList;
  const lastPt = pts[pts.length - 1];
  const prevPt = pts[pts.length - 2];
  const dx = lastPt.x - prevPt.x;
  const dy = (lastPt.y || 0) - (prevPt.y || 0);
  const dz = lastPt.z - prevPt.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const approachDirection = len > 0 ? { x: dx / len, y: dy / len, z: dz / len } : { x: 0, y: 0, z: 1 };

  const tdPosRaw = _resolveTaxiwayNodePos(rw.TouchDownPoint, g);
  if (!tdPosRaw) {
    throw new Error(`[resolveApproachProcedureData] v3 runway "${runwayName}" has no TouchDownPoint.`);
  }
  const touchDownPosition = { x: tdPosRaw.x, y: 0, z: tdPosRaw.z };

  return {
    pathPointList: pts,
    touchDownPosition,
    approachDirection,
    initialPosition: { ...pts[0] },
    routeName: chosen.routeName,
  };
}

function readAirwayFixes(container) {
  const out = [];
  const pkDict = container?.staticData?.PKStaticEntities;
  if (!pkDict) return out;
  const g = getStaticGraph(container);
  for (const [pk, rawVal] of dictEntries(pkDict)) {
    if (!pk.startsWith('airway-node:')) continue;
    const node = resolveGraphNode(rawVal, g);
    if (!node || !node.Name || !FIX_NAME_RE.test(node.Name) || !Array.isArray(node.Position)) continue;
    const pos = decodePosition3ToGu(node.Position);
    out.push({
      pk,
      name: node.Name,
      osmId: Number(node.OsmId),
      x: pos.x,
      z: pos.z,
    });
  }
  return out;
}

/**
 * Extract active State=30 approach aircraft entries from checkpoint frames (used by
 * `buildApproachCache` for saveTimeOffsets estimation when present).
 */
function readApproachEntries(container, fileLabel = '') {
  const entries = [];
  if (!Array.isArray(container.frames) || container.frames.length === 0) return entries;
  const siDict = container?.staticData?.StaticItems || {};
  const sg = getStaticGraph(container);

  const fpStaticByPk = new Map();
  for (const [pk, rawVal] of dictEntries(siDict)) {
    if (pk.startsWith('flight-plan:')) {
      fpStaticByPk.set(pk, resolveGraphNode(rawVal, sg));
    }
  }

  for (let fi = 0; fi < container.frames.length; fi++) {
    const re = container.frames[fi]?.runtimeData?.RuntimeEntities;
    if (!re) continue;
    const rg = getRuntimeGraph(container, fi);
    for (const [rk, rawVal] of dictEntries(re)) {
      if (!rk.startsWith('aircraft:')) continue;
      const ac = resolveGraphNode(rawVal, rg);
      if (!ac) continue;
      const state = unwrapReactive(ac._state, rg);
      if (state !== 30) continue;
      const dyn = resolveGraphNode(ac.DynamicsData, rg);
      const params = dyn ? resolveGraphNode(dyn.DynamicsParams, rg) : null;
      if (!params || params.$type !== 'ContextCross.Dynamics.States.FlyApproachDynamicsParams') continue;

      const reg = rk.slice('aircraft:'.length);
      const fpStatic = fpStaticByPk.get('flight-plan:' + reg);
      const arrLeg = fpStatic?.InitialArrival ? resolveGraphNode(fpStatic.InitialArrival, sg) : null;
      const route = unwrapReactive(ac._route, rg) || arrLeg?.STAR || '';
      const runway = arrLeg?.Runway || '';
      const landingTimeTicks = arrLeg?.LandingTime ? Number(isoToDotNetTicks(arrLeg.LandingTime)) : 0;

      const appPointList = Array.isArray(params.AppPointList)
        ? params.AppPointList.map(decodePosition3ToGu)
        : [];
      const flyApproachPoints = Array.isArray(params.FlyApproachPathPointList)
        ? params.FlyApproachPathPointList.map(decodePosition3ToGu)
        : [];
      const progressRatio = params.ProgressRatio != null ? decodeQ32(params.ProgressRatio) : 0;
      const posRaw = unwrapReactive(ac._position, rg);
      const dirRaw = unwrapReactive(ac._direction, rg);

      entries.push({
        _file: fileLabel,
        aircraftGuid: rk,
        registration: reg,
        aircraftType: fpStatic?.AircraftType || '',
        route,
        runway,
        landingTimeTicks,
        progressRatio,
        appPointList,
        flyApproachPoints,
        position: Array.isArray(posRaw) ? decodePosition3ToGu(posRaw) : { x: 0, y: 0, z: 0 },
        direction: Array.isArray(dirRaw)
          ? { x: decodeQ32(dirRaw[0]), y: decodeQ32(dirRaw[1]), z: decodeQ32(dirRaw[2]) }
          : { x: 0, y: 0, z: 1 },
      });
    }
  }
  return entries;
}

// ─── OSM Pools & Geo-OSM Model ──────────────────────────────────

function readTaxiwayOsmPool(container) {
  const nodePool = new Set();
  const segPool = new Set();
  const segEntries = [];
  const pkDict = container?.staticData?.PKStaticEntities;
  if (pkDict) {
    const g = getStaticGraph(container);
    for (const [pk, rawVal] of dictEntries(pkDict)) {
      if (pk.startsWith('taxiway-node:')) {
        const n = resolveGraphNode(rawVal, g);
        const osm = n?.OsmId != null ? Number(n.OsmId) : null;
        if (osm != null && Number.isFinite(osm)) nodePool.add(osm);
      } else if (pk.startsWith('taxiway-segment:')) {
        const s = resolveGraphNode(rawVal, g);
        const osm = s?.OsmId != null ? Number(s.OsmId) : null;
        if (osm != null && Number.isFinite(osm)) {
          segPool.add(osm);
          segEntries.push(osm);
        }
      }
    }
  }
  return {
    nodeIds: [...nodePool].sort((a, b) => a - b),
    segIds: [...segPool].sort((a, b) => a - b),
    segEntries: [...segEntries].sort((a, b) => a - b),
    segEntriesTotal: segEntries.length,
  };
}

function readAirwayOsmPool(container) {
  const nodePool = new Set();
  const segPool = new Set();
  const segEntries = [];
  const pkDict = container?.staticData?.PKStaticEntities;
  if (pkDict) {
    const g = getStaticGraph(container);
    for (const [pk, rawVal] of dictEntries(pkDict)) {
      if (pk.startsWith('airway-node:')) {
        const n = resolveGraphNode(rawVal, g);
        const osm = n?.OsmId != null ? Number(n.OsmId) : null;
        if (osm != null && Number.isFinite(osm)) nodePool.add(osm);
      } else if (pk.startsWith('airway-segment:')) {
        const s = resolveGraphNode(rawVal, g);
        const osm = s?.OsmId != null ? Number(s.OsmId) : null;
        if (osm != null && Number.isFinite(osm)) {
          segPool.add(osm);
          segEntries.push(osm);
        }
      }
    }
  }
  return {
    nodeIds: [...nodePool].sort((a, b) => a - b),
    segIds: [...segPool].sort((a, b) => a - b),
    segEntries: [...segEntries].sort((a, b) => a - b),
    segEntriesTotal: segEntries.length,
  };
}

function buildTaxiwayModel(container) {
  const nodes = new Map();
  const osmByObj = new Map();
  const segments = [];
  const pkDict = container?.staticData?.PKStaticEntities;
  if (!pkDict) return { nodes, segments };
  const g = getStaticGraph(container);

  for (const [pk, rawVal] of dictEntries(pkDict)) {
    if (!pk.startsWith('taxiway-node:')) continue;
    const node = resolveGraphNode(rawVal, g);
    if (!node || node.OsmId == null) continue;
    const osm = Number(node.OsmId);
    const posTuple = unwrapReactive(node.ReactivePosition, g);
    if (Array.isArray(posTuple) && posTuple.length >= 3) {
      const gu = decodePosition3ToGu(posTuple);
      nodes.set(osm, { x: gu.x, z: gu.z });
      osmByObj.set(node, osm);
    }
  }

  for (const [pk, rawVal] of dictEntries(pkDict)) {
    if (!pk.startsWith('taxiway-segment:')) continue;
    const seg = resolveGraphNode(rawVal, g);
    if (!seg || seg.OsmId == null) continue;
    const osm = Number(seg.OsmId);
    const nodeRefs = unwrapReactive(seg.Nodes, g);
    if (!Array.isArray(nodeRefs)) continue;
    const nodeOsms = [];
    for (const nRef of nodeRefs) {
      const nodeObj = resolveGraphNode(nRef, g);
      const nOsm = nodeObj ? osmByObj.get(nodeObj) : null;
      if (nOsm != null) nodeOsms.push(nOsm);
    }
    if (nodeOsms.length >= 2) segments.push({ osm, nodeOsms });
  }

  return { nodes, segments };
}

function readScenery(container) {
  const sceneryMaps = readSceneryMaps(container);
  const standPositions = readStandPositions(container);
  const areaData = readAreas(container);
  const runwayThresholds = readRunwayThresholds(container);
  const taxiwayPaths = readTaxiwayPaths(container);
  const { starRunwayMap, runwayStarMap } = readStarRunwayMappings(container);
  const starWaypoints = readStarWaypoints(container);
  const { routeRunwayMap: sidRunwayMap, runwayRouteMap: runwaySidMap } = readRouteMappingsByType(container, 2);
  const { routeRunwayMap: missedAppMap, runwayRouteMap: runwayMissedAppMap } = readRouteMappingsByType(container, 3);
  const { routeRunwayMap: apprRunwayMap, runwayRouteMap: runwayApprMap } = readRouteMappingsByType(container, 1);
  const sidPaths = buildRoutePaths(container, sidRunwayMap, 2);
  const missedAppPaths = buildRoutePaths(container, missedAppMap, 3);
  const apprPaths = buildRoutePaths(container, apprRunwayMap, 1);
  const airwayNodes = readAirwayFixes(container);
  const runwayPairs = readRunwayPairs(container);

  return {
    sceneryMaps,
    standPositions,
    areaData,
    runwayThresholds,
    taxiwayPaths,
    starRunwayMap,
    runwayStarMap,
    starWaypoints,
    sidRunwayMap,
    runwaySidMap,
    sidPaths,
    missedAppMap,
    runwayMissedAppMap,
    missedAppPaths,
    apprRunwayMap,
    runwayApprMap,
    apprPaths,
    airwayNodes,
    runwayPairs,
  };
}

// ─── Ground & Air Painter SceneryGraph Projection ───────────────

function readSceneryGraph(container) {
  const graph = {
    nodes: [],
    segments: [],
    runways: [],
    areas: [],
    stands: [],
    airwayNodes: [],
    procedures: [],
  };
  const coordIndex = new Map();

  const meta = {
    nodeOrigPk: [],
    segOrigPk: [],
    runwayOrigPk: [],
    runwayOrigInfo: [],
    runwayEntriesOrig: [],
    runwayPavement: [],
    areaOrigId: [],
    standOrigPk: [],
    airwayNodeOrigPk: [],
    airwaySegOrigPk: [],
    deletedAirwayPks: [],
  };

  const pkDict = container?.staticData?.PKStaticEntities;
  const npkList = container?.staticData?.NonPKStaticEntities;
  const g = getStaticGraph(container);
  const nodeObjToIdx = new Map();

  const ensureNodeFromRef = (ref) => {
    if (!ref) return null;
    const obj = resolveGraphNode(ref, g);
    if (!obj) return null;
    if (nodeObjToIdx.has(obj)) return nodeObjToIdx.get(obj);
    const posTuple = unwrapReactive(obj.ReactivePosition, g);
    if (!Array.isArray(posTuple) || posTuple.length < 3) return null;
    const pos = decodePosition3ToGu(posTuple);
    const key = coordKey(pos.x, pos.z);
    let idx = coordIndex.get(key);
    if (idx == null) {
      idx = graph.nodes.length;
      graph.nodes.push({
        x: pos.x,
        z: pos.z,
        type: obj.Type != null ? Number(obj.Type) : null,
        flags: obj.Flags != null ? Number(obj.Flags) : null,
      });
      coordIndex.set(key, idx);
      meta.nodeOrigPk.push(obj.PK || null);
    }
    nodeObjToIdx.set(obj, idx);
    return idx;
  };

  if (pkDict) {
    // 1. taxiway-node
    for (const [pk, rawVal] of dictEntries(pkDict)) {
      if (!pk.startsWith('taxiway-node:')) continue;
      const obj = resolveGraphNode(rawVal, g);
      if (!obj) continue;
      const posTuple = unwrapReactive(obj.ReactivePosition, g);
      if (!Array.isArray(posTuple) || posTuple.length < 3) continue;
      const pos = decodePosition3ToGu(posTuple);
      const key = coordKey(pos.x, pos.z);
      let idx = coordIndex.get(key);
      if (idx == null) {
        idx = graph.nodes.length;
        graph.nodes.push({
          x: pos.x,
          z: pos.z,
          type: obj.Type != null ? Number(obj.Type) : null,
          flags: obj.Flags != null ? Number(obj.Flags) : null,
        });
        coordIndex.set(key, idx);
        meta.nodeOrigPk.push(pk);
      }
      nodeObjToIdx.set(obj, idx);
    }

    // 2. taxiway-segment
    for (const [pk, rawVal] of dictEntries(pkDict)) {
      if (!pk.startsWith('taxiway-segment:')) continue;
      const seg = resolveGraphNode(rawVal, g);
      if (!seg) continue;
      const nodeRefs = unwrapReactive(seg.Nodes, g);
      if (!Array.isArray(nodeRefs) || nodeRefs.length < 2) continue;
      const nodeIdxs = [];
      for (const nRef of nodeRefs) {
        const idx = ensureNodeFromRef(nRef);
        if (idx == null) continue;
        if (nodeIdxs.length === 0 || nodeIdxs[nodeIdxs.length - 1] !== idx) {
          nodeIdxs.push(idx);
        }
      }
      if (nodeIdxs.length < 2) continue;
      graph.segments.push({
        nodeIdxs,
        aIdx: nodeIdxs[0],
        bIdx: nodeIdxs[nodeIdxs.length - 1],
        name: seg.Name || undefined,
        flags: seg.Flags != null ? Number(seg.Flags) : null,
        directed: typeof seg.Directed === 'boolean' ? seg.Directed : undefined,
      });
      meta.segOrigPk.push(pk);
    }

    // 3. runway: collapse physical pairs
    const runwayByPhys = new Map();
    for (const [pk, rawVal] of dictEntries(pkDict)) {
      if (!pk.startsWith('runway:')) continue;
      const rw = resolveGraphNode(rawVal, g);
      if (!rw) continue;
      const physName = _resolveRunwayPhysicalName(rw, g);
      if (!physName) continue;
      const tpRefs = unwrapTypedArray(rw.ThresholdPoints, g);
      if (!Array.isArray(tpRefs) || tpRefs.length < 2) continue;
      const aIdx = ensureNodeFromRef(tpRefs[0]);
      const bIdx = ensureNodeFromRef(tpRefs[1]);
      if (aIdx == null || bIdx == null) continue;
      const widthGu = rw.Width != null ? decodeQ32(rw.Width) * 0.01 : 0;
      let rec = runwayByPhys.get(physName);
      if (!rec) {
        rec = { entries: [], th: [aIdx, bIdx], width: widthGu };
        runwayByPhys.set(physName, rec);
      }
      rec.entries.push({ pk, rw, tpIdxs: [aIdx, bIdx] });
    }

    const physToGraphIdx = new Map();
    for (const [physName, rec] of runwayByPhys) {
      const first = rec.entries[0];
      let nameA = null;
      let nameB = null;
      for (const en of rec.entries) {
        const [ai, bi] = en.tpIdxs;
        const n = en.rw.Name;
        if (ai === rec.th[0] && bi === rec.th[1]) nameA = n;
        else if (ai === rec.th[1] && bi === rec.th[0]) nameB = n;
      }
      const split = physName.split('/');
      if (!nameA) nameA = split[0] || first.rw.Name || '01';
      if (!nameB) nameB = split[1] || (nameA === '01' ? '19' : '01');

      const gIdx = graph.runways.length;
      physToGraphIdx.set(physName, gIdx);
      graph.runways.push({
        thAIdx: rec.th[0],
        thBIdx: rec.th[1],
        names: [nameA, nameB],
        name: nameA,
        physicalName: physName,
        width: rec.width,
        entries: [],
        exits: [],
      });
      meta.runwayOrigPk.push(first.pk);
      meta.runwayOrigInfo.push({
        pks: rec.entries.map((en) => en.pk),
        physicalName: physName,
        names: [nameA, nameB],
        width: rec.width,
      });
    }

    // Aggregate runway entries / exits
    for (const [physName, rec] of runwayByPhys) {
      const gIdx = physToGraphIdx.get(physName);
      const gRw = graph.runways[gIdx];
      if (!gRw) continue;
      for (const dirRec of rec.entries) {
        const dirName = dirRec.rw.Name || '';
        const rawEntries = unwrapTypedArray(dirRec.rw.Entries, g) || [];
        for (const rawEn of rawEntries) {
          const en = resolveGraphNode(rawEn, g);
          if (!en) continue;
          gRw.entries.push({
            name: en.Name || '',
            runwayName: dirName,
            holdingIdx: ensureNodeFromRef(en.HoldingPosition),
            lineUpIdx: ensureNodeFromRef(en.LineUpPosition),
            defineIdx: ensureNodeFromRef(en.DefinePoint),
          });
        }
        const rawExits = unwrapTypedArray(dirRec.rw.Exits, g) || [];
        for (const rawEx of rawExits) {
          const ex = resolveGraphNode(rawEx, g);
          if (!ex) continue;
          gRw.exits.push({
            name: ex.Name || '',
            runwayName: dirName,
            exitIdx: ensureNodeFromRef(ex.ExitPosition),
            holdingIdx: ensureNodeFromRef(ex.HoldingPosition),
            defineIdx: ensureNodeFromRef(ex.DefinePoint),
            isLeft: !!ex.IsLeft,
          });
        }
      }
    }

    meta.runwayEntriesOrig = graph.runways.map((rw) => ({
      entries: structuredClone(rw.entries || []),
      exits: structuredClone(rw.exits || []),
    }));

    for (let r = 0; r < graph.runways.length; r++) {
      const physName = graph.runways[r].physicalName;
      const chainNodes = [];
      const seen = new Set();
      for (const s of graph.segments) {
        if (s.name !== physName) continue;
        for (const ni of (s.nodeIdxs || [s.aIdx, s.bIdx])) {
          if (seen.has(ni)) continue;
          seen.add(ni);
          chainNodes.push(ni);
        }
      }
      meta.runwayPavement.push(chainNodes);
    }

    // 4. stand
    for (const [pk, rawVal] of dictEntries(pkDict)) {
      if (!pk.startsWith('stand:')) continue;
      const st = resolveGraphNode(rawVal, g);
      if (!st) continue;
      const noseIdx = ensureNodeFromRef(st.NosePosition);
      const tailIdx = ensureNodeFromRef(st.TailPosition);
      if (noseIdx == null || tailIdx == null) continue;
      const pushbackIdxs = [];
      for (const pbRef of unwrapTypedArray(st.PushbackLimitPositions, g) || []) {
        const pIdx = ensureNodeFromRef(pbRef);
        if (pIdx != null) pushbackIdxs.push(pIdx);
      }
      const heading = _headingDeg(graph.nodes[noseIdx], graph.nodes[tailIdx]);
      const standName = st.Name || '';
      const standIdent = st.Identifier || '';
      graph.stands.push({
        noseIdx,
        tailIdx,
        heading,
        pushbackIdxs,
        parkingType: st.ParkingType != null ? Number(st.ParkingType) : 0,
        egressType: st.EgressType != null ? Number(st.EgressType) : 0,
        name: standName || standIdent || '',
        identifier: standIdent || standName || '',
      });
      meta.standOrigPk.push(pk);
    }
  }

  // 5. NonPK areas
  if (Array.isArray(npkList)) {
    for (let i = 0; i < npkList.length; i++) {
      const area = resolveGraphNode(npkList[i], g);
      if (!area || area.$type !== 'ContextCross.Models.Area') continue;
      const areaType = area.AreaType != null ? Number(area.AreaType) : null;
      const rawPts = unwrapReactive(area.NodePositions, g);
      if (areaType == null || !Array.isArray(rawPts)) continue;
      const points = [];
      for (const pt of rawPts) {
        if (Array.isArray(pt) && pt.length >= 3) {
          const gu = decodePosition3ToGu(pt);
          points.push({ x: gu.x, z: gu.z });
        }
      }
      if (points.length >= 3) {
        const origId = area.$id != null ? parseInt(String(area.$id), 10) : (i + 1);
        graph.areas.push({
          areaType,
          points,
          owner: null,
          _origId: origId,
          _v3AreaSlotIdx: i,
        });
        meta.areaOrigId.push(origId);
      }
    }
  }

  // 6. Air-side: airwayNodes + procedures
  if (pkDict) {
    const airwayObjToIdx = new Map();
    for (const [pk, rawVal] of dictEntries(pkDict)) {
      if (!pk.startsWith('airway-node:')) continue;
      const anode = resolveGraphNode(rawVal, g);
      if (!anode || !Array.isArray(anode.Position) || anode.Position.length < 3) continue;
      const pos = decodePosition3ToGu(anode.Position);
      const idx = graph.airwayNodes.length;
      graph.airwayNodes.push({
        x: pos.x,
        z: pos.z,
        name: anode.Name || '',
      });
      meta.airwayNodeOrigPk.push(pk);
      airwayObjToIdx.set(anode, idx);
    }

    const segPkByName = new Map();
    for (const [pk, rawVal] of dictEntries(pkDict)) {
      if (!pk.startsWith('airway-segment:')) continue;
      const aseg = resolveGraphNode(rawVal, g);
      const nm = aseg?.Name || '';
      if (nm && !segPkByName.has(nm)) segPkByName.set(nm, pk);
    }

    const seenRoute = new Set();
    for (const [pk, rawVal] of dictEntries(pkDict)) {
      if (!pk.startsWith('runway:')) continue;
      const rw = resolveGraphNode(rawVal, g);
      if (!rw || !rw.Name) continue;
      const rwName = rw.Name;
      const routes = unwrapTypedArray(rw.Routes, g) || [];
      for (const rawRoute of routes) {
        const rObj = resolveGraphNode(rawRoute, g);
        if (!rObj || rObj.Name == null || rObj.RouteType == null) continue;
        const rName = rObj.Name;
        const rType = Number(rObj.RouteType);
        const airwayRefs = unwrapTypedArray(rObj.AirwayNodes, g) || [];
        const nodeIdxs = [];
        for (const ref of airwayRefs) {
          const aObj = resolveGraphNode(ref, g);
          const aIdx = aObj ? airwayObjToIdx.get(aObj) : null;
          if (aIdx != null) nodeIdxs.push(aIdx);
        }
        if (nodeIdxs.length < 2) continue;
        const rkey = rName + '|' + nodeIdxs.join(',') + '|' + rwName;
        if (seenRoute.has(rkey)) continue;
        seenRoute.add(rkey);
        graph.procedures.push({
          name: rName,
          routeType: rType,
          runwayName: rwName,
          airwayNodeIdxs: nodeIdxs,
          _routeCarried: true,
        });
        meta.airwaySegOrigPk.push(segPkByName.get(rName) || '@route');
      }
    }
  }

  return { graph, meta };
}

module.exports = {
  getStaticGraph,
  getRuntimeGraph,
  invalidateContainerCaches,
  isoToEditorTime,
  isoToDotNetTicks,
  readConfig,
  readCurrentDateTime,
  readGameTimeSec,
  readConfigResolved,
  readSceneryMaps,
  readFlights,
  readSummary,
  readTimelines,
  readRunwayPairs,
  readStandPositions,
  readAreas,
  readRunwayThresholds,
  readTaxiwayPaths,
  readRouteMappingsByType,
  buildRoutePaths,
  readStarRunwayMappings,
  readStarWaypoints,
  resolveFlyApproachPoints,
  resolveApproachProcedureData,
  readAirwayFixes,
  readApproachEntries,
  readTaxiwayOsmPool,
  readAirwayOsmPool,
  buildTaxiwayModel,
  readScenery,
  readSceneryGraph,
};
