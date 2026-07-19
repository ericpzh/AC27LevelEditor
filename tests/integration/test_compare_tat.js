/**
 * Diagnostic: Compare scenery-derived TAT vs aircraft-derived TAT (Model A).
 *
 * Reads all 8 production .acl files, extracts State=30 approach data,
 * resolves paths from SceneryData, computes TAT via both methods,
 * calibrates Model A, and compares PR values.
 *
 * Usage:
 *   node --require ./tests/integration/preload.cjs tests/integration/test_compare_tat.js [--root <game-root>]
 */

const fs = require('fs');
const path = require('path');

// Parse CLI args
let gameRoot = path.resolve(__dirname, '..', '..', '..');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--root' && i + 1 < process.argv.length) {
    gameRoot = path.resolve(process.argv[i + 1]);
  }
  if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node --require ./tests/integration/preload.cjs tests/integration/test_compare_tat.js [--root <game-root>]');
    process.exit(0);
  }
}

const dataDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports');

// ─── Constants ────────────────────────────────────────────────────

const APPROACH_SPEED_KTS = 240;            // aircraft approach speed (from TargetTaxiSpeed)
const KTS_TO_MS = 0.514444;               // 1 knot = 0.514444 m/s
const APPROACH_SPEED_MS = APPROACH_SPEED_KTS * KTS_TO_MS;  // 123.47 m/s
const APPROACH_EFFECTIVE_SPEED = 12.5;     // current (broken) effective speed
const TICKS_PER_SEC = 10000000;
const TICKS_PER_DAY = 864000000000;
const WARMUP_SEC = 780;                    // 13 min warmup

// ─── Production Files ─────────────────────────────────────────────

const PROD_FILES = [
  { icao: 'ZSJN', name: 'ZSJN-Morning_120min', startTime: '04:50:00' },
  { icao: 'ZSJN', name: 'ZSJN_07-10',           startTime: '06:50:00' },
  { icao: 'ZSJN', name: 'ZSJN-Evening_120min',   startTime: '16:50:00' },
  { icao: 'ZSJN', name: 'ZSJN_19-21',            startTime: '18:50:00' },
  { icao: 'KJFK', name: 'KJFK_07-09',           startTime: '06:50:00' },
  { icao: 'KJFK', name: 'KJFK_09-11',           startTime: '08:50:00' },
  { icao: 'KJFK', name: 'KJFK_17-20',           startTime: '16:50:00' },
  { icao: 'KJFK', name: 'KJFK_20-22',           startTime: '19:50:00' },
];

// ─── Import approach module ───────────────────────────────────────

const approach = require('../../src/acl/approach');
const { readAclText } = require('../../src/acl/gatcarc');

const {
  extractGameTime,
  extractApproachData,
  resolveFlyApproachPoints,
  resolveApproachProcedureData,
  computePathLength,
} = approach;

// ─── Helpers ──────────────────────────────────────────────────────

function ticksToSec(ticks) {
  if (!ticks || ticks === 0) return 0;
  const baseTicks = Math.floor(ticks / TICKS_PER_DAY) * TICKS_PER_DAY;
  return (ticks - baseTicks) / TICKS_PER_SEC;
}

