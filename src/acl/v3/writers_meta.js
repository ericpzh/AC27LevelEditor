'use strict';

/**
 * GATCARC4 v3 MetaData & Timeline Writer (`src/acl/v3/writers_meta.js`).
 *
 * Updates `MetaData.Config`, `MetaData.WeatherFrames`, `MetaData.WindFrames`,
 * and `MetaData.RunwayTimeline` in-place while preserving exact raw Q32.32
 * signed 64-bit integers on any unedited fields/frames.
 */

const {
  decodeQ32,
  encodeQ32,
  decodeRadiansQ32ToDeg,
  encodeDegToRadiansQ32,
  decodeWindDirectionDeg,
  decodeWindSpeedKnots,
  encodeWindSpeedFromKnots,
  MPS_TO_KT,
} = require('./q32');

function normalizeClockTime(t) {
  if (typeof t !== 'string' || !t.trim()) return '00:00:00';
  const s = t.trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  if (!m) return s;
  const hh = String(parseInt(m[1], 10)).padStart(2, '0');
  const mm = m[2];
  const ss = m[3] || '00';
  return m[4] ? `${hh}:${mm}:${ss}.${m[4]}` : `${hh}:${mm}:${ss}`;
}

function extractFrameArray(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object' && Array.isArray(input.frames)) {
    return input.frames;
  }
  return null;
}

function applyConfigEdits(md, configPatch) {
  if (!configPatch || typeof configPatch !== 'object') return false;
  if (!md.Config || typeof md.Config !== 'object') {
    md.Config = {};
  }
  const cfg = md.Config;
  let changed = false;

  const stringFields = [
    'channelFile',
    'endTime',
    'flightScheduleFile',
    'generatedTaxiNavigationDataFile',
    'geoDataFile',
    'name',
    'prototypeName',
    'radioAudioClipNamesFileEN',
    'radioAudioClipNamesFileZH',
    'radioTemplateFileEN',
    'radioTemplateFileZH',
    'startTime',
    'taxiNavigationDataFile',
    'visualGeoDataFile',
  ];
  for (const key of stringFields) {
    if (configPatch[key] !== undefined && configPatch[key] !== cfg[key]) {
      cfg[key] = configPatch[key] === null ? null : String(configPatch[key]);
      changed = true;
    }
  }

  for (const boolKey of ['isSurfaceRadarTrafficHidden', 'usePercentOffset']) {
    if (typeof configPatch[boolKey] === 'boolean' && configPatch[boolKey] !== cfg[boolKey]) {
      cfg[boolKey] = configPatch[boolKey];
      changed = true;
    }
  }

  if (Number.isInteger(configPatch.tutorialScenario) && configPatch.tutorialScenario !== cfg.tutorialScenario) {
    cfg.tutorialScenario = configPatch.tutorialScenario;
    changed = true;
  }

  // Displacement2 `offset` in meters
  if (configPatch.offset && typeof configPatch.offset === 'object') {
    const curX = Array.isArray(cfg.offset) ? decodeQ32(cfg.offset[0], 'Config.offset[0]') : 0;
    const curY = Array.isArray(cfg.offset) ? decodeQ32(cfg.offset[1], 'Config.offset[1]') : 0;
    const nextX = Array.isArray(configPatch.offset) ? Number(configPatch.offset[0]) : Number(configPatch.offset.x ?? curX);
    const nextY = Array.isArray(configPatch.offset) ? Number(configPatch.offset[1]) : Number(configPatch.offset.y ?? curY);
    if (Number.isFinite(nextX) && Number.isFinite(nextY)) {
      if (!Array.isArray(cfg.offset) || Math.abs(curX - nextX) > 1e-9 || Math.abs(curY - nextY) > 1e-9) {
        cfg.offset = [
          Math.abs(curX - nextX) <= 1e-9 && Array.isArray(cfg.offset) ? cfg.offset[0] : encodeQ32(nextX, 'Config.offset[0]'),
          Math.abs(curY - nextY) <= 1e-9 && Array.isArray(cfg.offset) ? cfg.offset[1] : encodeQ32(nextY, 'Config.offset[1]'),
        ];
        changed = true;
      }
    }
  }

  if (typeof configPatch.offsetDistance === 'number' && Number.isFinite(configPatch.offsetDistance)) {
    const cur = cfg.offsetDistance != null ? decodeQ32(cfg.offsetDistance, 'Config.offsetDistance') : NaN;
    if (!Number.isFinite(cur) || Math.abs(cur - configPatch.offsetDistance) > 1e-9) {
      cfg.offsetDistance = encodeQ32(configPatch.offsetDistance, 'Config.offsetDistance');
      changed = true;
    }
  }

  const nextOffsetRatio = typeof configPatch.offsetRatio === 'number'
    ? configPatch.offsetRatio
    : (typeof configPatch.offsetPercent === 'number' ? configPatch.offsetPercent / 100 : undefined);
  if (typeof nextOffsetRatio === 'number' && Number.isFinite(nextOffsetRatio)) {
    const cur = cfg.offsetRatio != null ? decodeQ32(cfg.offsetRatio, 'Config.offsetRatio') : NaN;
    if (!Number.isFinite(cur) || Math.abs(cur - nextOffsetRatio) > 1e-9) {
      cfg.offsetRatio = encodeQ32(nextOffsetRatio, 'Config.offsetRatio');
      changed = true;
    }
  }

  if (typeof configPatch.scaleFactor === 'number' && Number.isFinite(configPatch.scaleFactor)) {
    const cur = cfg.scaleFactor != null ? decodeQ32(cfg.scaleFactor, 'Config.scaleFactor') : NaN;
    if (!Number.isFinite(cur) || Math.abs(cur - configPatch.scaleFactor) > 1e-11) {
      cfg.scaleFactor = encodeQ32(configPatch.scaleFactor, 'Config.scaleFactor');
      changed = true;
    }
  }

  const nextLatDeg = typeof configPatch.referenceLatitude === 'number'
    ? configPatch.referenceLatitude
    : (typeof configPatch.refPoint?.lat === 'number' ? configPatch.refPoint.lat : undefined);
  if (typeof nextLatDeg === 'number' && Number.isFinite(nextLatDeg)) {
    const curDeg = cfg.referenceLatitude != null ? decodeRadiansQ32ToDeg(cfg.referenceLatitude) : NaN;
    if (!Number.isFinite(curDeg) || Math.abs(curDeg - nextLatDeg) > 1e-9) {
      cfg.referenceLatitude = encodeDegToRadiansQ32(nextLatDeg);
      changed = true;
    }
  }

  const nextLonDeg = typeof configPatch.referenceLongitude === 'number'
    ? configPatch.referenceLongitude
    : (typeof configPatch.refPoint?.lon === 'number' ? configPatch.refPoint.lon : undefined);
  if (typeof nextLonDeg === 'number' && Number.isFinite(nextLonDeg)) {
    const curDeg = cfg.referenceLongitude != null ? decodeRadiansQ32ToDeg(cfg.referenceLongitude) : NaN;
    if (!Number.isFinite(curDeg) || Math.abs(curDeg - nextLonDeg) > 1e-9) {
      cfg.referenceLongitude = encodeDegToRadiansQ32(nextLonDeg);
      changed = true;
    }
  }

  if (typeof editBaseTimeFromPatch(configPatch) === 'string') {
    const nextBt = editBaseTimeFromPatch(configPatch);
    if (nextBt !== md.BaseTime) {
      md.BaseTime = nextBt;
      changed = true;
    }
  }

  return changed;
}

