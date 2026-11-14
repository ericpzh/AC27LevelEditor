'use strict';

/**
 * GATCARC4 v3 Archive Handler (`src/acl/v3/handler.js`).
 *
 * Owns source bytes, storageVersion = 3, parsed wire state (`container`),
 * editor-shaped reads, semantic edit dispatch (`applyEdits`), schema validation,
 * and atomic file commit with stale-source protection.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256 } = require('../framing');
const { parseV3Container, encodeV3Container } = require('./framing');
const { getSchemaForHash } = require('./schema_registry');
const { validateV3Container } = require('./validator');
const { validateV3ContainerRunwayTimelineMembership } = require('./runway_timeline_validation');
const { validateV3ApproachRoutes } = require('./approach_validation');
const {
  validateV3CallsignAllocation,
  CallsignAllocationError,
} = require('./callsign_validation');
const readers = require('./readers');

class StaleSourceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StaleSourceError';
    this.code = 'STALE_ACL_SOURCE';
    Object.assign(this, details);
  }
}

function openV3Acl(bytes, options = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const container = parseV3Container(buf, {
    allowInterruptedTail: Boolean(options.allowInterruptedTail),
  });
  // Verify schema hash upfront on open so unsupported v3 schemas fail clearly.
  getSchemaForHash(container.header.schemaHash);
  if (options.validateOnOpen) {
    validateV3Container(container);
  }

  let filePath = options.filePath || null;
  let sourceSize = options.sourceSize != null ? options.sourceSize : buf.length;
  let sourceMtimeMs = options.sourceMtimeMs != null ? options.sourceMtimeMs : null;
  let sourceSha256 = options.sourceSha256 || sha256(buf).toString('hex');

  const handle = {
    format: 'gatcarc4-v3',
    storageVersion: 3,
    get filePath() { return filePath; },
    get sourceSize() { return sourceSize; },
    get sourceMtimeMs() { return sourceMtimeMs; },
    get sourceSha256() { return sourceSha256; },
    get header() { return container.header; },
    get archiveGuid() { return container.header?.archiveGuid || null; },
    get levelGuid() { return container.header?.levelGuid || null; },
    get airportIcao() { return container.header?.airportIcao || null; },
    get container() { return container; },

    // ─── Editor-shaped reads ──────────────────────────────────
    readConfig: () => readers.readConfig(container),
    readConfigResolved: () => readers.readConfigResolved(container),
    readCurrentDateTime: () => readers.readCurrentDateTime(container),
    readGameTimeSec: () => readers.readGameTimeSec(container),
    readFlights: (fpOverride = filePath) => readers.readFlights(container, fpOverride),
    readSummary: (opts = {}) => readers.readSummary(container, {
      filePath: opts.filePath || filePath,
      size: opts.size != null ? opts.size : sourceSize,
    }),
    readTimelines: () => readers.readTimelines(container),
    readRunwayPairs: () => readers.readRunwayPairs(container),
    readSceneryMaps: () => readers.readSceneryMaps(container),
    readStandPositions: () => readers.readStandPositions(container),
    readAreas: () => readers.readAreas(container),
    readRunwayThresholds: () => readers.readRunwayThresholds(container),
    readTaxiwayPaths: () => readers.readTaxiwayPaths(container),
    readStarRunwayMappings: () => readers.readStarRunwayMappings(container),
    readStarWaypoints: () => readers.readStarWaypoints(container),
    readSidRunwayMappings: () => {
      const { routeRunwayMap, runwayRouteMap } = readers.readRouteMappingsByType(container, 2);
      return { sidRunwayMap: routeRunwayMap, runwaySidMap: runwayRouteMap };
    },
    readMissedApproachMappings: () => {
      const { routeRunwayMap, runwayRouteMap } = readers.readRouteMappingsByType(container, 3);
      return { missedAppMap: routeRunwayMap, runwayMissedAppMap: runwayRouteMap };
    },
    readApprRunwayMappings: () => {
      const { routeRunwayMap, runwayRouteMap } = readers.readRouteMappingsByType(container, 1);
      return { apprRunwayMap: routeRunwayMap, runwayApprMap: runwayRouteMap };
    },
    buildSidPaths: (sidRunwayMap) => readers.buildRoutePaths(container, sidRunwayMap, 2),
    buildMissedApproachPaths: (missedAppMap) => readers.buildRoutePaths(container, missedAppMap, 3),
    buildApprPaths: (apprRunwayMap) => readers.buildRoutePaths(container, apprRunwayMap, 1),
    resolveFlyApproachPoints: (star, runway) => readers.resolveFlyApproachPoints(container, star, runway),
    resolveApproachProcedureData: (runway, hintPos) => readers.resolveApproachProcedureData(container, runway, hintPos),
    readAirwayFixes: () => readers.readAirwayFixes(container),
    readApproachEntries: (label = filePath ? path.basename(filePath) : '') => readers.readApproachEntries(container, label),
    readSpecificationDB: () => new Map(),
    readDesignatorMapping: () => new Map(),
    readTypeMap: () => new Map(),
    readTaxiwayOsmPool: () => readers.readTaxiwayOsmPool(container),
    readAirwayOsmPool: () => readers.readAirwayOsmPool(container),
    buildTaxiwayModel: () => readers.buildTaxiwayModel(container),
    readScenery: () => readers.readScenery(container),
    readSceneryGraph: () => readers.readSceneryGraph(container),

    createPainterSnapshotToken: () => {
      const { graph } = readers.readSceneryGraph(container);
      const levelBaseName = filePath
        ? path.basename(filePath, '.acl')
        : (container.header?.archiveGuid || '');
      return JSON.stringify({
        __v3Snapshot: true,
        ArchiveGuid: levelBaseName,
        headerArchiveGuid: container.header?.archiveGuid || '',
        levelBaseName,
        filePath,
        sourceSha256,
        sourceMtimeMs,
        snapSummary: {
          stands: (graph.stands || []).map((s) => s.identifier || s.name || '').filter(Boolean),
          runways: (graph.runways || []).map((r) => ({
            physicalName: r.physicalName,
            names: r.names,
          })),
          procedures: (graph.procedures || []).map((p) => ({
            name: p.name,
            routeType: p.routeType,
            runwayName: p.runwayName,
          })),
        },
      });
    },

    // ─── Semantic Edits & Commit ──────────────────────────────
    applyEdits: (editIntent) => {
      if (!editIntent || typeof editIntent !== 'object') {
        throw new Error('applyEdits requires an editIntent object');
      }
      let result = {};
      if (editIntent.config || editIntent.weatherTimeline || editIntent.windTimeline || editIntent.runwayTimeline) {
        const { applyMetaEdits } = require('./writers_meta');
        const metaRes = applyMetaEdits(container, editIntent);
        Object.assign(result, metaRes);
      }
      if (editIntent.sceneryGraph) {
        const { applySceneryGraphEdits } = require('./writers_scenery');
        const scenRes = applySceneryGraphEdits(container, editIntent, { filePath });
        Object.assign(result, scenRes);
      }
      if (Array.isArray(editIntent.flights)) {
        const { applyFlightEdits } = require('./writers_flights');
        const flRes = applyFlightEdits(container, editIntent, { filePath });
        Object.assign(result, flRes);
      }
      readers.invalidateContainerCaches(container);
      return result;
    },

    toBuffer: (encodeOptions = {}) => {
      if (encodeOptions.validate !== false) {
        validateV3Container(container);
      }
      return encodeV3Container(container, {
        forceReencode: Boolean(encodeOptions.forceReencode),
      });
    },

    saveToFile: (targetPath = filePath, saveOptions = {}) => {
      if (!targetPath) {
        throw new Error('saveToFile requires a targetPath');
      }
      const resolvedTarget = path.resolve(targetPath);

      // Stale-source check when saving back to an existing file
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

      // Stage and schema-validate complete output BEFORE touching backup or target
      const schema = getSchemaForHash(container.header.schemaHash);
      if (saveOptions.validateTimelineMembership !== false) {
        validateV3ContainerRunwayTimelineMembership(container, schema);
      }
      if (saveOptions.validateApproachRoutes !== false) {
        validateV3ApproachRoutes(container.staticData, schema);
      }
      if (saveOptions.validateCallsignAllocation !== false) {
        const allocRes = validateV3CallsignAllocation(container, schema, {
          levelPath: resolvedTarget,
          gameRoot: saveOptions.gameRoot,
          airportIcao: saveOptions.airportIcao,
          v3Audio: saveOptions.v3Audio,
          requireAudioMetadata: Boolean(saveOptions.requireAudioMetadata),
        });
        if (!allocRes.ok) {
          throw new CallsignAllocationError(allocRes.issues, {
            metadataUnavailable: allocRes.metadataUnavailable,
            missingResources: allocRes.missingResources,
          });
        }
      }
      validateV3Container(container);
      const encoded = encodeV3Container(container, {
        forceReencode: Boolean(saveOptions.forceReencode),
      });

      if (saveOptions.simulateWriteFailure) {
        const tmpFail = `${resolvedTarget}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
        try {
          fs.writeFileSync(tmpFail, encoded.subarray(0, Math.min(16, encoded.length)));
          throw new Error('Simulated write failure before atomic rename');
        } finally {
          try { if (fs.existsSync(tmpFail)) fs.unlinkSync(tmpFail); } catch (_) {}
        }
      }

      if (saveOptions.createBackup && fs.existsSync(resolvedTarget)) {
        fs.copyFileSync(resolvedTarget, resolvedTarget + '.bak');
      }

      const dir = path.dirname(resolvedTarget);
      const tmpPath = path.join(
        dir,
        `.${path.basename(resolvedTarget)}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`,
      );
      try {
        fs.writeFileSync(tmpPath, encoded);
        fs.renameSync(tmpPath, resolvedTarget);
      } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
      }

      const stat = fs.statSync(resolvedTarget);
      filePath = resolvedTarget;
      sourceSize = stat.size;
      sourceMtimeMs = stat.mtimeMs;
      sourceSha256 = sha256(encoded).toString('hex');

      if (container.dirtyHeader) {
        container.rawHeaderSegment = null;
      }
      if (container.dirtyMetaData || container.dirtyStaticData) {
        container.rawMainSegment = null;
        container.rawMainPayloadBytes = null;
      }
      if (container.dirtyStaticData) {
        container.rawStaticBase64 = null;
      }
      container.dirtyHeader = false;
      container.dirtyMetaData = false;
      container.dirtyStaticData = false;
      for (const frame of container.frames) {
        const rtDirty = Boolean(frame.dirtyRuntime || frame.dirtyRuntimeData);
        if (frame.dirtySummary) {
          frame.rawSummaryBlock = null;
          frame.rawSummaryBytes = null;
          frame.rawFrameBytes = null;
        }
        if (rtDirty) {
          frame.rawRuntimeBase64 = null;
          frame.rawPayloadBytes = null;
          frame.rawFrameBytes = null;
        }
        if (frame.dirtyMessages) {
          frame.rawPayloadBytes = null;
          frame.rawFrameBytes = null;
        }
        frame.dirtySummary = false;
        frame.dirtyRuntime = false;
        frame.dirtyRuntimeData = false;
        frame.dirtyMessages = false;
      }

      return { bytesWritten: encoded.length, sha256: sourceSha256, mtimeMs: sourceMtimeMs };
    },
  };

  return handle;
}

module.exports = {
  openV3Acl,
  StaleSourceError,
  CallsignAllocationError,
};
