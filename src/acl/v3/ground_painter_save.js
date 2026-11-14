'use strict';

/**
 * Shared v3 Ground Painter save pipeline (`src/acl/v3/ground_painter_save.js`).
 *
 * Used by `ipcMain.handle('save-ground-painter-data')` in `electron/main.js` so
 * all pre-write validation (cross-level contamination, duplicate runway end names,
 * final rebuilt v3 pushback paths & stand navigation points, zero-runway guard,
 * and flight reference reconciliation) executes BEFORE writing `.acl`, `.acl.bak`,
 * flight schedule `.csv`, `.acl.bg.json`, or `geo_data.osm`.
 */

const fs = require('fs');
const path = require('path');
const { openAclFile } = require('../archive');
const { exportGameCSV, sortFlightsChronologically } = require('../parser');
const { syncGeoDataForLevel } = require('../geo_osm');
const { getSchemaForHash } = require('./schema_registry');
const {
  validateV3PushbackPaths,
  loadWheelBasesNearLevel,
} = require('./pushback_validation');
const { validateV3ContainerRunwayTimelineMembership } = require('./runway_timeline_validation');
const { validateV3ApproachRoutes } = require('./approach_validation');
const {
  validateV3CallsignAllocation,
  CallsignAllocationError,
} = require('./callsign_validation');

function defaultBgSidecarPath(filePath) {
  return `${filePath}.bg.json`;
}

function defaultThrowZeroRunwayPainterError(graph, warnings) {
  const graphCount = (graph && Array.isArray(graph.runways)) ? graph.runways.length : 0;
  const graphNames = (graph && Array.isArray(graph.runways))
    ? graph.runways.map((rw) => (Array.isArray(rw.names) ? rw.names.join('/') : (rw.physicalName || rw.name || '?'))).join(', ')
    : '';
  const warnSummary = warnings.length
    ? '写入警告：' + warnings.map((w) => (w && w.text) || String(w)).join('；')
    : '写入无警告（跑道可能在发送前已被机构修复丢弃，请查看渲染进程控制台 [GP] save 日志）';
  throw new Error(
    '保存被拒绝：关卡必须至少保留一条跑道（游戏要求 InitialRunways 非空）。请先绘制一条跑道再保存。'
    + '（诊断：画布跑道 ' + graphCount + ' 条[' + graphNames + ']，写入结果跑道 0 条。' + warnSummary + '）',
  );
}