function editBaseTimeFromPatch(configPatch) {
  if (typeof configPatch.baseTime === 'string' && configPatch.baseTime) {
    return configPatch.baseTime;
  }
  return null;
}

function applyWeatherTimelineEdits(md, weatherInput) {
  const frames = extractFrameArray(weatherInput);
  if (!frames) return false;

  const prev = Array.isArray(md.WeatherFrames) ? md.WeatherFrames : [];
  const next = frames.map((f) => ({
    preset: String(f?.preset ?? f?.weather ?? 'Sunny'),
    time: normalizeClockTime(f?.time),
  }));

  if (prev.length === next.length) {
    let identical = true;
    for (let i = 0; i < next.length; i++) {
      if (prev[i]?.preset !== next[i].preset || prev[i]?.time !== next[i].time) {
        identical = false;
        break;
      }
    }
    if (identical) return false;
  }

  md.WeatherFrames = next;
  return true;
}

function applyWindTimelineEdits(md, windInput, windSpeedUnit = 'knots') {
  const frames = extractFrameArray(windInput);
  if (!frames) return false;

  const prev = Array.isArray(md.WindFrames) ? md.WindFrames : [];
  const unitIsMps = String(windSpeedUnit || 'knots').toLowerCase() === 'mps';

  // Build reusable pool of existing raw frames so unedited entries keep exact Q32.32 BigInt/int values
  const usedPrevIdx = new Set();
  const findMatchingPrev = (timeStr, degVal, speedVal) => {
    const normDeg = (((Math.round(degVal) % 360) + 360) % 360);
    for (let i = 0; i < prev.length; i++) {
      if (usedPrevIdx.has(i)) continue;
      const pf = prev[i];
      if (!pf || normalizeClockTime(pf.time) !== timeStr) continue;
      const pDeg = decodeWindDirectionDeg(pf.direction);
      if (pDeg !== normDeg) continue;
      if (unitIsMps) {
        const pMps = decodeQ32(pf.speed, 'wind.speed');
        if (Math.abs(pMps - speedVal) <= 1e-4) {
          usedPrevIdx.add(i);
          return pf;
        }
      } else {
        const pKt = decodeWindSpeedKnots(pf.speed);
        if (Math.abs(pKt - speedVal) <= 1e-4 || Math.abs(decodeQ32(pf.speed, 'wind.speed') * MPS_TO_KT - speedVal) <= 1e-4) {
          usedPrevIdx.add(i);
          return pf;
        }
      }
    }
    return null;
  };

  let changed = prev.length !== frames.length;
  const next = frames.map((f, idx) => {
    const time = normalizeClockTime(f?.time);
    const degNum = Number(f?.direction ?? 0);
    const spdNum = Number(f?.speed ?? 0);
    if (!Number.isFinite(degNum)) {
      throw new RangeError(`WindFrames[${idx}].direction must be finite, got ${f?.direction}`);
    }
    if (!Number.isFinite(spdNum) || spdNum < 0) {
      throw new RangeError(`WindFrames[${idx}].speed must be non-negative finite, got ${f?.speed}`);
    }

    const matched = findMatchingPrev(time, degNum, spdNum);
    if (matched) {
      if (prev[idx] !== matched || matched.time !== time) {
        changed = true;
      }
      return {
        direction: matched.direction,
        speed: matched.speed,
        time,
      };
    }

    changed = true;
    const normDeg = ((degNum % 360) + 360) % 360;
    const rawDir = encodeDegToRadiansQ32(normDeg);
    const rawSpd = unitIsMps
      ? encodeQ32(spdNum, 'wind.speed')
      : encodeWindSpeedFromKnots(spdNum);
    return {
      direction: rawDir,
      speed: rawSpd,
      time,
    };
  });

  if (!changed) return false;
  md.WindFrames = next;
  return true;
}