function toSec(timeStr) {
  if (!timeStr) return 0;
  const p = String(timeStr).split(':');
  return +p[0] * 3600 + +p[1] * 60 + (+p[2] || 0);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── Phase 1: Data Extraction ─────────────────────────────────────

console.log('='.repeat(90));
console.log('PHASE 1: Data Extraction');
console.log('='.repeat(90));

const allFileData = [];  // { icao, name, saveSec, entries[], path }

for (const f of PROD_FILES) {
  const aclPath = path.join(dataDir, f.icao, 'Levels', f.name + '.acl');
  if (!fs.existsSync(aclPath)) {
    console.log(`  SKIP (not found): ${f.icao}/${f.name}.acl`);
    continue;
  }

  const aclText = readAclText(aclPath);
  console.log(`\n  File: ${f.icao}/${f.name}.acl (${(aclText.length / 1024 / 1024).toFixed(1)} MB)`);

  // 1a. Save time
  let saveSec = extractGameTime(aclText);
  if (saveSec != null) {
    console.log(`    saveTime: ${saveSec.toFixed(1)}s (from GameTime.CurrentDateTime)`);
  } else {
    saveSec = toSec(f.startTime) + WARMUP_SEC;
    console.log(`    saveTime: ${saveSec.toFixed(1)}s (fallback: startTime=${f.startTime} + 13min warmup)`);
  }

  // 1b. State=30 approach entries
  const entries = extractApproachData(aclText);
  console.log(`    State=30 entries: ${entries.length}`);

  // Filter to entries with valid landing time
  const validEntries = entries.filter(e => e.landingTimeTicks > 0);
  console.log(`    Valid (has LandingTime): ${validEntries.length}`);

  if (validEntries.length > 0) {
    // Show first few
    for (const e of validEntries.slice(0, 3)) {
      const ltSec = ticksToSec(e.landingTimeTicks);
      const ttl = ltSec - saveSec;
      console.log(`      ${e.callsign.padEnd(10)} STAR=${e.route.padEnd(8)} RWY=${e.runway.padEnd(4)} PR=${e.progressRatio.toFixed(4)} LT=${ltSec.toFixed(0)}s TTL=${ttl.toFixed(0)}s`);
    }
    if (validEntries.length > 3) console.log(`      ... + ${validEntries.length - 3} more`);
  }

  allFileData.push({
    icao: f.icao,
    name: f.name,
    saveSec,
    startTimeSec: toSec(f.startTime),
    aclText,
    aclPath,
    entries: validEntries,
  });
}

// ─── Phase 2: Path Resolution from SceneryData ────────────────────

console.log('\n' + '='.repeat(90));
console.log('PHASE 2: Path Resolution from SceneryData');
console.log('='.repeat(90));

// Collect all unique (star, runway, icao) combos
const starRunwayCombos = new Map(); // key: "star|runway|icao" → { star, runway, icao, entryCount }

for (const fd of allFileData) {
  for (const e of fd.entries) {
    if (!e.route || !e.runway) continue;
    const key = `${e.route}|${e.runway}|${fd.icao}`;
    if (!starRunwayCombos.has(key)) {
      starRunwayCombos.set(key, { star: e.route, runway: e.runway, icao: fd.icao, aclText: fd.aclText });
    }
  }
}

// Resolve paths for each combo
const pathData = new Map(); // key → { flyLen, procLen, terminalLen, flyPoints, procPoints }

for (const [key, combo] of starRunwayCombos) {
  const { star, runway, aclText } = combo;

  // 2a. FlyApproach from SceneryData Type=0 routes
  const flyPoints = resolveFlyApproachPoints(aclText, star, runway);
  const flyLen = flyPoints && flyPoints.length >= 2 ? computePathLength(flyPoints) : 0;

  // 2b. Approach procedure from SceneryData Type=1 routes
  const procData = resolveApproachProcedureData(aclText, runway);
  const procPoints = procData ? procData.pathPointList : null;
  const procLen = procPoints && procPoints.length >= 2 ? computePathLength(procPoints) : 0;

  const terminalLen = flyLen + procLen;

  pathData.set(key, { flyLen, procLen, terminalLen, flyPoints, procPoints });

  const nPts = (flyPoints ? flyPoints.length : 0) + (procPoints ? procPoints.length : 0);
  console.log(`  ${star.padEnd(10)}→${runway.padEnd(5)} @${combo.icao.padEnd(5)}  fly=${flyLen.toFixed(0)}m  proc=${procLen.toFixed(0)}m  total=${terminalLen.toFixed(0)}m  (${nPts} pts)`);
}

// ─── Phase 3: TAT Computation ─────────────────────────────────────

console.log('\n' + '='.repeat(90));
console.log('PHASE 3: TAT Computation (Aircraft Pairs = Ground Truth)');
console.log('='.repeat(90));

// Group entries by (STAR, file) for pair computation
// Each file has a different saveTime, so we group within files
const tatAircraft = new Map();    // "star|icao" → TAT seconds
const tatAircraftAll = new Map(); // "star" → pooled TAT (across all files, less reliable)
const starStats = new Map();      // "star|icao" → { star, icao, count, tat, terminalLen }
const airportStarData = new Map(); // "icao" → [{ star, terminalLen, tat }, ...]

for (const fd of allFileData) {
  // Group entries by STAR within this file
  const byStar = new Map();
  for (const e of fd.entries) {
    if (!e.route) continue;
    if (!byStar.has(e.route)) byStar.set(e.route, []);
    byStar.get(e.route).push(e);
  }

  for (const [star, group] of byStar) {
    const key = `${star}|${fd.icao}`;
    const ratios = [];

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const dPR = Math.abs(group[i].progressRatio - group[j].progressRatio);
        const dLT = Math.abs(group[i].landingTimeTicks - group[j].landingTimeTicks);
        const dSec = dLT / TICKS_PER_SEC;
        if (dPR > 0.001 && dSec > 0) {
          ratios.push(dSec / dPR);
        }
      }
    }

    if (ratios.length > 0) {
      ratios.sort((a, b) => a - b);
      const medianTAT = Math.round(ratios[Math.floor(ratios.length / 2)]);
      tatAircraft.set(key, medianTAT);

      // Get terminal path length for this STAR
      const pathKey = `${star}|${group[0].runway || '?'}|${fd.icao}`;
      const pd = pathData.get(pathKey);
      const terminalLen = pd ? pd.terminalLen : 0;

      console.log(`  ${star.padEnd(12)} @${fd.icao.padEnd(5)}  #AC=${group.length}  pairs=${ratios.length}  TAT_aircraft=${medianTAT}s  termPath=${terminalLen.toFixed(0)}m  termTime=${(terminalLen / APPROACH_SPEED_MS).toFixed(1)}s`);

      // Accumulate for airport-level calibration
      if (!airportStarData.has(fd.icao)) airportStarData.set(fd.icao, []);
      airportStarData.get(fd.icao).push({ star, icao: fd.icao, terminalLen, tat: medianTAT, count: group.length });
    }
  }
}