function defaultReconcileSceneryFlightReferences({ savedGraph, snap, graph, meta, flights }) {
  const norm = (v) => String(v || '').trim().replace(/^0+/, '');
  const curStandNames = new Set();
  for (const st of (savedGraph.graph.stands || [])) {
    for (const nm of [st.identifier, st.name]) {
      const v = norm(nm);
      if (v) curStandNames.add(v);
    }
  }
  const curRunwayEnds = new Set();
  for (const rw of (savedGraph.graph.runways || [])) {
    if (Array.isArray(rw.names)) {
      for (const n of rw.names) {
        const v = norm(n);
        if (v) curRunwayEnds.add(v);
      }
    }
    if (rw.physicalName) {
      for (const n of String(rw.physicalName).split('/')) {
        const v = norm(n);
        if (v) curRunwayEnds.add(v);
      }
    }
  }
  const snapStandNames = new Set();
  for (const st of (snap.graph.stands || [])) {
    for (const nm of [st.identifier, st.name]) {
      const v = norm(nm);
      if (v) snapStandNames.add(v);
    }
  }
  const snapRunwayEnds = new Set();
  for (const rw of (snap.graph.runways || [])) {
    if (Array.isArray(rw.names)) {
      for (const n of rw.names) {
        const v = norm(n);
        if (v) snapRunwayEnds.add(v);
      }
    }
    if (rw.physicalName) {
      for (const n of String(rw.physicalName).split('/')) {
        const v = norm(n);
        if (v) snapRunwayEnds.add(v);
      }
    }
  }
  const procNamesOf = (g) => {
    const s = new Set();
    for (const p of (g.graph.procedures || [])) {
      if (p.routeType != null && Number(p.routeType) !== 0) continue;
      const v = norm(p.name);
      if (v) s.add(v);
    }
    return s;
  };
  const curStarNames = procNamesOf(savedGraph);
  const snapStarNames = procNamesOf(snap);
  const procsByRunwayOf = (g) => {
    const m = new Map();
    for (const p of (g.graph.procedures || [])) {
      if (p.routeType != null && Number(p.routeType) !== 0) continue;
      const rw = norm(p.runwayName);
      const nm = norm(p.name);
      if (!rw || !nm) continue;
      if (!m.has(rw)) m.set(rw, new Set());
      m.get(rw).add(nm);
    }
    return m;
  };
  const curProcsByRunway = procsByRunwayOf(savedGraph);
  const snapProcsByRunway = procsByRunwayOf(snap);

  const runwayRename = new Map();
  if (Array.isArray(meta && meta.runwayOrigInfo) && Array.isArray(meta.runwayOrigPk)) {
    for (let i = 0; i < (graph.runways || []).length && i < meta.runwayOrigInfo.length && i < meta.runwayOrigPk.length; i++) {
      if (meta.runwayOrigPk[i] == null) continue;
      const orig = meta.runwayOrigInfo[i];
      const cur = graph.runways[i];
      if (!orig || !cur || !Array.isArray(orig.names) || !Array.isArray(cur.names)) continue;
      for (let j = 0; j < 2 && j < orig.names.length && j < cur.names.length; j++) {
        const o = norm(orig.names[j]);
        const n = String(cur.names[j] || '').trim();
        if (o && n && o !== norm(n)) runwayRename.set(o, n);
      }
    }
  }
  for (const [o, n] of [...runwayRename]) {
    if (!curRunwayEnds.has(norm(n))) runwayRename.delete(o);
  }

  const standRename = new Map();
  const snapStandByNose = new Map();
  for (const st of (snap.graph.stands || [])) {
    const nose = snap.graph.nodes[st.noseIdx];
    if (!nose) continue;
    const key = `${nose.x.toFixed(4)},${nose.z.toFixed(4)}`;
    if (!snapStandByNose.has(key)) snapStandByNose.set(key, st);
  }
  for (const st of (graph.stands || [])) {
    const nose = (graph.nodes || [])[st.noseIdx];
    if (!nose) continue;
    const key = `${nose.x.toFixed(4)},${nose.z.toFixed(4)}`;
    const origSt = snapStandByNose.get(key);
    if (!origSt) continue;
    const newIdent = String(st.identifier || '').trim();
    if (origSt.identifier && newIdent && norm(origSt.identifier) !== norm(newIdent)) {
      standRename.set(norm(origSt.identifier), newIdent);
    }
  }
  for (const [o, n] of [...standRename]) {
    if (!curStandNames.has(norm(n))) standRename.delete(o);
  }

  const remap = (value, map) => {
    if (!value || !map.size) return value;
    const key = norm(value);
    if (!map.has(key)) return value;
    const cur = map.get(key);
    return cur != null ? String(cur) : value;
  };

  const origRunwayByFlight = new WeakMap();
  let refsRemapped = 0;
  for (const f of flights) {
    origRunwayByFlight.set(f, f.Runway || '');
    if (f.Runway) {
      const mapped = remap(f.Runway, runwayRename);
      if (mapped !== f.Runway) {
        f.Runway = mapped;
        refsRemapped++;
      }
    }
    if (f.Stand) {
      const mapped = remap(f.Stand, standRename);
      if (mapped !== f.Stand) {
        f.Stand = mapped;
        refsRemapped++;
      }
    }
  }

  const regKey = (f) => String(f._Registration || f._fpGuid || f.CallSign || '');
  const danglingLegs = new Set();
  const starGoneOf = (f) => !!f.Airway && !curStarNames.has(norm(f.Airway)) && snapStarNames.has(norm(f.Airway));
  const starOffRunwayOf = (f) => {
    if (!f.Airway || !f.Runway) return false;
    const origRw = norm(origRunwayByFlight.get(f) || f.Runway);
    const curRw = norm(f.Runway);
    const st = norm(f.Airway);
    const sn = snapProcsByRunway.get(origRw);
    if (!sn || !sn.has(st)) return false;
    const cur = curProcsByRunway.get(curRw);
    return !(cur && cur.has(st));
  };
  for (const f of flights) {
    const standGone = !!f.Stand && !curStandNames.has(norm(f.Stand)) && snapStandNames.has(norm(f.Stand));
    const runwayGone = !!f.Runway && !curRunwayEnds.has(norm(f.Runway)) && snapRunwayEnds.has(norm(f.Runway));
    if (standGone || runwayGone || starGoneOf(f) || starOffRunwayOf(f)) danglingLegs.add(regKey(f));
  }

  if (!danglingLegs.size && refsRemapped === 0) {
    return { needsRebuild: false, purgedFlights: [], refsRemapped: 0, keptFlights: flights };
  }

  const purgedFlights = flights
    .filter((f) => danglingLegs.has(regKey(f)))
    .map((f) => ({
      CallSign: f.CallSign || '',
      Registration: f._Registration || '',
      Stand: f.Stand || '',
      Runway: f.Runway || '',
      STAR: f.Airway || '',
      reason: (f.Stand && !curStandNames.has(norm(f.Stand)) && snapStandNames.has(norm(f.Stand))) ? 'stand removed or renamed away'
        : (f.Runway && !curRunwayEnds.has(norm(f.Runway)) && snapRunwayEnds.has(norm(f.Runway))) ? 'runway removed or renamed away'
          : starGoneOf(f) ? 'STAR procedure removed or renamed away'
            : starOffRunwayOf(f) ? 'STAR variant removed or renamed away for this runway' : 'same aircraft leg removed',
    }));
  const keptFlights = sortFlightsChronologically(flights.filter((f) => !danglingLegs.has(regKey(f))));
  return { needsRebuild: true, purgedFlights, refsRemapped, keptFlights };
}

