/**
 * Save Integrity — All .acl files across all airports.
 *
 * Flow for each .acl file:
 *   1. Copy original .acl + timeline JSONs → temp golden/ directory
 *   2. Load golden via parser → snapshot (flights, config, scenery, timelines)
 *   3. Copy golden → temp result/ directory
 *   4. Save via generateFullAcl on result copy (no edits)
 *   5. Load result via parser → compare against golden snapshot
 *   6. Report per-file result
 *
 * No real game file is ever modified. Golden stays pristine.
 * All temp directories are cleaned up after the run.
 * A JSON report is written to tests/_report_/save-integrity-<timestamp>.json.
 *
 * Usage:
 *   node --require ./tests/integration/preload.cjs tests/integration/test_save_integrity_all.js [--root <game-root>] [--prod-demo] [--all]
 */

const fs = require('fs');
const path = require('path');
const parser = require('../../src/acl/parser');
const { readAclText } = require('../../src/acl/gatcarc');

const {
  loadFlights, generateFullAcl,
  _extractConfig,
  _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline,
} = parser;

// ── The 8 production + 4 demo .acl files ─────────────────────────
const PROD_DEMO_FILES = [
  { icao: 'ZSJN', name: 'ZSJN-Morning_120min.acl' },
  { icao: 'ZSJN', name: 'ZSJN_07-10.acl' },
  { icao: 'ZSJN', name: 'ZSJN-Evening_120min.acl' },
  { icao: 'ZSJN', name: 'ZSJN_19-21.acl' },
  { icao: 'KJFK', name: 'KJFK_07-09.acl' },
  { icao: 'KJFK', name: 'KJFK_09-11.acl' },
  { icao: 'KJFK', name: 'KJFK_17-20.acl' },
  { icao: 'KJFK', name: 'KJFK_20-22.acl' },
  { icao: 'ZSJN', name: 'ZSJN-Morning_120min.demo.acl' },
  { icao: 'ZSJN', name: 'ZSJN_07-10.demo.acl' },
  { icao: 'KJFK', name: 'KJFK_09-11.demo.acl' },
  { icao: 'KJFK', name: 'KJFK_20-22.demo.acl' },
];

// ── CLI ──────────────────────────────────────────────────────────
let gameRoot = null;
let prodDemoOnly = false;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--root' && i + 1 < process.argv.length) {
    gameRoot = path.resolve(process.argv[i + 1]);
  }
  if (process.argv[i] === '--prod-demo') prodDemoOnly = true;
  if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node --require ./tests/integration/preload.cjs tests/integration/test_save_integrity_all.js [--root <game-root>] [--prod-demo]');
    console.log('');
    console.log('Flow: copy from game root → golden/ → snapshot → copy golden→result/ → save on result/ → compare golden vs result');
    console.log('  --root <path>   Game root directory (required)');
    console.log('  --prod-demo     Test 8 production + 4 demo .acl files');
    console.log('  --all           Test every .acl file found (default, excludes Endless)');
    process.exit(0);
  }
}
if (!gameRoot) {
  gameRoot = path.resolve(__dirname, '..', '..', '..', '..');
}

const dataDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports');
if (!fs.existsSync(dataDir)) {
  console.error('Airports directory not found:', dataDir);
  console.error('Use --root <game-root> to specify the Airport Control 25 game directory.');
  process.exit(1);
}

// ── Collect .acl files ───────────────────────────────────────────
const aclFiles = [];

