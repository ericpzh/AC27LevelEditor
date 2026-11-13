'use strict';

/**
 * Legacy & GATCARC4 v2 Archive Handler (`src/acl/legacy_handler.js`).
 *
 * Wraps `src/acl/gatcarc.js` and Odin-backed readers/writers behind the unified
 * archive handler interface while keeping Odin-specific modules (`acl_document.js`,
 * `acl_json.js`, `tokenizer.js`, `id_renumber.js`, `v4_pk_index.js`, `src/acl/odin/`)
 * strictly on the legacy side.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256 } = require('./framing');
const {
  isGatcArchive,
  getStorageVersion,
  decodeArchive,
  parseV2Archive,
  encodeArchive,
  encodeV2Archive,
} = require('./gatcarc');
const { StaleSourceError } = require('./v3/handler');

function _decodeLegacyBytesToText(buf) {
  if (isGatcArchive(buf)) {
    const version = getStorageVersion(buf);
    const aclText = decodeArchive(buf);
    let headerObj = null;
    if (version === 2) {
      try {
        headerObj = JSON.parse(parseV2Archive(buf).header.payload.toString('utf8'));
      } catch (_) {}
    }
    const guidMatch = !headerObj ? aclText.match(/"ArchiveGuid"\s*:\s*"([^"]+)"/) : null;
    return {
      text: aclText,
      version,
      archiveGuid: headerObj?.archiveGuid || (guidMatch ? guidMatch[1] : null),
      levelGuid: headerObj?.levelGuid || null,
      airportIcao: headerObj?.airportIcao || null,
    };
  }
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const guidMatch = text.match(/"ArchiveGuid"\s*:\s*"([^"]+)"/);
  return {
    text,
    version: 0,
    archiveGuid: guidMatch ? guidMatch[1] : null,
    levelGuid: null,
    airportIcao: null,
  };
}

function _openOdinBackedAcl(bytes, expectedFormat, options = {}) {
  const buf = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes);
  let sourceBytes = buf;
  const decoded = _decodeLegacyBytesToText(buf);
  let currentText = decoded.text;
  const storageVersion = decoded.version;

  let filePath = options.filePath || null;
  let sourceSize = options.sourceSize != null ? options.sourceSize : buf.length;
  let sourceMtimeMs = options.sourceMtimeMs != null ? options.sourceMtimeMs : null;
  let sourceSha256 = options.sourceSha256 || sha256(buf).toString('hex');
  let dirtyText = false;

  const handle = {
    format: expectedFormat,
    storageVersion,
    get filePath() { return filePath; },
    get sourceSize() { return sourceSize; },
    get sourceMtimeMs() { return sourceMtimeMs; },
    get sourceSha256() { return sourceSha256; },
    get archiveGuid() { return decoded.archiveGuid; },
    get levelGuid() { return decoded.levelGuid; },
    get airportIcao() { return decoded.airportIcao; },
    get rawText() { return currentText; },

    // ─── Editor-shaped reads ──────────────────────────────────
    readConfig: () => {
      const { _extractConfig } = require('./flight_plans');
      return _extractConfig(currentText);
    },

    readConfigResolved: () => {
      const { resolveConfigTime } = require('./config');
      return resolveConfigTime(currentText);
    },

    readCurrentDateTime: () => {
      const { extractCurrentDateTime } = require('./parser');
      return extractCurrentDateTime(currentText);
    },

    readGameTimeSec: () => {
      const { extractGameTime } = require('./approach');
      return extractGameTime(currentText);
    },

    readFlights: (fpOverride = filePath) => {
      const { _parseSceneryData } = require('./scenery');
      const { _parseWorldStateFlightPlans, _extractConfig } = require('./flight_plans');
      const sceneryMaps = _parseSceneryData(currentText);
      let flights = [];
      let worldStateData = null;
      const fpResult = _parseWorldStateFlightPlans(currentText);
      if (fpResult && fpResult.flights && fpResult.flights.length > 0 && fpResult.fpData) {
        flights = fpResult.flights;
        worldStateData = fpResult.fpData;
      }
      let csvPath = null;
      const config = _extractConfig(currentText);
      if (fpOverride && config && config.flightScheduleFile) {
        const candidate = path.join(path.dirname(fpOverride), config.flightScheduleFile + '.csv');
        if (fs.existsSync(candidate)) csvPath = candidate;
      }
      return {
        flights,
        sceneryMaps,
        csvPath,
        before: '',
        after: '',
        arrayContent: '',
        originalBlocks: [],
        worldStateData,
        _rawText: currentText,
      };
    },

    readSummary: (opts = {}) => {
      const targetPath = opts.filePath || filePath || '';
      const size = opts.size != null ? opts.size : sourceSize;
      const { _parseWorldStateFlightPlans } = require('./flight_plans');
      const { resolveConfigTime } = require('./config');
      const fpResult = _parseWorldStateFlightPlans(currentText);
      const flights = (fpResult && fpResult.flights) ? fpResult.flights : [];
      if (!flights || flights.length === 0) {
        return { error: 'No WorldState flight data', filename: path.basename(targetPath), size };
      }
      const config = resolveConfigTime(currentText);
      let arrivals = 0;
      let departures = 0;
      for (const fl of flights) {
        if ((fl.LandingTime || '').trim()) arrivals++;
        else if ((fl.OffBlockTime || '').trim()) departures++;
      }
      return {
        filename: path.basename(targetPath),
        path: targetPath || null,
        size,
        flightCount: flights.length,
        arrivals,
        departures,
        startTime: config ? config.startTime : null,
        endTime: config ? config.endTime : null,
      };
    },

    readTimelines: () => {
      const { _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline } = require('./flight_plans');
      const weatherFrames = _parseWeatherFrames(currentText) || [];
      const windFrames = _parseWindFrames(currentText) || [];
      const runwayTimeline = _parseRunwayTimeline(currentText) || { initialRunways: [], timeline: [] };
      let windSpeedUnit = 'knots';
      if (filePath) {
        try {
          const airportConfigPath = path.join(path.dirname(path.dirname(filePath)), 'airport_config.json');
          if (fs.existsSync(airportConfigPath)) {
            const acJson = JSON.parse(fs.readFileSync(airportConfigPath, 'utf-8'));
            if (acJson.windSpeedUnit) windSpeedUnit = acJson.windSpeedUnit;
          }
        } catch (_) {}
      }
      return {
        weatherTimeline: weatherFrames,
        windTimeline: windFrames,
        runwayTimeline,
        windSpeedUnit,
      };
    },

    readRunwayPairs: () => {
      const { extractV4RunwayPairs } = require('./utils');
      const { _parseRunwayTimeline } = require('./flight_plans');
      const v4Pairs = extractV4RunwayPairs(currentText);
      if (v4Pairs && v4Pairs.length > 0) return v4Pairs;
      const data = _parseRunwayTimeline(currentText);
      if (!data || !Array.isArray(data.timeline)) return [];
      const pairSet = new Set();
      for (const entry of data.timeline) {
        if (!Array.isArray(entry.changes)) continue;
        for (const ch of entry.changes) {
          if (ch.source && ch.dest) {
            pairSet.add(ch.source + '|' + ch.dest);
            pairSet.add(ch.dest + '|' + ch.source);
          }
        }
      }
      return Array.from(pairSet).sort().map((s) => {
        const [source, dest] = s.split('|');
        return { source, dest };
      });
    },

    readSceneryMaps: () => {
      const { _parseSceneryData } = require('./scenery');
      return _parseSceneryData(currentText);
    },

    readStandPositions: () => {
      const { _parseStandPositions } = require('./scenery');
      return _parseStandPositions(currentText);
    },

    readAreas: () => {
      const { _parseAreas } = require('./scenery');
      return _parseAreas(currentText);
    },

    readRunwayThresholds: () => {
      const { _parseRunwayThresholds } = require('./approach');
      return _parseRunwayThresholds(currentText);
    },

    readTaxiwayPaths: () => {
      const { parseTaxiwayPaths } = require('./taxiway');
      return parseTaxiwayPaths(currentText);
    },

    readStarRunwayMappings: () => {
      const { extractStarRunwayMappings } = require('./approach');
      return extractStarRunwayMappings(currentText);
    },

    readStarWaypoints: () => {
      const { extractStarWaypoints } = require('./approach');
      return extractStarWaypoints(currentText);
    },

    readSidRunwayMappings: () => {
      const { extractSidRunwayMappings } = require('./sid_goaround');
      return extractSidRunwayMappings(currentText);
    },

    readMissedApproachMappings: () => {
      const { extractMissedApproachMappings } = require('./sid_goaround');
      return extractMissedApproachMappings(currentText);
    },

    readApprRunwayMappings: () => {
      const { extractApprRunwayMappings } = require('./sid_goaround');
      return extractApprRunwayMappings(currentText);
    },

    buildSidPaths: (sidRunwayMap) => {
      const { buildSidPaths } = require('./sid_goaround');
      return buildSidPaths(currentText, sidRunwayMap);
    },

    buildMissedApproachPaths: (missedAppMap) => {
      const { buildMissedApproachPaths } = require('./sid_goaround');
      return buildMissedApproachPaths(currentText, missedAppMap);
    },

    buildApprPaths: (apprRunwayMap) => {
      const { buildApprPaths } = require('./sid_goaround');
      return buildApprPaths(currentText, apprRunwayMap);
    },

    resolveFlyApproachPoints: (star, runway) => {
      const { resolveFlyApproachPoints } = require('./approach');
      return resolveFlyApproachPoints(currentText, star, runway);
    },

    resolveApproachProcedureData: (runway, hintPos) => {
      const { resolveApproachProcedureData } = require('./approach');
      return resolveApproachProcedureData(currentText, runway, hintPos);
    },

    readAirwayFixes: () => {
      const { FIX_NAME_RE } = require('./constants');
      const { buildPkIndex, getPkEntriesByType, extractVector3FromV4, extractStringFromV4, extractIntFromV4 } = require('./v4_pk_index');
      const out = [];
      const pkIndex = buildPkIndex(currentText);
      for (const entry of getPkEntriesByType(pkIndex, 'airway-node')) {
        const pos = extractVector3FromV4(entry.block);
        if (!pos) continue;
        const name = extractStringFromV4(entry.block, 'Name');
        if (!name || !FIX_NAME_RE.test(name)) continue;
        out.push({
          pk: entry.pk,
          name,
          osmId: extractIntFromV4(entry.block, 'OsmId'),
          x: pos.x,
          z: pos.z,
        });
      }
      return out;
    },

    readApproachEntries: (label = filePath ? path.basename(filePath) : '') => {
      const { extractApproachData } = require('./approach');
      const entries = extractApproachData(currentText);
      for (const e of entries) e._file = label;
      return entries;
    },

    readSpecificationDB: (label = filePath ? path.basename(filePath) : '') => {
      const { extractSpecificationDB } = require('./approach');
      return extractSpecificationDB(currentText, label);
    },

    readDesignatorMapping: () => {
      const { buildDesignatorMapping } = require('./approach');
      return buildDesignatorMapping(currentText);
    },

    readTypeMap: () => {
      const { extractTypeMap } = require('./approach');
      return extractTypeMap(currentText);
    },

    readTaxiwayOsmPool: () => {
      const { extractTaxiwayOsmPool } = require('./scenery_write');
      return extractTaxiwayOsmPool(currentText);
    },

    readAirwayOsmPool: () => {
      const { extractAirwayOsmPool } = require('./scenery_write');
      return extractAirwayOsmPool(currentText);
    },

    buildTaxiwayModel: () => {
      const { buildTaxiwayModel } = require('./geo_osm');
      return buildTaxiwayModel(currentText);
    },

    readScenery: () => {
      const sceneryMaps = handle.readSceneryMaps();
      const standPositions = handle.readStandPositions();
      const areaData = handle.readAreas();
      const runwayThresholds = handle.readRunwayThresholds();
      const taxiwayPaths = handle.readTaxiwayPaths();
      const { starRunwayMap, runwayStarMap } = handle.readStarRunwayMappings();
      const starWaypoints = handle.readStarWaypoints();
      const { sidRunwayMap, runwaySidMap } = handle.readSidRunwayMappings();
      const { missedAppMap, runwayMissedAppMap } = handle.readMissedApproachMappings();
      const { apprRunwayMap, runwayApprMap } = handle.readApprRunwayMappings();
      const sidPaths = handle.buildSidPaths(sidRunwayMap);
      const missedAppPaths = handle.buildMissedApproachPaths(missedAppMap);
      const apprPaths = handle.buildApprPaths(apprRunwayMap);
      const airwayNodes = handle.readAirwayFixes();
      const runwayPairs = handle.readRunwayPairs();
      return {
        sceneryMaps, standPositions, areaData, runwayThresholds, taxiwayPaths,
        starRunwayMap, runwayStarMap, starWaypoints,
        sidRunwayMap, runwaySidMap, sidPaths,
        missedAppMap, runwayMissedAppMap, missedAppPaths,
        apprRunwayMap, runwayApprMap, apprPaths,
        airwayNodes, runwayPairs,
      };
    },

    readSceneryGraph: () => {
      const { buildSceneryGraph } = require('./scenery_graph');
      return buildSceneryGraph(currentText);
    },

    createPainterSnapshotToken: () => currentText,

    // ─── Semantic Edits & Commit (Legacy / v2 path) ───────────
    applyEdits: (editIntent) => {
      if (!editIntent || typeof editIntent !== 'object') {
        throw new Error('applyEdits requires an editIntent object');
      }
      // Legacy writes operate via existing Odin writers on a staged temp copy so
      // `sourceBytes` + `currentText` update atomically in memory before `saveToFile`.
      const os = require('os');
      const tmpStage = path.join(
        os.tmpdir(),
        `ac27_legacy_stage_${process.pid}_${crypto.randomBytes(6).toString('hex')}.acl`,
      );
      fs.writeFileSync(tmpStage, sourceBytes);
      let result = {};
      try {
        if (editIntent.sceneryGraph) {
          const { saveGroundPainterAcl } = require('./scenery_write');
          const snap = typeof editIntent.snapshotToken === 'string' && !editIntent.snapshotToken.startsWith('{"__v3Snapshot"')
            ? editIntent.snapshotToken
            : currentText;
          const gpRes = saveGroundPainterAcl(tmpStage, snap, editIntent.sceneryGraph, editIntent.sceneryMeta || {});
          Object.assign(result, gpRes);
        }
        if (Array.isArray(editIntent.flights)) {
          const { generateFullAcl } = require('./parser');
          generateFullAcl(
            tmpStage,
            editIntent.flights,
            editIntent.before || '',
            editIntent.after || '',
            editIntent.originalBlocks || [],
            editIntent.sceneryMaps || null,
            editIntent.approachCache || null,
            editIntent.aclcfgStartTime || null,
            editIntent._saveSec != null ? editIntent._saveSec : null,
          );
        }
        if (editIntent.weatherTimeline || editIntent.windTimeline || editIntent.runwayTimeline) {
          const { _rebuildTimelineSections } = require('./flight_plans');
          _rebuildTimelineSections(
            tmpStage,
            editIntent.weatherTimeline || null,
            editIntent.windTimeline || null,
            editIntent.runwayTimeline || null,
          );
        }
        sourceBytes = fs.readFileSync(tmpStage);
        currentText = _decodeLegacyBytesToText(sourceBytes).text;
        dirtyText = false;
      } finally {
        try { if (fs.existsSync(tmpStage)) fs.unlinkSync(tmpStage); } catch (_) {}
      }
      return result;
    },

    toBuffer: () => {
      if (!dirtyText) return Buffer.from(sourceBytes);
      const { renumberAclIds } = require('./id_renumber');
      const normalized = renumberAclIds(currentText);
      if (isGatcArchive(sourceBytes)) {
        if (getStorageVersion(sourceBytes) === 2) {
          return encodeV2Archive(normalized, sourceBytes);
        }
        return encodeArchive(normalized);
      }
      return Buffer.from(normalized, 'utf8');
    },

    saveToFile: (targetPath = filePath, saveOptions = {}) => {
      if (!targetPath) throw new Error('saveToFile requires a targetPath');
      const resolvedTarget = path.resolve(targetPath);

      const checkStale = saveOptions.checkStale !== false;
      const expectedSha = saveOptions.expectedSourceSha256 || (
        filePath && path.resolve(filePath) === resolvedTarget ? sourceSha256 : null
      );
      if (checkStale && expectedSha && fs.existsSync(resolvedTarget)) {
        const diskBytes = fs.readFileSync(resolvedTarget);
        const diskSha = sha256(diskBytes).toString('hex');
        if (diskSha !== expectedSha) {
          throw new StaleSourceError(
            `Refusing to overwrite "${path.basename(resolvedTarget)}": file on disk changed since it was opened.`,
            { filePath: resolvedTarget, expectedSha256: expectedSha, actualSha256: diskSha },
          );
        }
      }

      const outBuf = handle.toBuffer();
      if (saveOptions.createBackup && fs.existsSync(resolvedTarget)) {
        fs.copyFileSync(resolvedTarget, resolvedTarget + '.bak');
      }

      const dir = path.dirname(resolvedTarget);
      const tmpPath = path.join(
        dir,
        `.${path.basename(resolvedTarget)}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`,
      );
      try {
        fs.writeFileSync(tmpPath, outBuf);
        fs.renameSync(tmpPath, resolvedTarget);
      } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
      }

      const stat = fs.statSync(resolvedTarget);
      filePath = resolvedTarget;
      sourceBytes = outBuf;
      sourceSize = stat.size;
      sourceMtimeMs = stat.mtimeMs;
      sourceSha256 = sha256(outBuf).toString('hex');
      dirtyText = false;

      return { bytesWritten: outBuf.length, sha256: sourceSha256, mtimeMs: sourceMtimeMs };
    },
  };

  return handle;
}

function openLegacyAcl(bytes, options = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const fmt = isGatcArchive(buf) ? `gatcarc4-v${getStorageVersion(buf)}` : 'legacy-text';
  return _openOdinBackedAcl(buf, fmt, options);
}

function openV2Acl(bytes, options = {}) {
  return _openOdinBackedAcl(bytes, 'gatcarc4-v2', options);
}

module.exports = {
  openLegacyAcl,
  openV2Acl,
};