function saveV3GroundPainterData(
  { filePath, snapshotText, v3Snap: explicitV3Snap, graph, meta, createBackup, bg },
  hooks = {},
) {
  const baseName = filePath ? path.basename(filePath, '.acl') : null;
  const reconcileRefs = hooks.reconcileSceneryFlightReferences || defaultReconcileSceneryFlightReferences;
  const throwZeroRunway = hooks.throwZeroRunwayPainterError || defaultThrowZeroRunwayPainterError;
  const resolveApproachCache = hooks.getApproachCache || (() => null);
  const bgPathFn = hooks.bgSidecarPath || defaultBgSidecarPath;
  const onAfterAclSaved = hooks.onAfterAclSaved || null;

  let v3Snap = explicitV3Snap || null;
  if (!v3Snap && typeof snapshotText === 'string' && snapshotText.trimStart().startsWith('{')) {
    try {
      const parsedSnap = JSON.parse(snapshotText);
      if (parsedSnap && parsedSnap.__v3Snapshot) v3Snap = parsedSnap;
    } catch (_) {}
  }

  if (v3Snap) {
    const snapBase = v3Snap.levelBaseName || v3Snap.ArchiveGuid || null;
    if (snapBase && baseName && snapBase !== baseName) {
      throw new Error(
        'GroundPainter refusal: snapshot ArchiveGuid "' + snapBase
        + '" does not match target file "' + baseName
        + '.acl" — likely cross-level graph contamination. Please close and reopen the Ground Painter.',
      );
    }
  }

  if (graph && Array.isArray(graph.runways)) {
    for (const rw of graph.runways) {
      const names = Array.isArray(rw.names) && rw.names.length >= 2
        ? rw.names
        : [rw.name || '', String(rw.physicalName || '').split('/')[1] || ''];
      if (names.length >= 2 && String(names[0]) === String(names[1])) {
        throw new Error('保存被拒绝：同一条跑道的两端不能使用相同的名称（' + String(names[0]) + '）。请修改其中一端的名称后重试。');
      }
    }
  }

  const diskHandle = openAclFile(filePath);
  if (v3Snap && v3Snap.headerArchiveGuid && diskHandle.archiveGuid && v3Snap.headerArchiveGuid !== diskHandle.archiveGuid) {
    throw new Error(
      'GroundPainter refusal: snapshot ArchiveGuid "' + v3Snap.headerArchiveGuid
      + '" does not match target file "' + baseName
      + '.acl" — likely cross-level graph contamination. Please close and reopen the Ground Painter.',
    );
  }

  const preStaticData = diskHandle.container.staticData;
  const wheelBaseByAircraft = loadWheelBasesNearLevel(filePath);
  const snap = diskHandle.readSceneryGraph();
  const preFlightData = diskHandle.readFlights(filePath);
  const scenRes = diskHandle.applyEdits({
    sceneryGraph: graph,
    sceneryMeta: meta,
    wheelBaseByAircraft,
    filePath,
  });
  const warnings = Array.isArray(scenRes && scenRes.warnings) ? [...scenRes.warnings] : [];
  const savedGraph = diskHandle.readSceneryGraph();

  if (!savedGraph || !savedGraph.graph || !Array.isArray(savedGraph.graph.runways) || savedGraph.graph.runways.length === 0) {
    throwZeroRunway(graph, warnings);
  }

  let purgedFlights = [];
  let refsRemapped = 0;
  let flightSectionsRebuilt = false;
  let keptFlightsForCsv = null;
  try {
    const flights = Array.isArray(preFlightData && preFlightData.flights) ? preFlightData.flights : [];
    const rec = reconcileRefs({ savedGraph, snap, graph, meta, flights });
    purgedFlights = rec.purgedFlights;
    refsRemapped = rec.refsRemapped;
    if (rec.needsRebuild) {
      flightSectionsRebuilt = true;
      keptFlightsForCsv = rec.keptFlights;
      const icaoMatch = String(filePath).match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
      const icao = icaoMatch ? icaoMatch[1] : '';
      const approachCache = resolveApproachCache(icao);
      diskHandle.applyEdits({ flights: rec.keptFlights, approachCache, filePath });
      console.log('[GroundPainter] (v3) flight purge: ' + purgedFlights.length + ' flight(s) removed, ' + refsRemapped + ' reference(s) remapped');
    }
  } catch (purgeErr) {
    throw new Error('Flight reference reconciliation failed: ' + (purgeErr && purgeErr.message ? purgeErr.message : purgeErr));
  }

  const schema = getSchemaForHash(diskHandle.header.schemaHash);
  if (flightSectionsRebuilt) {
    validateV3PushbackPaths(diskHandle.container.staticData, schema, {
      preStaticData,
      wheelBaseByAircraft,
    });
  }
  validateV3ContainerRunwayTimelineMembership(diskHandle.container, schema);
  validateV3ApproachRoutes(diskHandle.container.staticData, schema);
  if (hooks.validateCallsignAllocation !== false) {
    const allocRes = validateV3CallsignAllocation(diskHandle.container, schema, {
      levelPath: filePath,
      gameRoot: hooks.gameRoot,
      airportIcao: hooks.airportIcao,
      v3Audio: hooks.v3Audio,
      requireAudioMetadata: Boolean(hooks.requireAudioMetadata),
    });
    if (!allocRes.ok) {
      throw new CallsignAllocationError(allocRes.issues, {
        metadataUnavailable: allocRes.metadataUnavailable,
        missingResources: allocRes.missingResources,
      });
    }
  }

  diskHandle.saveToFile(filePath, {
    createBackup: Boolean(createBackup),
    expectedSourceSha256: v3Snap && v3Snap.sourceSha256 ? v3Snap.sourceSha256 : undefined,
  });
  console.log('[GroundPainter] save-ground-painter-data (v3): wrote ' + filePath);

  const verifyHandle = openAclFile(filePath);
  const verifiedScenery = verifyHandle.readSceneryGraph();
  if (!verifiedScenery || !verifiedScenery.graph || !Array.isArray(verifiedScenery.graph.runways) || verifiedScenery.graph.runways.length === 0) {
    throw new Error('Post-save verification failed: reloaded v3 scenery graph has no runways.');
  }

  if (onAfterAclSaved) {
    onAfterAclSaved(filePath);
  }

  let csvSyncError = null;
  if (flightSectionsRebuilt && keptFlightsForCsv) {
    try {
      const cfg = verifyHandle.readConfigResolved();
      if (cfg && cfg.flightScheduleFile) {
        const csvPath = path.join(path.dirname(filePath), cfg.flightScheduleFile + '.csv');
        if (createBackup && fs.existsSync(csvPath)) fs.copyFileSync(csvPath, csvPath + '.bak');
        exportGameCSV(keptFlightsForCsv, csvPath);
      }
    } catch (csvErr) {
      csvSyncError = csvErr.message || String(csvErr);
      console.error('[GroundPainter] CSV sync warning: ' + csvSyncError);
    }
  }

  try {
    if (bg && bg.src) fs.writeFileSync(bgPathFn(filePath), JSON.stringify(bg), 'utf8');
    else if (fs.existsSync(bgPathFn(filePath))) fs.unlinkSync(bgPathFn(filePath));
  } catch (e) {
    console.error('[GroundPainter] write bg sidecar failed: ' + (e && e.message));
  }

  let geoResult = { skipped: true };
  try {
    geoResult = syncGeoDataForLevel(verifyHandle, filePath, { createBackup: false });
    if (!geoResult.ok && geoResult.error) console.error('[GroundPainter] geo_data sync failed: ' + geoResult.error);
    else if (geoResult.ok) console.log('[GroundPainter] geo_data sync: +' + geoResult.addedNodes + ' nodes, +' + geoResult.addedWays + ' ways');
  } catch (e) {
    console.error('[GroundPainter] geo_data sync error: ' + (e && e.message));
  }

  if (warnings.length) {
    console.warn('[GroundPainter] save warnings: ' + warnings.map((w) => (w && w.text) || String(w)).join(' | '));
  }

  return {
    newText: verifyHandle.createPainterSnapshotToken(),
    geoResult,
    warnings,
    purgedFlights,
    refsRemapped,
    ...(csvSyncError ? { partialFailure: true, warning: `ACL saved, but CSV sync failed: ${csvSyncError}` } : {}),
  };
}

module.exports = {
  saveV3GroundPainterData,
};