// Pooled across all files (for reference)
const allEntriesByStar = new Map();
for (const fd of allFileData) {
  for (const e of fd.entries) {
    if (!e.route) continue;
    if (!allEntriesByStar.has(e.route)) allEntriesByStar.set(e.route, []);
    allEntriesByStar.get(e.route).push(e);
  }
}
for (const [star, group] of allEntriesByStar) {
  if (group.length < 2) continue;
  const ratios = [];
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const dPR = Math.abs(group[i].progressRatio - group[j].progressRatio);
      const dLT = Math.abs(group[i].landingTimeTicks - group[j].landingTimeTicks);
      const dSec = dLT / TICKS_PER_SEC;
      if (dPR > 0.001 && dSec > 0) ratios.push(dSec / dPR);
    }
  }
  if (ratios.length > 0) {
    ratios.sort((a, b) => a - b);
    tatAircraftAll.set(star, Math.round(ratios[Math.floor(ratios.length / 2)]));
  }
}

// ─── Phase 4: Model A Calibration ─────────────────────────────────

console.log('\n' + '='.repeat(90));
console.log('PHASE 4: Model A Calibration (per airport)');
console.log('='.repeat(90));

const airportBaseEnRoute = new Map(); // icao → baseEnRouteSec

for (const [icao, starList] of airportStarData) {
  const offsets = [];
  console.log(`\n  Airport: ${icao}`);
  console.log(`  ${'STAR'.padEnd(12)} ${'#AC'.padStart(4)} ${'TermLen(m)'.padStart(12)} ${'TermTime(s)'.padStart(13)} ${'TAT_air(s)'.padStart(12)} ${'Offset(s)'.padStart(10)}`);

  for (const s of starList) {
    const termTime = s.terminalLen / APPROACH_SPEED_MS;
    const offset = s.tat - termTime;
    offsets.push(offset);
    console.log(`  ${s.star.padEnd(12)} ${String(s.count).padStart(4)} ${s.terminalLen.toFixed(0).padStart(12)} ${termTime.toFixed(1).padStart(13)} ${String(s.tat).padStart(12)} ${offset.toFixed(0).padStart(10)}`);
  }

  offsets.sort((a, b) => a - b);
  const medianOffset = Math.round(offsets[Math.floor(offsets.length / 2)]);
  airportBaseEnRoute.set(icao, medianOffset);
  console.log(`  → baseEnRouteSec = ${medianOffset}s (median of ${offsets.length} STARs, range: ${offsets[0].toFixed(0)}–${offsets[offsets.length-1].toFixed(0)}s)`);
}