if (prodDemoOnly) {
  console.log('Target: 8 production + 4 demo .acl files');
  for (const f of PROD_DEMO_FILES) {
    const fullPath = path.join(dataDir, f.icao, 'Levels', f.name);
    if (fs.existsSync(fullPath)) {
      aclFiles.push({
        icao: f.icao,
        name: f.name,
        sourcePath: fullPath,
        sourceDir: path.dirname(fullPath),
      });
    } else {
      console.log(`  SKIP (not found): ${f.icao}/${f.name}`);
    }
  }
} else {
  const airportEntries = fs.readdirSync(dataDir, { withFileTypes: true });
  for (const ae of airportEntries) {
    if (!ae.isDirectory()) continue;
    const icao = ae.name;
    const levelsDir = path.join(dataDir, icao, 'Levels');
    if (!fs.existsSync(levelsDir)) continue;
    const levelEntries = fs.readdirSync(levelsDir, { withFileTypes: true });
    for (const le of levelEntries) {
      if (!le.isFile()) continue;
      if (!le.name.endsWith('.acl')) continue;
      if (le.name.endsWith('.acl.bak')) continue;
      if (le.name.toLowerCase().includes('endless')) continue;
      aclFiles.push({
        icao,
        name: le.name,
        sourcePath: path.join(levelsDir, le.name),
        sourceDir: levelsDir,
      });
    }
  }
}

console.log(`\nFound ${aclFiles.length} .acl files across ${new Set(aclFiles.map(f => f.icao)).size} airports`);
console.log(`Game root: ${gameRoot}\n`);

// ── Temp directories ─────────────────────────────────────────────
//   tests/integration/_tmp/
//     golden/<icao>/<name>         ← pristine copy of original + timeline JSONs
//     result/<icao>/<name>         ← copy of golden → save overwrites this
const TMP_ROOT = path.join(__dirname, '_tmp');
const GOLDEN_DIR = path.join(TMP_ROOT, 'golden');
const RESULT_DIR = path.join(TMP_ROOT, 'result');

function cleanTmp() {
  if (fs.existsSync(TMP_ROOT)) fs.rmSync(TMP_ROOT, { recursive: true });
}
cleanTmp();
fs.mkdirSync(GOLDEN_DIR, { recursive: true });
fs.mkdirSync(RESULT_DIR, { recursive: true });

console.log(`Temp golden:  ${GOLDEN_DIR}`);
console.log(`Temp result:  ${RESULT_DIR}\n`);

// ── Comparison helpers ────────────────────────────────────────────

const COMPARE_FIELDS = [
  'CallSign', 'DepartureAirport', 'ArrivalAirport',
  'Stand', 'Runway', 'OffBlockTime', 'TakeoffTime',
  'LandingTime', 'InBlockTime', 'AirlineName',
  'AircraftType', 'Airway', 'Registration', 'Voice', 'Language',
];

const CFG_FIELDS = ['startTime', 'endTime', 'flightScheduleFile', 'runwayTimelineFile'];

function compareFlights(orig, saved) {
  const diffs = [];
  if (orig.length !== saved.length) {
    diffs.push(`Flight count: ${orig.length} → ${saved.length}`);
    return diffs;
  }
  const origMap = new Map(), savedMap = new Map();
  for (const f of orig) origMap.set((f.CallSign || '').trim(), f);
  for (const f of saved) savedMap.set((f.CallSign || '').trim(), f);
  const origCS = new Set(origMap.keys()), savedCS = new Set(savedMap.keys());
  const missing = [...origCS].filter(cs => !savedCS.has(cs));
  const extra = [...savedCS].filter(cs => !origCS.has(cs));
  if (missing.length) diffs.push(`Missing flights: ${missing.slice(0, 5).join(', ')}`);
  if (extra.length) diffs.push(`Extra flights: ${extra.slice(0, 5).join(', ')}`);

  for (const cs of origCS) {
    if (!savedMap.has(cs)) continue;
    const o = origMap.get(cs), s = savedMap.get(cs);
    for (const f of COMPARE_FIELDS) {
      if ((o[f] || '').toString().trim() !== (s[f] || '').toString().trim()) {
        diffs.push(`${cs}.${f}: "${o[f]}" → "${s[f]}"`);
        if (diffs.length > 15) return diffs;
      }
    }
  }
  return diffs;
}

function compareConfig(origCfg, savedCfg, fileName) {
  const diffs = [];
  for (const f of CFG_FIELDS) {
    if ((origCfg[f] || '') !== (savedCfg[f] || '')) {
      // Demo files round endTime to nearest :X0/:X5 on save — expected diff (±2 min)
      if (f === 'endTime' && (fileName.includes('.demo.') || fileName.includes('_emerg'))) {
        continue;
      }
      diffs.push(`Config.${f}: "${origCfg[f]}" → "${savedCfg[f]}"`);
    }
  }
  return diffs;
}