function applyRunwayTimelineEdits(md, rwyInput) {
  if (!rwyInput || typeof rwyInput !== 'object') return false;

  const prev = md.RunwayTimeline || { initialRunways: [], timeline: [] };
  const nextInitial = Array.isArray(rwyInput.initialRunways)
    ? rwyInput.initialRunways.map((r) => String(r ?? '').trim()).filter(Boolean)
    : (Array.isArray(prev.initialRunways) ? [...prev.initialRunways] : []);

  const rawTimeline = Array.isArray(rwyInput.timeline) ? rwyInput.timeline : [];
  const nextTimeline = rawTimeline.map((frame) => {
    const rawChanges = Array.isArray(frame?.changes) ? frame.changes : [];
    return {
      changes: rawChanges.map((ch) => ({
        dest: String(ch?.dest ?? ch?.Dest ?? ''),
        source: String(ch?.source ?? ch?.Source ?? ''),
      })),
      time: normalizeClockTime(frame?.time ?? frame?.Time),
    };
  });

  const prevInitial = Array.isArray(prev.initialRunways) ? prev.initialRunways : [];
  const prevTimeline = Array.isArray(prev.timeline) ? prev.timeline : [];

  let identical = prevInitial.length === nextInitial.length && prevTimeline.length === nextTimeline.length;
  if (identical) {
    for (let i = 0; i < nextInitial.length; i++) {
      if (prevInitial[i] !== nextInitial[i]) {
        identical = false;
        break;
      }
    }
  }
  if (identical) {
    for (let i = 0; i < nextTimeline.length; i++) {
      const pf = prevTimeline[i];
      const nf = nextTimeline[i];
      if (!pf || pf.time !== nf.time) {
        identical = false;
        break;
      }
      const pc = Array.isArray(pf.changes) ? pf.changes : [];
      if (pc.length !== nf.changes.length) {
        identical = false;
        break;
      }
      for (let j = 0; j < nf.changes.length; j++) {
        if (pc[j]?.source !== nf.changes[j].source || pc[j]?.dest !== nf.changes[j].dest) {
          identical = false;
          break;
        }
      }
      if (!identical) break;
    }
  }

  if (identical) return false;

  md.RunwayTimeline = {
    initialRunways: nextInitial,
    timeline: nextTimeline,
  };
  return true;
}

function applyMetaEdits(container, editIntent = {}) {
  if (!container || !container.metaData) {
    throw new Error('applyMetaEdits: container.metaData is missing');
  }
  const md = container.metaData;
  let dirty = false;

  if (editIntent.config) {
    if (applyConfigEdits(md, editIntent.config)) dirty = true;
  }
  if (editIntent.weatherTimeline !== undefined && editIntent.weatherTimeline !== null) {
    if (applyWeatherTimelineEdits(md, editIntent.weatherTimeline)) dirty = true;
  }
  if (editIntent.windTimeline !== undefined && editIntent.windTimeline !== null) {
    if (applyWindTimelineEdits(md, editIntent.windTimeline, editIntent.windSpeedUnit || 'knots')) dirty = true;
  }
  if (editIntent.runwayTimeline !== undefined && editIntent.runwayTimeline !== null) {
    if (applyRunwayTimelineEdits(md, editIntent.runwayTimeline)) dirty = true;
  }

  if (dirty) {
    container.dirtyMetaData = true;
  }
  return { metaUpdated: dirty };
}

module.exports = {
  normalizeClockTime,
  applyMetaEdits,
};