// Also compute a global baseEnRoute for airports without aircraft data
const allOffsets = [];
for (const [, starList] of airportStarData) {
  for (const s of starList) {
    allOffsets.push(s.tat - s.terminalLen / APPROACH_SPEED_MS);
  }
}
allOffsets.sort((a, b) => a - b);
const globalBaseEnRoute = allOffsets.length > 0
  ? Math.round(allOffsets[Math.floor(allOffsets.length / 2)])
  : 1600;

// ─── Phase 5: PR Comparison ───────────────────────────────────────

console.log('\n' + '='.repeat(90));
console.log('PHASE 5: PR Comparison Per Aircraft');
console.log('='.repeat(90));

const allResults = []; // { icao, name, callsign, star, runway, PR_act, PR_S, PR_M, TTL, err_S, err_M }

for (const fd of allFileData) {
  for (const e of fd.entries) {
    if (!e.route || !e.runway) continue;
    const landingSec = ticksToSec(e.landingTimeTicks);
    const TTL = landingSec - fd.saveSec;
    if (TTL <= 0) continue; // already landed

    const pathKey = `${e.route}|${e.runway}|${fd.icao}`;
    const pd = pathData.get(pathKey);
    const terminalLen = pd ? pd.terminalLen : 0;

    // Current scenery method
    const TAT_scenery = terminalLen > 0 ? Math.round(terminalLen / APPROACH_EFFECTIVE_SPEED) : 1600;
    const PR_scenery = clamp(1.0 - TTL / TAT_scenery, 0, 1);

    // Model A
    const baseEnRoute = airportBaseEnRoute.get(fd.icao) || globalBaseEnRoute;
    const termTime = terminalLen / APPROACH_SPEED_MS;
    const TAT_modelA = baseEnRoute + termTime;
    const PR_modelA = clamp(1.0 - TTL / TAT_modelA, 0, 1);

    const err_S = PR_scenery - e.progressRatio;
    const err_M = PR_modelA - e.progressRatio;

    allResults.push({
      icao: fd.icao,
      name: fd.name,
      callsign: e.callsign,
      star: e.route,
      runway: e.runway,
      TTL,
      PR_act: e.progressRatio,
      PR_S: PR_scenery,
      PR_M: PR_modelA,
      err_S,
      err_M,
      terminalLen,
      TAT_scenery,
      TAT_modelA,
    });
  }
}

// ─── Phase 6: Report ──────────────────────────────────────────────

console.log('\n' + '='.repeat(90));
console.log('PHASE 6: Report');
console.log('='.repeat(90));

// Table 1: Per-STAR TAT comparison
console.log('\n── Table 1: Per-STAR TAT Comparison ──');
console.log(
  'STAR'.padEnd(14) +
  'ICAO'.padEnd(6) +
  '#AC'.padStart(4) +
  'Path(m)'.padStart(9) +
  'TermT(s)'.padStart(10) +
  'S-TAT(s)'.padStart(10) +
  'A-TAT(s)'.padStart(10) +
  'M-TAT(s)'.padStart(10) +
  'S-Err%'.padStart(8) +
  'M-Err%'.padStart(8)
);
console.log('-'.repeat(95));

for (const [icao, starList] of airportStarData) {
  const baseEnRoute = airportBaseEnRoute.get(icao) || globalBaseEnRoute;
  for (const s of starList) {
    const termTime = s.terminalLen / APPROACH_SPEED_MS;
    const TAT_S = s.terminalLen > 0 ? Math.round(s.terminalLen / APPROACH_EFFECTIVE_SPEED) : 1600;
    const TAT_M = Math.round(baseEnRoute + termTime);
    const errS = s.tat > 0 ? ((TAT_S - s.tat) / s.tat * 100).toFixed(0) : 'N/A';
    const errM = s.tat > 0 ? ((TAT_M - s.tat) / s.tat * 100).toFixed(0) : 'N/A';

    console.log(
      s.star.padEnd(14) +
      icao.padEnd(6) +
      String(s.count).padStart(4) +
      s.terminalLen.toFixed(0).padStart(9) +
      termTime.toFixed(1).padStart(10) +
      String(TAT_S).padStart(10) +
      String(s.tat).padStart(10) +
      String(TAT_M).padStart(10) +
      (errS + '%').padStart(8) +
      (errM + '%').padStart(8)
    );
  }
}