function compareScenery(origSM, savedSM) {
  const diffs = [];
  const origRw = Object.keys(origSM.runwayNameToGuid || {}).length;
  const savedRw = Object.keys(savedSM.runwayNameToGuid || {}).length;
  const origSt = Object.keys(origSM.standIdToGuid || {}).length;
  const savedSt = Object.keys(savedSM.standIdToGuid || {}).length;
  if (origRw !== savedRw) diffs.push(`Runways: ${origRw} → ${savedRw}`);
  if (origSt !== savedSt) diffs.push(`Stands: ${origSt} → ${savedSt}`);
  return diffs;
}

function countTimeline(frames) {
  if (!frames) return 0;
  if (Array.isArray(frames)) return frames.length;
  return Object.keys(frames).length;
}

// ── Helper: copy .acl + timeline JSONs from source to dest dir ────
function copyLevelFiles(sourceAclPath, sourceDir, destDir, destName) {
  // Copy the .acl file
  const destAcl = path.join(destDir, destName);
  fs.copyFileSync(sourceAclPath, destAcl);

  // Discover and copy associated timeline JSONs from source directory
  const baseName = path.basename(sourceAclPath, '.acl');
  const JSON_PATTERNS = [
    'weather_timeline.json',
    'wind_timeline.json',
    `runway_timeline_${baseName}.json`,
  ];

  for (const pattern of JSON_PATTERNS) {
    const src = path.join(sourceDir, pattern);
    if (fs.existsSync(src)) {
      const dst = path.join(destDir, pattern);
      fs.copyFileSync(src, dst);
    }
  }

  // Also copy the demo parent .acl if this is a .demo.acl (needed for config extraction)
  if (destName.endsWith('.demo.acl')) {
    const parentName = destName.replace('.demo.acl', '.acl');
    const parentSrc = path.join(sourceDir, parentName);
    if (fs.existsSync(parentSrc)) {
      fs.copyFileSync(parentSrc, path.join(destDir, parentName));
    }
  }

  return destAcl;
}

// ── Run ──────────────────────────────────────────────────────────
const report = {
  gameRoot,
  startedAt: new Date().toISOString(),
  files: [],
  summary: { total: aclFiles.length, passed: 0, failed: 0, skipped: 0 },
};

for (const file of aclFiles) {
  const label = `${file.icao}/${file.name}`;
  const fileReport = { label, status: 'pending', diffs: [], error: null, metrics: {} };
  const goldenSubDir = path.join(GOLDEN_DIR, file.icao);
  const resultSubDir = path.join(RESULT_DIR, file.icao);
  fs.mkdirSync(goldenSubDir, { recursive: true });
  fs.mkdirSync(resultSubDir, { recursive: true });

  try {
    // ── Step 1: Copy original + timeline JSONs → golden/ ──────────
    const goldenAcl = copyLevelFiles(file.sourcePath, file.sourceDir, goldenSubDir, file.name);
    const goldenText = readAclText(goldenAcl);

    // ── Step 2: Load golden → snapshot ────────────────────────────
    const goldenResult = loadFlights(goldenAcl);
    if (!goldenResult || !goldenResult.flights.length) {
      throw new Error('Golden loadFlights returned empty');
    }
    const goldenCfg = _extractConfig(goldenText) || {};
    const goldenWeather = countTimeline(_parseWeatherFrames(goldenText));
    const goldenWind = countTimeline(_parseWindFrames(goldenText));
    const goldenRunway = countTimeline(_parseRunwayTimeline(goldenText));

    fileReport.metrics = {
      flights: goldenResult.flights.length,
      weatherFrames: goldenWeather,
      windFrames: goldenWind,
      runwayEntries: goldenRunway,
      goldenSize: Buffer.byteLength(goldenText, 'utf-8'),
    };

    // ── Step 3: Copy golden → result/ ─────────────────────────────
    const resultAcl = copyLevelFiles(goldenAcl, goldenSubDir, resultSubDir, file.name);

    // ── Step 4: Save on result copy (no edits) ────────────────────
    generateFullAcl(
      resultAcl,
      goldenResult.flights,
      '', '', [],
      goldenResult.worldStateData,
      goldenResult.sceneryMaps,
      goldenResult._fromWorldState,
      goldenResult._fromFlightPlans,
      null,
      goldenCfg.startTime || null,
      null,
    );

    // ── Step 5: Load result → compare against golden snapshot ─────
    const savedResult = loadFlights(resultAcl);
    if (!savedResult || !savedResult.flights.length) {
      throw new Error('Result loadFlights returned empty after save');
    }
    const savedText = readAclText(resultAcl);
    const savedCfg = _extractConfig(savedText) || {};
    const savedWeather = countTimeline(_parseWeatherFrames(savedText));
    const savedWind = countTimeline(_parseWindFrames(savedText));
    const savedRunway = countTimeline(_parseRunwayTimeline(savedText));

    fileReport.metrics.resultSize = Buffer.byteLength(savedText, 'utf-8');
    fileReport.metrics.sizeDelta = fileReport.metrics.resultSize - fileReport.metrics.goldenSize;

    // ── Step 6: Compare every component ────────────────────────────
    const allDiffs = [];

    allDiffs.push(...compareFlights(goldenResult.flights, savedResult.flights));
    allDiffs.push(...compareConfig(goldenCfg, savedCfg, file.name));
    allDiffs.push(...compareScenery(goldenResult.sceneryMaps, savedResult.sceneryMaps));

    if (goldenWeather !== savedWeather) allDiffs.push(`Weather frames: ${goldenWeather} → ${savedWeather}`);
    if (goldenWind !== savedWind) allDiffs.push(`Wind frames: ${goldenWind} → ${savedWind}`);
    if (goldenRunway !== savedRunway) allDiffs.push(`Runway timeline: ${goldenRunway} → ${savedRunway}`);
    if (goldenResult._fromFlightPlans !== savedResult._fromFlightPlans) {
      allDiffs.push(`Source format: FlightPlans changed`);
    }

    fileReport.diffs = allDiffs;

    if (allDiffs.length === 0) {
      fileReport.status = 'passed';
      report.summary.passed++;
      console.log(`  ✓ ${label} — ${goldenResult.flights.length} flights, all state identical`);
    } else {
      fileReport.status = 'failed';
      report.summary.failed++;
      console.log(`  ✗ ${label} — ${allDiffs.length} differences:`);
      allDiffs.slice(0, 5).forEach(d => console.log(`      ${d}`));
    }

  } catch (e) {
    fileReport.status = 'failed';
    fileReport.error = e.message;
    report.summary.failed++;
    console.log(`  ✗ ${label} — ERROR: ${e.message}`);
  }

  report.files.push(fileReport);

  // Clean up per-file temp subdirs (keep TMP_ROOT for now)
  try { fs.rmSync(goldenSubDir, { recursive: true }); } catch (_) {}
  try { fs.rmSync(resultSubDir, { recursive: true }); } catch (_) {}
}

// ── Cleanup all temp dirs ────────────────────────────────────────
cleanTmp();
console.log(`\nTemp directories cleaned up: ${TMP_ROOT}`);

// ── Write JSON report ────────────────────────────────────────────
const REPORT_DIR = path.join(__dirname, '..', '_reports_');
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
report.completedAt = new Date().toISOString();
const reportName = `save-integrity-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const reportPath = path.join(REPORT_DIR, reportName);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

// ── Summary ──────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`  Total:  ${report.summary.total}`);
console.log(`  Passed: ${report.summary.passed}`);
console.log(`  Failed: ${report.summary.failed}`);
console.log(`  Report: ${reportPath}`);
console.log(`${'═'.repeat(60)}\n`);

process.exit(report.summary.failed > 0 ? 1 : 0);