// Table 2: Per-aircraft PR comparison
console.log('\n── Table 2: Per-Aircraft PR Comparison ──');
console.log(
  'File'.padEnd(28) +
  'CallSign'.padEnd(12) +
  'TTL(s)'.padStart(8) +
  'PR_act'.padStart(8) +
  'PR_S'.padStart(8) +
  'PR_M'.padStart(8) +
  'Err_S'.padStart(8) +
  'Err_M'.padStart(8)
);
console.log('-'.repeat(92));

for (const r of allResults) {
  const fname = r.name.length > 26 ? r.name.substring(0, 23) + '...' : r.name;
  console.log(
    fname.padEnd(28) +
    r.callsign.padEnd(12) +
    r.TTL.toFixed(0).padStart(8) +
    r.PR_act.toFixed(4).padStart(8) +
    r.PR_S.toFixed(4).padStart(8) +
    r.PR_M.toFixed(4).padStart(8) +
    r.err_S.toFixed(4).padStart(8) +
    r.err_M.toFixed(4).padStart(8)
  );
}

// Table 3: Aggregate error
console.log('\n── Table 3: Aggregate Error ──');

function computeStats(results, errKey) {
  const errs = results.map(r => r[errKey]);
  const absErrs = errs.map(e => Math.abs(e));
  const rmse = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
  const maxAbs = Math.max(...absErrs);
  const meanErr = errs.reduce((s, e) => s + e, 0) / errs.length;
  const within05 = absErrs.filter(e => e <= 0.05).length;
  const within10 = absErrs.filter(e => e <= 0.10).length;
  const within15 = absErrs.filter(e => e <= 0.15).length;
  return { rmse, maxAbs, meanErr, within05, within10, within15, total: errs.length };
}

const stats_S = computeStats(allResults, 'err_S');
const stats_M = computeStats(allResults, 'err_M');

console.log(
  'Method'.padEnd(12) +
  'RMSE'.padStart(10) +
  'Max|Err|'.padStart(10) +
  'MeanErr'.padStart(10) +
  '±0.05'.padStart(8) +
  '±0.10'.padStart(8) +
  '±0.15'.padStart(8) +
  'N'.padStart(6)
);
console.log('-'.repeat(72));
function printStats(label, s) {
  console.log(
    label.padEnd(12) +
    s.rmse.toFixed(4).padStart(10) +
    s.maxAbs.toFixed(4).padStart(10) +
    s.meanErr.toFixed(4).padStart(10) +
    `${s.within05}/${s.total}`.padStart(8) +
    `${s.within10}/${s.total}`.padStart(8) +
    `${s.within15}/${s.total}`.padStart(8) +
    String(s.total).padStart(6)
  );
}
printStats('Scenery', stats_S);
printStats('Model A', stats_M);

// Table 4: Calibrated parameters
console.log('\n── Table 4: Calibrated Parameters ──');
console.log('Airport'.padEnd(8) + 'baseEnRouteSec'.padStart(16) + '#STARs'.padStart(8) + '#Aircraft'.padStart(12));
console.log('-'.repeat(44));
for (const [icao, baseEnRoute] of airportBaseEnRoute) {
  const starList = airportStarData.get(icao) || [];
  const totalAC = starList.reduce((s, x) => s + x.count, 0);
  console.log(icao.padEnd(8) + String(baseEnRoute).padStart(16) + String(starList.length).padStart(8) + String(totalAC).padStart(12));
}
if (airportBaseEnRoute.size === 0) {
  console.log(`(none — no aircraft pair data available)`);
}
console.log(`\nGlobal fallback baseEnRouteSec: ${globalBaseEnRoute}s`);

console.log('\nDone.');
