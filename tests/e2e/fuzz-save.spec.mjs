/**
 * Fuzz Save Test — randomized edit storm + real SAVE (with backup)
 *
 * For each target .acl level (default: all 24 production levels):
 *   1. Open the level in the editor (browser row click)
 *   2. FuzzTest(aclPath) applies 50–200 RANDOMIZED operations through the
 *      MCP API (127.0.0.1:31415, same tools the MCP bridge exposes):
 *        - add flight            (create_flights, constrained values, in-range times)
 *        - remove one flight     (delete_flights by callsign — capped at 10%
 *                                of the run's total ops; budget 0 after a wipe)
 *        - remove all flights    (delete_flights match {} — GATED: only allowed
 *                                as the very first operation, 50% chance per run;
 *                                a wipe disables ALL further delete ops)
 *        - edit any field        (modify_flights — random valid value + cascade)
 *        - timeline ops          (add/remove weather / wind / runway-timeline rows)
 *      Every generated value is kept inside the level's config time range
 *      (flights: [start, end + 30 min grace]; timeline rows: [start, end]).
 *      Rejected operations are retried with fresh random values; a rejection
 *      caused by time bounds fails the test (the generator must never
 *      produce out-of-range data).
 *   3. Assert zero validation issues, then hit SAVE via the real UI
 *      (Ctrl+S → backup confirmation modal → success), creating the .acl.bak
 *   4. Verify: .acl.bak exists, saved .acl reloads through the real parser,
 *      flight count + callsign set match what the fuzz left in the store.
 *      The store is the right baseline for a REGULAR save: it rebuilds the
 *      file's flight-plan entries from the store (save-acl → generateFullAcl),
 *      so the saved file is expected to equal the store exactly. Note the
 *      store can be a SUBSET of the file for demo-classified basenames
 *      (DEMO_VISIBLE_BASES — e.g. ZSJN_leisure_1.acl ships as a prod file but
 *      the editor filters it to the CDT demo window at load); those file-only
 *      flights sit outside the editable window and a regular save drops them
 *      by design. (The ground-painter save is scenery-only and preserves the
 *      file's flights — fuzz-ground-save.spec.mjs baselines against the file.)
 *   5. Verify the saved .acl satisfies the game-compatibility invariants
 *      (duplicate flight-plan keys / missing docked entities / stand
 *      conflicts) — catches a stale build whose save pipeline lacks the
 *      normalization, which steps 3-4 cannot detect.
 *
 * Requires: E2E_GAME_ROOT (real game installation), npm run build first,
 * and FUZZ_RUN=1 (the spec is skipped otherwise — see npm run test:e2e).
 * The test launches its editor with an isolated API port.
 *
 * Run all production levels:
 *   $env:E2E_GAME_ROOT = "<game-root>"
 *   $env:FUZZ_RUN = "1"
 *   npx playwright test --config=playwright.config.mjs tests/e2e/fuzz-save.spec.mjs
 *
 * Run specific levels (comma-separated file names or paths):
 *   $env:FUZZ_ACL_FILES = "ZSJN/ZSJN_leisure_1.acl,KJFK/KJFK_peakarrival.acl"
 *
 * Reproduce a failure with a fixed seed:
 *   $env:FUZZ_SEED = "12345"
 *
 * Propagate results into the real game install (copies each PASSED level's
 * .acl + .acl.bak from the sandbox to E2E_GAME_ROOT/.../Levels/):
 *   npm run test:fuzz -- --replace
 */
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import net from 'net';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const parser = require('../../src/acl/parser');
// The app's real save-gate validator (same module main.js uses). Loaded via
// require() because Playwright's loader treats .js as CJS; Node 24 repairs
// typeless-ESM on the require path (same as src/acl/parser above). This
// guarantees the fuzz never tries to save a state the editor rejects.
const validators = require('../../src/utils/validators.js');
const { collectRunwayTimelineMembers } = require('../../src/acl/runway_timeline_membership');
const { readAclText } = require('../../src/acl/gatcarc');
const { openAclFile } = require('../../src/acl/archive');
const { getSchemaForHash } = require('../../src/acl/v3/schema_registry');
const { dictEntries, indexDocumentGraph, resolveGraphNode, unwrapReactive } = require('../../src/acl/v3/graph');
const { decodePosition3ToGu } = require('../../src/acl/v3/q32');
const gamePaths = require('../../src/utils/gamePaths');
const { loadV3AirportAudio } = require('../../src/acl/v3/audio');
const { verifyV3AudioCapabilities } = require('../../src/acl/v3/callsign_validation');
const {
  analyze,
  analyzeAclFile,
  runChecks,
  persistGcFailArtifact,
  verifyAndCopyReplacedLevel,
} = require('../integration/gamecompat-utils.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = process.env.E2E_TMP_DIR;
let API_BASE;
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

// Mirrors WEATHER_PRESETS in src/utils/constants/ui.js (the editor's canonical set).
const WEATHER_PRESETS = ['Sunny', 'FewCloudy', 'MidCloudy', 'PartlyCloudy', 'OvercastSky', 'AfterRain'];

const SCENARIO_END_GRACE_SEC = 30 * 60;

function _readVoiceLanguagesFromRoot(root) {
  const out = {};
  if (!root) return out;
  try {
    const p = gamePaths.voiceCatalogPath(root);
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const v of (json.voices || [])) if (v && v.name) out[v.name] = v.language || '';
  } catch (_) { /* catalog absent — no consistency data */ }
  return out;
}

// Voice catalog (name -> language) from the staged/source game root. Mirrors the
// renderer's `airportValues._voiceLanguages`; used to keep fuzz-generated
// Voice/Language pairs consistent and to assert them in the game-compat gate.
let _voiceCatalogMemo = null;
function _catalogVoiceLanguages() {
  if (_voiceCatalogMemo) return _voiceCatalogMemo;
  const root = process.env.E2E_GAME_ROOT || TMP_DIR;
  _voiceCatalogMemo = _readVoiceLanguagesFromRoot(root);
  return _voiceCatalogMemo;
}

function _readAirlineCountriesFromRoot(root) {
  const out = {};
  if (!root) return out;
  try {
    const p = gamePaths.airlineCountryRegistryPath(root);
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z]{2})\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      const country = m[1].toUpperCase();
      for (const raw of m[2].split(',')) {
        const code = raw.trim().toUpperCase();
        if (code) out[code] = country;
      }
    }
  } catch (_) { /* registry absent — no consistency data */ }
  return out;
}

// Airline country registry (code -> country) from the staged/source game root. Mirrors
// the renderer's `airportValues._airlineCountries`; on legacy/v2 the game's
// CallsignService only records a callsign for one captain language (CN → zh,
// every other → en), so legacy fuzz generates the airline-required Language.
let _airlineCountriesMemo = null;
function _catalogAirlineCountries() {
  if (_airlineCountriesMemo) return _airlineCountriesMemo;
  const root = process.env.E2E_GAME_ROOT || TMP_DIR;
  _airlineCountriesMemo = _readAirlineCountriesFromRoot(root);
  return _airlineCountriesMemo;
}

// Default target: the 24 production levels staged by global-setup.mjs
// (PROD_VISIBLE_BASES minus demo files).
const DEFAULT_PROD_FILES = [
  'ZSJN/ZSJN_leisure_1.acl', 'ZSJN/ZSJN_leisure_2.acl',
  'ZSJN/ZSJN_peakdeparture.acl', 'ZSJN/ZSJN_runwaychange.acl',
  'ZSJN/ZSJN_taixwayclosed.acl', 'ZSJN/ZSJN_surfaceradarinvisible.acl',
  'KJFK/KJFK_leisure_1.acl', 'KJFK/KJFK_leisure_2.acl', 'KJFK/KJFK_runwaychange.acl', 'KJFK/KJFK_peakdeparture.acl', 'KJFK/KJFK_peakarrival.acl', 'KJFK/KJFK_surfaceradarinvisible.acl',
  'KDCA/KDCA_leisure_1.acl', 'KDCA/KDCA_leisure_2.acl',
  'KDCA/KDCA_runwaychange.acl', 'KDCA/KDCA_peakdeparture.acl', 'KDCA/KDCA_peakarrival.acl', 'KDCA/KDCA_surfaceradarinvisible.acl',
  'ZGSZ/ZGSZ_leisure_1.acl', 'ZGSZ/ZGSZ_leisure_2.acl',
  'ZGSZ/ZGSZ_runwaychange.acl', 'ZGSZ/ZGSZ_peakdeparture.acl', 'ZGSZ/ZGSZ_peakarrival.acl', 'ZGSZ/ZGSZ_surfaceradarinvisible.acl',
];

// ── Deterministic random ────────────────────────────────────────────

function createRng(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ── Time helpers (mirror api-server.js) ─────────────────────────────

function timeToSec(t) {
  if (!t || typeof t !== 'string') return NaN;
  const p = t.split(':');
  if (p.length < 2) return NaN;
  return parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + (parseInt(p[2]) || 0);
}

function secToTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ── MCP client (same JSON-RPC protocol as mcp/bridge.js) ────────────

let rpcId = 0;

async function mcpCall(tool, args) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: ++rpcId,
    method: 'tools/call',
    params: { name: tool, arguments: args || {} },
  });
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
  const msg = await res.json();
  if (msg.error) throw new Error('MCP protocol error: ' + (msg.error.message || JSON.stringify(msg.error)));
  const text = msg.result?.content?.[0]?.text;
  if (!text) throw new Error('MCP returned empty result');
  const data = JSON.parse(text);
  if (data.isError) {
    const err = new Error(data.error?.message || data.error || 'MCP tool error');
    err.details = data.error?.details || null;
    throw err;
  }
  if (data.success === false) {
    const err = new Error(data.error?.message || data.error || 'MCP tool failed');
    err.details = data.error?.details || null;
    throw err;
  }
  return data;
}

function reasonOf(err) {
  const d = err.details;
  if (Array.isArray(d) && d.length > 0 && d[0].issue) {
    return (d[0].issue || 'validation') + (d[0].field ? ':' + d[0].field : '');
  }
  return (err.message || 'error').substring(0, 140);
}

async function getStatus() {
  return mcpCall('get_editor_status', {});
}

async function getAirportInfo() {
  return mcpCall('get_airport_info', {});
}

async function getFlights() {
  return mcpCall('get_flights', { limit: 1000 });
}

async function waitFor(fn, { timeout = 10000, interval = 200, label = 'condition' } = {}) {
  const startAt = Date.now();
  let lastErr = null;
  while (Date.now() - startAt < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? ': ' + lastErr.message : ''}`);
}

// ── UI helpers ──────────────────────────────────────────────────────

async function saveViaUI(window) {
  await window.keyboard.press('Control+s');
  await window.waitForTimeout(1500);

  let saveRan = false;
  let blockedBy = null;
  for (let pass = 0; pass < 6; pass++) {
    const modal = window.locator('#modal-overlay');
    if (!(await modal.isVisible().catch(() => false))) break;

const title = await window.locator('#modal-title').textContent().catch(() => '');
    console.log(`    Modal [${pass}]: "${title}"`);

    const isIssue = /issue|问题|修复|超出/.test(title);
    const isFail = /fail|失败/.test(title);
    const isConfirm = /backup|备份|保存前/i.test(title);

    if (isIssue || isFail) {
      const body = await window.locator('#modal-body').textContent().catch(() => '(no body)');
      blockedBy = (isFail ? 'save failed: ' : '') + body.substring(0, 400);
      console.log(`    ${isFail ? 'Save FAILED' : 'Save blocked by validation'}: ${body}`);
      const closeBtn = window.locator('#modal-actions .btn-confirm, #modal-actions .btn-cancel').first();
      if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
      await window.waitForTimeout(400);
      return { saved: false, blockedBy };
    }

    // Backup confirmation — the checkbox defaults to checked, so this
    // triggers a save WITH backup (.acl.bak).
    if (isConfirm) {
      const cb = window.locator('.modal-checkbox');
      if (await cb.isVisible({ timeout: 1000 }).catch(() => false)) {
        const checked = await cb.isChecked().catch(() => false);
        if (!checked) await cb.check();
      }
      saveRan = true;
    }

    const btn = window.locator('#modal-actions .btn-confirm').first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click();
      console.log(`    → Clicked confirm`);
    } else break;
    await window.waitForTimeout(1000);
  }
  await window.waitForTimeout(1500);
  return { saved: saveRan, blockedBy };
}

// ── FUZZ_REPLACE: propagate sandbox results into the real game install ──
// Enabled by `npm run test:fuzz -- --replace` (fuzz-cli.mjs) or by setting
// FUZZ_REPLACE=1. Copies each PASSED level's saved .acl (and the .acl.bak the
// editor produced) from the temp sandbox to E2E_GAME_ROOT — which is exactly
// what the files would look like after a real editor save session.
const FUZZ_REPLACE = process.env.FUZZ_REPLACE === '1';

function _persistGcFailArtifact(aclPath, opts = {}) {
  const res = persistGcFailArtifact(aclPath, {
    debugDir: path.join(__dirname, '..', '_debug'),
    ...opts,
  });
  if (res) {
    console.log(`  [gc-fail-artifact] saved ${opts.base || path.basename(aclPath, '.acl')} analysis to ${res.jsonOut}`);
  }
  return res;
}

export function copyToRealGame(tmpAclPath, opts = {}) {
  const res = verifyAndCopyReplacedLevel(tmpAclPath, {
    tmpDir: opts.tmpDir || process.env.E2E_TMP_DIR || TMP_DIR,
    gameRoot: opts.gameRoot || process.env.E2E_GAME_ROOT,
    debugDir: opts.debugDir !== undefined ? opts.debugDir : path.join(__dirname, '..', '_debug'),
    ...opts,
  });
  console.log(`  [replace] → ${res.dest} (+ .bak)`);
  if (res.csvDest) {
    console.log(`  [replace] → ${res.csvDest}${fs.existsSync(res.csvDest + '.bak') ? ' (+ .bak)' : ''}`);
  }
  return res;
}

async function goBackToBrowser(window) {
  for (let attempt = 0; attempt < 4; attempt++) {
    // Already back on the browser screen? Done.
    const saveBtn = window.locator('button:has-text("Save"), button:has-text("保存")').first();
    if (!(await saveBtn.isVisible({ timeout: 2000 }).catch(() => false))) return;

    const backBtn = window.locator('button:has-text("Back"), button:has-text("返回")').first();
    if (!(await backBtn.isVisible().catch(() => false))) return;
    await backBtn.click();
    await window.waitForTimeout(800);

    // Dismiss whatever modal came up. Unsaved-changes (fuzz aborted mid-run)
    // → confirm = "Discard"; any other modal → confirm = OK/close.
    for (let p = 0; p < 3; p++) {
      const modal = window.locator('#modal-overlay');
      if (!(await modal.isVisible({ timeout: 1500 }).catch(() => false))) break;
      const title = await window.locator('#modal-title').textContent().catch(() => '');
      const isUnsaved = /unsaved|未保存|放弃/.test(title);
      console.log(`    Back modal [${p}]: "${title}" (${isUnsaved ? 'unsaved → discard' : 'dismiss'})`);
      const btn = window.locator('#modal-actions .btn-confirm').first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await window.waitForTimeout(600);
      }
    }
  }
}

/**
 * FuzzTest(aclFilePath) — randomized edit storm on one level, then SAVE.
 *
 * @param {string} aclFilePath   Full path to the .acl file in the temp game root
 * @param {object} opts
 * @param {import('@playwright/test').Page} opts.window — Electron renderer page
 * @param {number} [opts.seed]   RNG seed (default Date.now())
 * @param {number} [opts.minOps] min random operations (default 50)
 * @param {number} [opts.maxOps] max random operations (default 200)
 * @returns {Promise<object>} summary { ok, file, seed, ops, accepted, rejected, deletes, rejectedReasons, backupCreated, reloadedCount, issues, error? }
 */
export async function FuzzTest(aclFilePath, { window, seed = Date.now(), minOps = 50, maxOps = 200 } = {}) {
  const base = path.basename(aclFilePath, '.acl');
  const seedRng = createRng((seed >>> 0) ^ fnv1a(base));
  const rand = () => seedRng();
  const rint = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
  const rpick = (arr) => (arr && arr.length) ? arr[Math.floor(rand() * arr.length)] : null;

  const log = (...a) => console.log(`  [fuzz:${base}]`, ...a);
  const summary = {
    file: base, seed: (seed >>> 0) ^ fnv1a(base),
    ops: 0, accepted: 0, rejected: 0, rejectedReasons: {},
    backupCreated: false, reloadedCount: -1, issues: [], repaired: 0, error: null,
  };

  try {
    // ── 1. Open the level (browser row click) ──
    // The browser's one-shot auto-collapse fit pass collapses trailing airport
    // cards on load, and a collapsed card renders NO `.level-row` elements
    // (BrowserScreen conditionally renders them — same pattern as
    // save-integrity-all-e2e.spec.mjs). Expand every card before lookup;
    // collapse state is session-persisted so this is a no-op after the first call.
    const collapsedHeaders = window.locator('.airport-card[data-expanded="false"] .airport-card-header');
    while ((await collapsedHeaders.count()) > 0) {
      await collapsedHeaders.first().click();
      await window.waitForTimeout(200);
    }
    const displayName = base.replace(/_/g, ' ');
    const nameLoc = window.locator('.level-name', { hasText: new RegExp('^' + displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') });
    const row = window.locator('.level-row', { has: nameLoc });
    // Cold scan of the game root can take 30-45s before rows render (browser.spec.mjs).
    await row.first().waitFor({ timeout: 90000 }).catch(() => {});
    if (await row.count() === 0) throw new Error(`Level row not found for "${displayName}"`);
    await row.first().click();
    await window.waitForTimeout(1500);

    let currentPath = null;
    await waitFor(async () => {
      const st = await getStatus();
      if (!st.editorReady || !st.currentPath) return false;
      currentPath = st.currentPath;
      return path.basename(st.currentPath).replace(/\.acl$/i, '') === base;
    }, { timeout: 60000, label: `editor open for ${base}` });
    log('opened:', currentPath);

    // Safety: never fuzz a file that isn't inside the temp copy root.
    const resolvedPath = path.resolve(currentPath).toLowerCase();
    const tempRoot = path.resolve(process.env.E2E_TMP_DIR).toLowerCase();
    if (!resolvedPath.startsWith(tempRoot + path.sep)) {
      throw new Error(`REFUSING to fuzz ${currentPath} — not inside temp root ${process.env.E2E_TMP_DIR}`);
    }

    // Load sanity: the store must be a SUBSET of the file. For demo-classified
    // basenames (DEMO_VISIBLE_BASES — e.g. ZSJN_leisure_1.acl ships as a prod
    // file but the editor applies the demo CDT window at load) the store
    // legitimately holds FEWER flights than the file; those file-only flights
    // are outside the editable window and a regular save (which rebuilds
    // flight-plan entries from the store) drops them by design — which is why
    // the post-save comparison below baselines against the STORE. The inverse
    // (store flights missing from the file) can never be legitimate.
    const fileCallsignsAtLoad = new Set(parser.loadFlights(currentPath).flights.map(f => f.CallSign));
    const storeCallsignsAtLoad = new Set((await getFlights()).flights.map(f => f.CallSign));
    const phantom = [...storeCallsignsAtLoad].filter(cs => !fileCallsignsAtLoad.has(cs));
    if (phantom.length) throw new Error(`store contains flights missing from the file: ${phantom.join(',')}`);
    const fileOnly = [...fileCallsignsAtLoad].filter(cs => !storeCallsignsAtLoad.has(cs));
    log(`flight baseline: file=${fileCallsignsAtLoad.size} store=${storeCallsignsAtLoad.size}${fileOnly.length ? ` (file-only, outside editable window: ${fileOnly.join(', ')})` : ''}`);

    // ── 2. Constraints + time range ──
    const info = await getAirportInfo();
    if (!info.cacheReady) throw new Error(`airport cache not ready for ${info.currentAirport || '?'}`);
    const startSec = timeToSec(info.configTimeRange?.start);
    const endSec = timeToSec(info.configTimeRange?.end);
    if (isNaN(startSec) || isNaN(endSec)) throw new Error(`no config time range: ${JSON.stringify(info.configTimeRange)}`);
    const maxFlightSec = endSec + SCENARIO_END_GRACE_SEC;

    const C = info.constraints || {};
    const icao = info.currentAirport || '';
    // Authoritative value pools: the RENDERER's airportValues[icao] — the exact
    // object the app's save-time validation runs against (airline-independent
    // AircraftType pool, Voice/Language availability, _starRunwayMap, _compat,
    // _registrationMap, _flightNums). The MCP constraints (C) are the API
    // server's supersets; everything the fuzz generates must come from the
    // renderer set so the save can never be blocked by the UI.
    const SV = await window.evaluate(
      (x) => (window.__AC27_STORE.getState().airportValues || {})[x] || null, icao
    ) || {};
    const mergedAirlines = [...new Set([
      ...(SV.AirlineCode || C.airlineCode || []),
      ...Object.keys(SV._flightNums || C.flightNumbers || {}),
    ])];
    const SU = {
      airlines: mergedAirlines,
      runways: SV.Runway || C.flatLists?.Runway || [],
      stands: SV.Stand || C.flatLists?.Stand || [],
      voices: SV.Voice || C.flatLists?.Voice || [],
      languages: SV.Language || C.flatLists?.Language || [],
      voiceLanguages: (SV._voiceLanguages && Object.keys(SV._voiceLanguages).length ? SV._voiceLanguages : _catalogVoiceLanguages()),
      airlineCountries: (SV._airlineCountries && Object.keys(SV._airlineCountries).length ? SV._airlineCountries : _catalogAirlineCountries()),
      aircraftTypes: SV.AircraftType || C.aircraftTypes || [],
      flightNums: SV._flightNums || C.flightNumbers || {},
      compat: SV._compat?.airlineToAircraft || C.airlineAircraftCompat || {},
      regs: SV._registrationMap || C.registrationsByPair || {},
      rwyStars: SV._runwayStarMap || C.runwayStarCompat || {},
    };
    const airlines = SU.airlines;
    const runways = SU.runways;
    const stands = SU.stands;
    const voices = SU.voices;
    const languages = SU.languages;
    const voiceLanguages = SU.voiceLanguages || {};
    const airlineCountries = SU.airlineCountries || {};
    // Required captain language for an airline on legacy/v2: CN carriers speak zh,
    // every other carrier speaks en. Returns null for unknown airlines.
    const airlineLanguage = (code) => {
      const country = airlineCountries[String(code || '').toUpperCase()];
      if (!country) return null;
      return country === 'CN' ? (languages.includes('zh') ? 'zh' : 'en') : 'en';
    };
    // Legacy/v2 voice picker matching flight Language.
    const pickVoice = (lang) => {
      if (!voices.length) return '';
      const known = lang ? voices.filter((v) => voiceLanguages[v] === lang) : [];
      if (known.length) return rpick(known);
      const unknown = voices.filter((v) => !voiceLanguages[v]);
      if (unknown.length) return rpick(unknown);
      return rpick(voices) || '';
    };
    const aircraftTypes = SU.aircraftTypes;
    log(`range ${info.configTimeRange.start}–${info.configTimeRange.end}  airlines=${airlines.length} runways=${runways.length} stands=${stands.length}`);
    if (!airlines.length || !runways.length || !stands.length) throw new Error('empty constraint lists — cannot build valid flights');

    const isV3Level = openAclFile(currentPath).format === 'gatcarc4-v3' || Boolean(SV._v3Audio || SV._isV3);
    let v3AudioBundle = null;
    let v3AudioData = null;
    if (isV3Level) {
      const sourceRoot = process.env.E2E_GAME_ROOT || null;
      const startupCap = verifyV3AudioCapabilities({
        targetRoot: TMP_DIR,
        icao,
        sourceRoot,
        requireUsable: true,
      });
      if (!startupCap.ok) {
        throw new Error(`[v3-audio-startup] ${startupCap.message}`);
      }
      const rendererV3 = (SV._v3Audio && typeof SV._v3Audio === 'object') ? SV._v3Audio : null;
      if (!rendererV3 || !rendererV3.hasCatalog || !rendererV3.hasClipIndex) {
        throw new Error(
          `[v3-audio-startup] renderer _v3Audio missing capabilities for ${icao}: ` +
          `hasCatalog=${Boolean(rendererV3?.hasCatalog)} hasClipIndex=${Boolean(rendererV3?.hasClipIndex)} ` +
          `knownChannelConfig=${Boolean(rendererV3?.knownChannelConfig)}`,
        );
      }
      if (startupCap.capabilities.knownChannelConfig && !rendererV3.knownChannelConfig) {
        throw new Error(
          `[v3-audio-startup] renderer _v3Audio lost radio_channel_config.json for ${icao} ` +
          `(staged knownChannelConfig=true, renderer knownChannelConfig=false)`,
        );
      }
      if (FUZZ_REPLACE && sourceRoot) {
        const destCap = verifyV3AudioCapabilities({
          targetRoot: sourceRoot,
          icao,
          sourceRoot,
          requireUsable: Boolean(startupCap.sourceShipsV3Audio),
        });
        if (!destCap.ok) {
          throw new Error(`[v3-audio-startup] --replace destination audio check failed: ${destCap.message}`);
        }
      }
      v3AudioBundle = loadV3AirportAudio(TMP_DIR, icao);
      v3AudioData = v3AudioBundle.v3Audio;
      log(
        `v3 audio capabilities verified: catalog=${startupCap.capabilities.hasCatalog} ` +
        `clips=${startupCap.capabilities.hasClipIndex} channel=${startupCap.capabilities.knownChannelConfig} ` +
        `captains=${v3AudioData.captainVoices.length} callsigns=${v3AudioBundle.audioCallsigns.allCallsigns.length}`,
      );
    }

    const v3CaptainVoices = isV3Level && v3AudioData
      ? (v3AudioData.captainVoices || []).filter((v) => !voices.length || voices.includes(v))
      : [];
    const airlineWhitelistSet = new Set(airlines);

    const pickV3Tuple = ({
      usedCallsigns = new Set(),
      airlineFilter = null,
      langFilter = null,
      voiceFilter = null,
      excludeVoice = null,
      excludeCallsign = null,
    } = {}) => {
      if (!v3AudioData) return null;
      const candidateVoices = v3CaptainVoices.filter((v) => {
        if (voiceFilter && v !== voiceFilter) return false;
        if (excludeVoice && v === excludeVoice) return false;
        const vLang = v3AudioData.voiceLanguages?.[v] || voiceLanguages[v] || '';
        if (!vLang) return false;
        if (languages.length && !languages.includes(vLang)) return false;
        if (langFilter && vLang !== langFilter) return false;
        return true;
      });
      if (!candidateVoices.length) return null;

      const voiceOrder = [...candidateVoices];
      for (let i = voiceOrder.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [voiceOrder[i], voiceOrder[j]] = [voiceOrder[j], voiceOrder[i]];
      }

      for (const voice of voiceOrder) {
        const language = v3AudioData.voiceLanguages?.[voice] || voiceLanguages[voice] || '';
        const byAirline = v3AudioData.allocatableByVoice?.[voice] || {};
        const candidateAirlines = Object.keys(byAirline).filter((al) => {
          if (airlineFilter && al !== airlineFilter) return false;
          if (airlineWhitelistSet.size > 0 && !airlineWhitelistSet.has(al)) return false;
          return Array.isArray(byAirline[al]) && byAirline[al].length > 0;
        });
        if (!candidateAirlines.length) continue;

        const alOrder = [...candidateAirlines];
        for (let i = alOrder.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [alOrder[i], alOrder[j]] = [alOrder[j], alOrder[i]];
        }

        for (const airlineCode of alOrder) {
          const allowedNumsSet = Array.isArray(SU.flightNums?.[airlineCode]) && SU.flightNums[airlineCode].length > 0
            ? new Set(SU.flightNums[airlineCode])
            : null;
          const validNums = (byAirline[airlineCode] || []).filter((num) => {
            if (allowedNumsSet && !allowedNumsSet.has(num)) return false;
            const cs = airlineCode + num;
            if (excludeCallsign && cs === excludeCallsign) return false;
            if (usedCallsigns && usedCallsigns.has(cs)) return false;
            return true;
          });
          if (!validNums.length) continue;
          const flightNum = rpick(validNums);
          return {
            CallSign: airlineCode + flightNum,
            AirlineCode: airlineCode,
            FlightNum: flightNum,
            Language: language,
            Voice: voice,
          };
        }
      }
      return null;
    };

    const pickV3VoiceForCallsign = (callSign, { langFilter = null, excludeVoice = null } = {}) => {
      if (!v3AudioData || !callSign) return null;
      const matches = v3CaptainVoices.filter((v) => {
        if (excludeVoice && v === excludeVoice) return false;
        const vLang = v3AudioData.voiceLanguages?.[v] || voiceLanguages[v] || '';
        if (!vLang) return false;
        if (languages.length && !languages.includes(vLang)) return false;
        if (langFilter && vLang !== langFilter) return false;
        const list = v3AudioData.knownChannelConfig
          ? v3AudioData.allocatableCallsignsByVoice?.[v]
          : v3AudioData.voiceCallsigns?.[v];
        return Array.isArray(list) && list.includes(callSign);
      });
      if (!matches.length) return null;
      const voice = rpick(matches);
      return {
        Voice: voice,
        Language: v3AudioData.voiceLanguages?.[voice] || voiceLanguages[voice] || '',
      };
    };

    const usableApprSet = isV3Level && Array.isArray(SV._liveUsableApprRunways)
      ? new Set(SV._liveUsableApprRunways)
      : null;

    // STAR + approach eligibility for arrivals — arrivals must ALWAYS carry a
    // STAR (FlightPlan.Init() drops STAR-less arrival legs) and on v3 must
    // land on a runway with a usable RouteType = 1 approach route.
    const arrivalCapableRunways = Object.keys(SU.rwyStars || {}).sort()
      .filter((r) => runways.includes(r) && (SU.rwyStars[r] || []).length > 0 && (!usableApprSet || usableApprSet.has(r)));
    const firstArrivalCapable = arrivalCapableRunways[0] || null;

    // On v3, FlightPlanSessionValidator.ValidateRunways requires every flight
    // leg's runway to appear in MetaData.RunwayTimeline (initial set or valid
    // transitions). Recompute dynamically from live runwayTimeline so choices
    // stay valid after timeline mutations.
    const computeValidRunwaysForTimeline = (rt) => {
      if (!isV3Level) {
        return { enforced: false, members: new Set(runways), depRunways: runways, arrRunways: arrivalCapableRunways };
      }
      const { enforced, members } = collectRunwayTimelineMembers(rt);
      const depRunways = enforced ? runways.filter((r) => members.has(r)) : runways;
      const depSet = new Set(depRunways);
      const arrRunways = arrivalCapableRunways.filter((r) => !enforced || depSet.has(r));
      return { enforced, members, depRunways, arrRunways };
    };
    const getLiveValidRunways = async () => {
      const rt = await window.evaluate(() => window.__AC27_STORE.getState().runwayTimeline ?? null);
      return { rt, ...computeValidRunwaysForTimeline(rt) };
    };

    const starFor = (rwy, allowedArrRunways = arrivalCapableRunways) => {
      const list = SU.rwyStars?.[rwy];
      if (Array.isArray(list) && list.length > 0 && (!allowedArrRunways.length || allowedArrRunways.includes(rwy))) {
        const star = rpick(list);
        return star || list[0];
      }
      const fallbackRwy = (allowedArrRunways && allowedArrRunways.length ? allowedArrRunways[0] : firstArrivalCapable);
      return fallbackRwy ? (SU.rwyStars[fallbackRwy]?.[0] || null) : null;
    };
    // Airway (+ optional Runway) update that always yields a STAR/runway
    // pair the game accepts. Returns null when no arrival runway is available.
    const starUpdateFor = (rwy, allowedArrRunways = arrivalCapableRunways) => {
      const stars = SU.rwyStars?.[rwy] || [];
      const rwyAllowed = !allowedArrRunways.length || allowedArrRunways.includes(rwy);
      if (stars.length && rwyAllowed) return { Airway: rpick(stars) || stars[0] };
      const fallbackRwy = (allowedArrRunways && allowedArrRunways.length ? allowedArrRunways[0] : firstArrivalCapable);
      if (fallbackRwy && SU.rwyStars[fallbackRwy]?.length) {
        return { Runway: fallbackRwy, Airway: SU.rwyStars[fallbackRwy][0] };
      }
      return null;
    };
    // Registration the editor actually accepts for a (airline, aircraft) pair.
    const regPoolFor = (al, ac) => {
      const pairKey = al + '|' + ac;
      const list = (SU.regs && (SU.regs[pairKey] || SU.regs[ac + '|' + al])) || null;
      if (Array.isArray(list) && list.length > 0) return list;
      const prefix = /^B/.test(ac || '') ? 'B-' : 'N';
      return [prefix + (ac.startsWith('B') ? rint(1000, 9999) : rint(100, 999) + 'AB')];
    };
    // Synthetic registration in the same format as a pool sample, guaranteed
    // unique against `avoid` — the validator flags duplicates by VALUE, so a
    // fallback that reuses a pool entry (even a legit one) never converges.
    const syntheticReg = (sample, avoid) => {
      const m = typeof sample === 'string' ? /^([A-Z-]*[A-Z]?)(\d{2,6})([A-Z]{0,2})$/.exec(sample.trim()) : null;
      const head = m ? m[1] : 'N';
      const dlen = m ? m[2].length : 3;
      const tail = m ? m[3] : '';
      const lo = Math.pow(10, dlen - 1);
      const hi = Math.pow(10, dlen) - 1;
      const make = () => {
        let s = head + String(rint(lo, hi));
        if (tail) {
          const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
          s += Array.from({ length: tail.length }, () => rpick(letters)).join('');
        } else if (/^N$/.test(head)) {
          s += rpick(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z']);
        }
        return s;
      };
      let r = make();
      for (let i = 0; i < 200 && avoid.has(r); i++) r = make();
      return r;
    };
    const regAvoiding = (al, ac, avoid) => {
      const pool = regPoolFor(al, ac);
      for (let i = 0; i < 12; i++) {
        const r = rpick(pool);
        if (r && !avoid.has(r)) return r;
      }
      return syntheticReg(pool[0], avoid);
    };
    // AircraftType is airline-independent: prefer the airline's compat list (so
    // generated flights look realistic and registrations resolve) but fall back
    // to the full profiled pool. The save-time validation accepts any type.
    const typePoolFor = (code) => {
      const compat = SU.compat?.[code];
      const pool = (Array.isArray(compat) && compat.length ? compat : Object.values(SU.compat || {}).flat())
        .filter(t => aircraftTypes.includes(t));
      return pool.length ? pool : aircraftTypes;
    };
    const numFor = (al) => {
      const list = SU.flightNums?.[al];
      if (Array.isArray(list) && list.length > 0) return rpick(list);
      return null;
    };
    // Live registration uniqueness groups (validator: dup regs only matter
    // within the departure group and within the arrival group separately).
    const isArrOf = (f) => (f.isDeparture === false) || (!!(f.LandingTime || '').trim() && !(f.OffBlockTime || '').trim());
    const usedRegs = async () => {
      const flights = (await getFlights()).flights;
      const sets = { dep: new Set(), arr: new Set() };
      for (const f of flights) {
        const reg = (f._Registration || f.Registration || '').trim();
        if (!reg) continue;
        (isArrOf(f) ? sets.arr : sets.dep).add(reg);
      }
      return sets;
    };
    const randTimelineTime = (exclusive = false) => {
      const lo = exclusive ? startSec + 60 : startSec;
      const hi = exclusive ? endSec - 60 : endSec;
      return secToTime(rint(lo, Math.max(lo, hi)));
    };

    const buildRandomFlight = async (avoidRegs, usedCallsigns = new Set()) => {
      const { depRunways, arrRunways } = await getLiveValidRunways();
      let isArr = rand() < 0.5;
      if (isArr && !arrRunways.length && depRunways.length) isArr = false;
      const runway = isArr
        ? rpick(arrRunways.length ? arrRunways : arrivalCapableRunways)
        : rpick(depRunways.length ? depRunways : runways);
      const stand = rpick(stands);
      const t1 = rint(startSec, maxFlightSec - 60);
      const t2 = Math.min(t1 + rint(60, 15 * 60), maxFlightSec);
      const group = isArr ? 'arr' : 'dep';

      if (isV3Level) {
        const tuple = pickV3Tuple({ usedCallsigns });
        if (!tuple) return null;
        const ac = typePoolFor(tuple.AirlineCode);
        const aircraft = rpick(ac);
        return {
          CallSign: tuple.CallSign,
          DepartureAirport: isArr ? icao : '',
          ArrivalAirport: isArr ? '' : icao,
          Stand: stand,
          Runway: runway,
          OffBlockTime: isArr ? '' : secToTime(t1),
          TakeoffTime: isArr ? '' : secToTime(t2),
          LandingTime: isArr ? secToTime(t1) : '',
          InBlockTime: isArr ? secToTime(t2) : '',
          AirlineName: tuple.AirlineCode,
          AircraftType: aircraft,
          Airway: isArr ? (starFor(runway, arrRunways) || '') : '',
          Registration: regAvoiding(tuple.AirlineCode, aircraft, avoidRegs[group]),
          Voice: tuple.Voice,
          Language: tuple.Language,
        };
      }

      // Legacy / v2: airlines with a known flight-number list first, so callsigns pass
      // the canonical flight-number validation on the first try.
      let airline = null;
      for (let i = 0; i < 8 && !airline; i++) {
        const cand = rpick(airlines);
        if ((SU.flightNums?.[cand] || []).length > 0) airline = cand;
      }
      if (!airline) airline = rpick(airlines);
      const ac = typePoolFor(airline);
      const aircraft = rpick(ac);
      const num = numFor(airline) || String(rint(1000, 9999));
      const language = airlineLanguage(airline) || rpick(languages) || (icao.startsWith('Z') ? 'zh' : 'en');
      const flight = {
        CallSign: airline + num,
        DepartureAirport: isArr ? icao : '',
        ArrivalAirport: isArr ? '' : icao,
        Stand: stand,
        Runway: runway,
        OffBlockTime: isArr ? '' : secToTime(t1),
        TakeoffTime: isArr ? '' : secToTime(t2),
        LandingTime: isArr ? secToTime(t1) : '',
        InBlockTime: isArr ? secToTime(t2) : '',
        AirlineName: airline,
        AircraftType: aircraft,
        Airway: isArr ? (starFor(runway, arrRunways) || '') : '',
        Registration: regAvoiding(airline, aircraft, avoidRegs[group]),
        Voice: pickVoice(language),
        Language: language,
      };
      return flight;
    };

    // ── 2b. Deterministic v3 negative checks (no RNG consumption) ──
    if (isV3Level) {
      const sha256File = (p) => fs.existsSync(p)
        ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
        : null;
      const initValid = await getLiveValidRunways();
      const initFlights = (await getFlights()).flights;
      if (initValid.enforced && initFlights.length > 0) {
        // Negative Case 1: assigning a scenery runway absent from runwayTimeline
        // must be rejected by MCP modify_flights and block UI Save without touching files.
        const outsideRwy = runways.find((r) => !initValid.members.has(r));
        const depSample = initFlights.find((f) => !isArrOf(f)) || initFlights[0];
        if (outsideRwy && depSample) {
          let mcpRejected = false;
          try {
            await mcpCall('modify_flights', { match: { callsign: depSample.CallSign }, updates: { Runway: outsideRwy } });
          } catch (negErr) {
            const msg = reasonOf(negErr);
            if (!msg.includes('runway_not_in_timeline') && !msg.includes('level runway timeline')) {
              throw new Error(`expected runway_not_in_timeline on ${depSample.CallSign} → ${outsideRwy}, got: ${msg}`);
            }
            mcpRejected = true;
          }
          if (!mcpRejected) {
            throw new Error(`MCP modify_flights accepted non-timeline runway ${outsideRwy} for ${depSample.CallSign}`);
          }

          const preAclHash = sha256File(currentPath);
          const preBakHash = sha256File(currentPath + '.bak');
          const snapA = await window.evaluate(({ cs, badRwy }) => {
            const st = window.__AC27_STORE.getState();
            const prevFlights = st.flights;
            const prevMod = st.modified;
            const nextFlights = prevFlights.map((f) => f.CallSign === cs ? { ...f, Runway: badRwy } : f);
            window.__AC27_STORE.setState({ flights: nextFlights, modified: true });
            return { prevFlights, prevMod };
          }, { cs: depSample.CallSign, badRwy: outsideRwy });
          try {
            const blockedSave = await saveViaUI(window);
            if (blockedSave.saved) {
              throw new Error(`UI Save succeeded despite non-timeline runway ${outsideRwy} on ${depSample.CallSign}`);
            }
            if (sha256File(currentPath) !== preAclHash || sha256File(currentPath + '.bak') !== preBakHash) {
              throw new Error('rejected UI Save modified .acl or .acl.bak');
            }
          } finally {
            await window.evaluate(({ prevFlights, prevMod }) => {
              window.__AC27_STORE.setState({ flights: prevFlights, modified: prevMod });
            }, snapA);
          }
          log(`negative check 1 passed: ${depSample.CallSign} → non-timeline ${outsideRwy} rejected by MCP & UI Save`);
        }

        // Negative Case 2: timeline-only edit removing a runway still referenced
        // by an existing flight must fail whole-schedule MCP validation and block UI Save.
        const refFlight = initFlights.find((f) => f.Runway && initValid.members.has(f.Runway));
        if (refFlight) {
          const usedRwy = refFlight.Runway;
          const preAclHash = sha256File(currentPath);
          const preBakHash = sha256File(currentPath + '.bak');
          const snapB = await window.evaluate((dropRwy) => {
            const st = window.__AC27_STORE.getState();
            const prevRt = st.runwayTimeline;
            const prevTlm = st.timelineModified;
            const prevMod = st.modified;
            const keepInit = (prevRt?.initialRunways || []).filter((r) => r !== dropRwy);
            const keepTl = (prevRt?.timeline || [])
              .map((entry) => ({
                ...entry,
                changes: (entry.changes || []).filter((c) => c.source !== dropRwy && c.dest !== dropRwy),
              }))
              .filter((entry) => entry.changes.length > 0);
            window.__AC27_STORE.setState({
              runwayTimeline: { initialRunways: keepInit, timeline: keepTl },
              timelineModified: { ...(prevTlm || {}), runway: true },
              modified: true,
            });
            return { prevRt, prevTlm, prevMod };
          }, usedRwy);
          try {
            const valRes = await mcpCall('get_validation_issues', {});
            const hit = (valRes.issues || []).some((m) => m.includes(refFlight.CallSign) && m.includes('level runway timeline'));
            if (!hit) {
              throw new Error(`timeline-only removal of ${usedRwy} did not flag ${refFlight.CallSign} in get_validation_issues: ${JSON.stringify(valRes.issues)}`);
            }
            const blockedSave2 = await saveViaUI(window);
            if (blockedSave2.saved) {
              throw new Error(`UI Save succeeded after removing referenced runway ${usedRwy} from timeline`);
            }
            if (sha256File(currentPath) !== preAclHash || sha256File(currentPath + '.bak') !== preBakHash) {
              throw new Error('rejected timeline-only UI Save modified .acl or .acl.bak');
            }
          } finally {
            await window.evaluate(({ prevRt, prevTlm, prevMod }) => {
              window.__AC27_STORE.setState({ runwayTimeline: prevRt, timelineModified: prevTlm, modified: prevMod });
            }, snapB);
          }
          log(`negative check 2 passed: removing referenced runway ${usedRwy} from timeline flagged ${refFlight.CallSign} & blocked UI Save`);
        }
      }

      // Negative Case 3: deliberate callsign/voice clip mismatch (`AXM1416` + `Yeager`,
      // registration `B-13Q2`) must fail MCP validation, UI preflight, and the
      // authoritative v3 save handler while keeping edits in memory and leaving
      // `.acl`, `.acl.bak`, and `.csv` untouched.
      const hasAxm1416 = Array.isArray(SU.flightNums?.AXM) && SU.flightNums.AXM.includes('1416');
      if (initFlights.length > 0 && hasAxm1416) {
        const cleanBaseline = initFlights.find(
          (f) => f.CallSign !== 'AXM1416' && (f._Registration || f.Registration) !== 'B-13Q2',
        ) || initFlights[0];
        const initActiveArr = (initValid.rt?.initialRunways || []).filter((r) => initValid.arrRunways.includes(r));
        const axmRwy = initActiveArr[0] || initValid.arrRunways[0] || arrivalCapableRunways[0] || runways[0];
        const axmStar = (SU.rwyStars?.[axmRwy] || [])[0] || '';
        const axmStand = stands.find((s) => s !== cleanBaseline?.Stand) || stands[0];
        const axmLandSec = Math.min(startSec + 120, maxFlightSec - 120);
        const axmInBlockSec = Math.min(axmLandSec + 300, maxFlightSec);
        const badAxmFlight = {
          CallSign: 'AXM1416',
          DepartureAirport: 'WMKK',
          ArrivalAirport: '',
          Stand: axmStand,
          Runway: axmRwy,
          OffBlockTime: '',
          TakeoffTime: '',
          LandingTime: secToTime(axmLandSec),
          InBlockTime: secToTime(axmInBlockSec),
          AirlineName: 'AXM',
          AircraftType: aircraftTypes[0] || 'A320',
          Airway: axmStar,
          Registration: 'B-13Q2',
          Voice: 'Yeager',
          Language: 'en',
        };

        const levelSuffix3 = base.startsWith(icao + '_') ? base.slice(icao.length + 1) : base;
        const csvPath3 = path.join(path.dirname(currentPath), 'flight_schedule_' + levelSuffix3 + '.csv');
        const preAclHash3 = sha256File(currentPath);
        const preBakHash3 = sha256File(currentPath + '.bak');
        const preCsvHash3 = sha256File(csvPath3);

        const snapC = await window.evaluate((baseline) => {
          const st = window.__AC27_STORE.getState();
          const prevFlights = st.flights;
          const prevMod = st.modified;
          window.__AC27_STORE.setState({ flights: baseline ? [baseline] : [], modified: false });
          return { prevFlights, prevMod };
        }, cleanBaseline);

        try {
          let mcpClipRejected = false;
          try {
            await mcpCall('create_flights', { flights: [badAxmFlight] });
          } catch (negErr3) {
            const hasClipIssue = Array.isArray(negErr3.details)
              && negErr3.details.some((d) => d.issue === 'callsign_voice_mismatch');
            if (!hasClipIssue) {
              throw new Error(
                `expected callsign_voice_mismatch on AXM1416 + Yeager, got: ${JSON.stringify(negErr3.details || negErr3.message)}`,
              );
            }
            mcpClipRejected = true;
          }
          if (!mcpClipRejected) {
            throw new Error('MCP create_flights accepted AXM1416 + Yeager (missing captain clip)');
          }

          await window.evaluate((badFl) => {
            window.__AC27_STORE.setState({ flights: [badFl], modified: true });
          }, badAxmFlight);

          const valRes3 = await mcpCall('get_validation_issues', {});
          const flaggedAxm = (valRes3.issues || []).some(
            (m) => m.includes('AXM1416') && m.includes('B-13Q2') && m.includes('Yeager'),
          );
          if (!flaggedAxm) {
            throw new Error(
              `get_validation_issues did not report B-13Q2 / AXM1416 / Yeager: ${JSON.stringify(valRes3.issues)}`,
            );
          }

          const blockedUiSave3 = await saveViaUI(window);
          if (blockedUiSave3.saved) {
            throw new Error('UI Save succeeded despite AXM1416 + Yeager missing captain clip');
          }
          const storeAfterBlock = await window.evaluate(() => {
            const st = window.__AC27_STORE.getState();
            return {
              count: st.flights.length,
              cs: st.flights[0]?.CallSign || null,
              reg: st.flights[0]?.Registration || null,
              modified: Boolean(st.modified),
            };
          });
          if (storeAfterBlock.count !== 1 || storeAfterBlock.cs !== 'AXM1416' || !storeAfterBlock.modified) {
            throw new Error(`UI preflight failed to preserve in-memory AXM1416 edit: ${JSON.stringify(storeAfterBlock)}`);
          }

          const ipcRes3 = await window.evaluate(
            ({ p, fls }) => window.electronAPI.saveAcl({ filePath: p, flights: fls, createBackup: true }),
            { p: currentPath, fls: [badAxmFlight] },
          );
          if (!ipcRes3 || ipcRes3.success !== false) {
            throw new Error(`direct IPC saveAcl accepted AXM1416 + Yeager: ${JSON.stringify(ipcRes3)}`);
          }
          const ipcErrStr = String(ipcRes3.error || '');
          if (!ipcErrStr.includes('B-13Q2') || !ipcErrStr.includes('AXM1416') || !ipcErrStr.includes('Yeager')) {
            throw new Error(`saveAcl error missing registration/callsign/voice details: ${ipcErrStr}`);
          }

          if (
            sha256File(currentPath) !== preAclHash3 ||
            sha256File(currentPath + '.bak') !== preBakHash3 ||
            sha256File(csvPath3) !== preCsvHash3
          ) {
            throw new Error('rejected AXM1416 + Yeager save modified .acl, .acl.bak, or .csv on disk');
          }
          log('negative check 3 passed: AXM1416 + Yeager (B-13Q2) rejected by MCP, UI Save & v3 handler with files intact');
        } finally {
          await window.evaluate(({ prevFlights, prevMod }) => {
            window.__AC27_STORE.setState({ flights: prevFlights, modified: prevMod });
          }, snapC);
        }
      }
    }

    // ── 3. Randomized operations ──
    const nOps = rint(Math.min(minOps, maxOps), maxOps);
    summary.ops = nOps;
    log(`fuzzing with ${nOps} operations (seed ${summary.seed})`);

    const countSync = async (expected, label) => {
      await waitFor(async () => {
        try { return (await getStatus()).flightCount === expected; } catch (_) { return false; }
      }, { timeout: 8000, interval: 150, label });
    };

    const doAddFlight = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const curFlights = (await getFlights()).flights;
        const usedCs = new Set(curFlights.map((x) => x.CallSign).filter(Boolean));
        const avoid = { dep: new Set(), arr: new Set() };
        for (const x of curFlights) {
          const reg = (x._Registration || x.Registration || '').trim();
          if (!reg) continue;
          (isArrOf(x) ? avoid.arr : avoid.dep).add(reg);
        }
        const flight = await buildRandomFlight(avoid, usedCs);
        if (!flight) {
          lastReason = 'unavailable_v3_callsign_voice_tuple';
          continue;
        }
        try {
          const before = curFlights.length;
          const r = await mcpCall('create_flights', { flights: [flight] });
          await countSync(before + r.created, 'create apply');
          fuzzLog.accepted.push(`create_flights ${flight.CallSign} (${flight.LandingTime ? 'ARR' : 'DEP'}) → ${flight.Runway}/${flight.Stand}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(120); }
      }
      fuzzLog.rejected.push('create_flights: ' + lastReason);
      return false;
    };

    const doDeleteOne = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const flights = (await getFlights()).flights;
        if (!flights.length) return false;
        const target = rpick(flights);
        try {
          const before = flights.length;
          await mcpCall('delete_flights', { match: { callsign: target.CallSign } });
          await countSync(before - 1, 'delete apply');
          fuzzLog.accepted.push(`delete_flights ${target.CallSign}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(120); }
      }
      fuzzLog.rejected.push('delete_flights: ' + lastReason);
      return false;
    };

    const doDeleteAll = async (fuzzLog) => {
      try {
        const before = (await getStatus()).flightCount;
        const r = await mcpCall('delete_flights', { match: {} });
        await countSync(before - r.deleted, 'delete-all apply');
        fuzzLog.accepted.push(`delete_flights (remove all) → removed ${r.deleted}`);
        return true;
      } catch (e) {
        fuzzLog.rejected.push('delete_flights-all: ' + reasonOf(e));
        return false;
      }
    };

    const doModifyFlight = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const flights = (await getFlights()).flights;
        if (!flights.length) return false;
        const { depRunways, arrRunways } = await getLiveValidRunways();
        const f = rpick(flights);
        const isArr = !!f.LandingTime;
        const usedCsOther = new Set(
          flights.filter((x) => x.CallSign && x.CallSign !== f.CallSign).map((x) => x.CallSign),
        );
        const updates = {};
        const roll = () => rint(0, 100);
        const r = roll();
        try {
          if (r < 14) updates.Stand = rpick(stands);
          else if (r < 28) {
            if (isArr) {
              const nextRwy = rpick(arrRunways);
              if (!nextRwy) continue;
              updates.Runway = nextRwy;
              if (!(SU.rwyStars?.[nextRwy] || []).includes(f.Airway)) {
                updates.Airway = starFor(nextRwy, arrRunways) || '';
              }
            } else {
              const nextRwy = rpick(depRunways);
              if (!nextRwy) continue;
              updates.Runway = nextRwy;
            }
          }
          else if (r < 38 && isArr && f.Runway) Object.assign(updates, starUpdateFor(f.Runway, arrRunways) || { Airway: starFor(f.Runway, arrRunways) || '' });
          else if (r < 50) {
            const tp = typePoolFor((f.CallSign || '').substring(0, 3));
            if (tp.length) updates.AircraftType = rpick(tp);
            else continue;
          }
          else if (r < 62) {
            const group = isArr ? 'arr' : 'dep';
            const avoid = await usedRegs();
            updates.Registration = regAvoiding((f.CallSign || '').substring(0, 3), f.AircraftType || '', avoid[group]);
          }
          else if (r < 70 && f.Runway && isArr) Object.assign(updates, starUpdateFor(f.Runway, arrRunways) || { Airway: starFor(f.Runway, arrRunways) });
          else if (r < 78) {
            if (isV3Level) {
              const vp = pickV3VoiceForCallsign(f.CallSign, { langFilter: f.Language, excludeVoice: f.Voice })
                || pickV3VoiceForCallsign(f.CallSign, { excludeVoice: f.Voice });
              if (vp) {
                updates.Voice = vp.Voice;
                if (vp.Language && vp.Language !== f.Language) updates.Language = vp.Language;
              } else {
                const tp = pickV3Tuple({ usedCallsigns: usedCsOther, excludeVoice: f.Voice })
                  || pickV3Tuple({ usedCallsigns: usedCsOther });
                if (!tp) { lastReason = 'unavailable_v3_voice_tuple'; continue; }
                const curAl = (f.CallSign || '').substring(0, 3);
                Object.assign(updates, {
                  AirlineCode: tp.AirlineCode,
                  FlightNum: tp.FlightNum,
                  Language: tp.Language,
                  Voice: tp.Voice,
                });
                if (tp.AirlineCode !== curAl) {
                  const avoid = await usedRegs();
                  updates.Registration = regAvoiding(tp.AirlineCode, f.AircraftType || '', avoid[isArr ? 'arr' : 'dep']);
                }
              }
            } else {
              updates.Voice = pickVoice(f.Language) || f.Voice || '';
            }
          }
          else if (r < 86) {
            if (isV3Level) {
              const altLangs = languages.filter((l) => l !== f.Language);
              const targetLang = rpick(altLangs.length ? altLangs : languages) || f.Language;
              const vp = pickV3VoiceForCallsign(f.CallSign, { langFilter: targetLang });
              if (vp) {
                updates.Language = vp.Language;
                updates.Voice = vp.Voice;
              } else {
                const tp = pickV3Tuple({ usedCallsigns: usedCsOther, langFilter: targetLang })
                  || pickV3Tuple({ usedCallsigns: usedCsOther });
                if (!tp) { lastReason = 'unavailable_v3_language_voice_tuple'; continue; }
                const curAl = (f.CallSign || '').substring(0, 3);
                Object.assign(updates, {
                  AirlineCode: tp.AirlineCode,
                  FlightNum: tp.FlightNum,
                  Language: tp.Language,
                  Voice: tp.Voice,
                });
                if (tp.AirlineCode !== curAl) {
                  const avoid = await usedRegs();
                  updates.Registration = regAvoiding(tp.AirlineCode, f.AircraftType || '', avoid[isArr ? 'arr' : 'dep']);
                }
              }
            } else {
              // Legacy/v2: language follows the airline (CN → zh, else en) + matching voice.
              const nl = airlineLanguage((f.CallSign || '').substring(0, 3)) || rpick(languages) || (icao.startsWith('Z') ? 'zh' : 'en');
              updates.Language = nl;
              updates.Voice = pickVoice(nl) || f.Voice || '';
            }
          }
          else if (r < 92) {
            const curCode = (f.CallSign || '').substring(0, 3);
            if (isV3Level) {
              const tp = pickV3Tuple({
                usedCallsigns: usedCsOther,
                airlineFilter: curCode,
                langFilter: f.Language,
                excludeCallsign: f.CallSign,
              }) || pickV3Tuple({
                usedCallsigns: usedCsOther,
                airlineFilter: curCode,
                excludeCallsign: f.CallSign,
              });
              if (!tp) { lastReason = 'unavailable_v3_flightnum_tuple'; continue; }
              Object.assign(updates, {
                FlightNum: tp.FlightNum,
                Language: tp.Language,
                Voice: tp.Voice,
              });
            } else {
              const nums = SU.flightNums?.[curCode];
              if (Array.isArray(nums) && nums.length) updates.FlightNum = rpick(nums);
              else continue;
            }
          }
          else if (r < 97) {
            if (isV3Level) {
              const curCode = (f.CallSign || '').substring(0, 3);
              const otherAirlines = airlines.filter((a) => a !== curCode);
              const prefAirline = rpick(otherAirlines);
              const tp = (prefAirline && pickV3Tuple({
                usedCallsigns: usedCsOther,
                airlineFilter: prefAirline,
                excludeCallsign: f.CallSign,
              })) || pickV3Tuple({
                usedCallsigns: usedCsOther,
                excludeCallsign: f.CallSign,
              });
              if (!tp) { lastReason = 'unavailable_v3_airline_tuple'; continue; }
              Object.assign(updates, {
                AirlineCode: tp.AirlineCode,
                FlightNum: tp.FlightNum,
                Language: tp.Language,
                Voice: tp.Voice,
              });
              if (tp.AirlineCode !== curCode) {
                const avoid = await usedRegs();
                updates.Registration = regAvoiding(tp.AirlineCode, f.AircraftType || '', avoid[isArr ? 'arr' : 'dep']);
              }
            } else {
              // Legacy/v2: changing the airline also changes the callsign prefix.
              const code = rpick(airlines);
              const nums = SU.flightNums?.[code];
              if (Array.isArray(nums) && nums.length) {
                updates.AirlineCode = code;
                updates.FlightNum = rpick(nums);
              } else continue;
            }
          }
          else {
            const t = rint(startSec, maxFlightSec - 60);
            const t2 = Math.min(t + rint(60, 15 * 60), maxFlightSec);
            if (isArr) { updates.LandingTime = secToTime(t); updates.InBlockTime = secToTime(t2); }
            else { updates.OffBlockTime = secToTime(t); updates.TakeoffTime = secToTime(t2); }
          }
          if (!Object.keys(updates).length) continue;
          const r2 = await mcpCall('modify_flights', { match: { callsign: f.CallSign }, updates });
          if (r2.matched === 0) { lastReason = 'no-match'; continue; }
          fuzzLog.accepted.push(`modify_flights ${f.CallSign} ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(', ')}`);
          await countSync(flights.length, 'modify apply');
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(120); }
      }
      fuzzLog.rejected.push('modify_flights: ' + lastReason);
      return false;
    };

    const doTimelineOp = async (fuzzLog) => {
      const sub = rpick(['weather_add', 'weather_del', 'wind_add', 'wind_del', 'rwy_add', 'rwy_del']);

      // Read current timeline state + runway pairs (single round-trip).
      // All randomness below comes from the seeded test-process RNG so a
      // failure with a given FUZZ_SEED reproduces exactly.
      const counts = await window.evaluate(() => {
        const st = window.__AC27_STORE.getState();
        return {
          weather: (st.weatherTimeline || []).length,
          wind: (st.windTimeline || []).length,
          rwy: (st.runwayTimeline?.timeline || []).length,
          pairs: st._runwayPairs || [],
        };
      });

      const payload = {
        time: randTimelineTime(sub.startsWith('rwy')),
        preset: rpick(WEATHER_PRESETS),
        direction: rint(0, 36) * 10,
        speed: rint(1, 40),
      };
      if (sub === 'weather_del' && counts.weather === 0) { fuzzLog.rejected.push('timeline (weather_del): weather empty'); return false; }
      if (sub === 'wind_del' && counts.wind === 0) { fuzzLog.rejected.push('timeline (wind_del): wind empty'); return false; }
      if (sub === 'rwy_del' && counts.rwy === 0) { fuzzLog.rejected.push('timeline (rwy_del): runway timeline empty'); return false; }
      if (sub === 'rwy_add' && !counts.pairs.length) { fuzzLog.rejected.push('timeline (rwy_add): no runway pairs'); return false; }

      if (sub.endsWith('_del')) payload.idx = rint(0, (sub === 'weather_del' ? counts.weather : sub === 'wind_del' ? counts.wind : counts.rwy) - 1);
      if (sub === 'rwy_add') {
        payload.pair = rpick(counts.pairs);
        payload.shuffleInit = rand() < 0.3;
      }

      try {
        const res = await window.evaluate(({ sub, payload }) => {
          const toSec = (t) => {
            const p = String(t).split(':');
            return parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + (parseInt(p[2]) || 0);
          };
          const st = window.__AC27_STORE.getState();
          const tlm = { ...st.timelineModified };
          if (sub === 'weather_add') {
            const next = [...(st.weatherTimeline || []), { preset: payload.preset, time: payload.time }];
            next.sort((a, b) => toSec(a.time) - toSec(b.time));
            window.__AC27_STORE.setState({ weatherTimeline: next, timelineModified: { ...tlm, weather: true }, modified: true });
            return { ok: true, detail: `weather add ${payload.preset} @ ${payload.time}` };
          }
          if (sub === 'weather_del') {
            const next = (st.weatherTimeline || []).filter((_, i) => i !== payload.idx);
            window.__AC27_STORE.setState({ weatherTimeline: next, timelineModified: { ...tlm, weather: true }, modified: true });
            return { ok: true, detail: `weather remove #${payload.idx}` };
          }
          if (sub === 'wind_add') {
            const next = [...(st.windTimeline || []), { direction: payload.direction, speed: payload.speed, time: payload.time }];
            next.sort((a, b) => toSec(a.time) - toSec(b.time));
            window.__AC27_STORE.setState({ windTimeline: next, timelineModified: { ...tlm, wind: true }, modified: true });
            return { ok: true, detail: `wind add ${payload.direction}°/${payload.speed}kt @ ${payload.time}` };
          }
          if (sub === 'wind_del') {
            const next = (st.windTimeline || []).filter((_, i) => i !== payload.idx);
            window.__AC27_STORE.setState({ windTimeline: next, timelineModified: { ...tlm, wind: true }, modified: true });
            return { ok: true, detail: `wind remove #${payload.idx}` };
          }
          const rw = st.runwayTimeline || { initialRunways: [], timeline: [] };
          if (sub === 'rwy_add') {
            const pair = payload.pair;
            const tl = [...(rw.timeline || []), { time: payload.time, changes: [{ source: pair.source, dest: pair.dest }] }];
            tl.sort((a, b) => toSec(a.time) - toSec(b.time));
            const nextInit = payload.shuffleInit
              ? [...new Set((st._runwayPairs || []).map(p => p.source))].filter((_, i, arr) => i % 2 === 0)
              : rw.initialRunways;
            window.__AC27_STORE.setState({
              runwayTimeline: { initialRunways: nextInit, timeline: tl },
              timelineModified: { ...tlm, runway: true }, modified: true,
            });
            return { ok: true, detail: `runway change ${pair.source}→${pair.dest} @ ${payload.time}` };
          }
          if (sub === 'rwy_del') {
            window.__AC27_STORE.setState({
              runwayTimeline: { ...rw, timeline: (rw.timeline || []).filter((_, i) => i !== payload.idx) },
              timelineModified: { ...tlm, runway: true }, modified: true,
            });
            return { ok: true, detail: `runway change remove #${payload.idx}` };
          }
          return { ok: false, detail: 'unknown sub-op' };
        }, { sub, payload });
        if (res.ok) fuzzLog.accepted.push(res.detail);
        else fuzzLog.rejected.push('timeline (' + sub + '): ' + res.detail);
        await window.waitForTimeout(150);
        return res.ok;
      } catch (e) {
        fuzzLog.rejected.push('timeline (' + sub + '): ' + e.message);
        return false;
      }
    };

    const fuzzLog = { accepted: [], rejected: [] };
    let flightCount = (await getStatus()).flightCount;

    // Special gate: delete_all may ONLY be the first operation, and only with
    // 50% probability (decided up front, seed-deterministic). If it fires on a
    // small level (<6 flights) it degrades to a single delete_one.
    const wipeFirst = rand() < 0.5;
    log(`delete-all gate: ${wipeFirst ? 'wipe as op 1' : 'no wipe this run (50% chance)'}`);

    // Delete budget: delete_one is capped at 10% of the run's total ops (so
    // the fuzz mostly builds/edits), and a wipe leaves a budget of ZERO — no
    // further delete ops of any kind after a delete-all.  Minimum 1 so small
    // runs still exercise the delete path at least once.
    const deleteBudget = wipeFirst ? 0 : Math.max(1, Math.floor(nOps * 0.1));
    let deleteCount = 0;
    log(`delete budget: ${deleteBudget} of ${nOps} ops (10% cap${wipeFirst ? ' — none after wipe' : ''})`);

    for (let i = 0; i < nOps; i++) {
      // Always keep the level in a viable state: never fuzz with 0 flights.
      let op;
      if (i === 0 && wipeFirst) op = 'delete_all';
      else if (flightCount === 0) op = 'add_flight';
      else {
        const roll = rint(0, 99);
        op = roll < 30 ? 'add_flight'
          : roll < 48 ? 'delete_one'
          : roll < 74 ? 'modify_flight'
          : 'timeline_op';
        // Delete budget exhausted (or a wipe run — budget 0): re-pick from the
        // non-delete distribution (add 30 / modify 26 / timeline 26).
        if (op === 'delete_one' && deleteCount >= deleteBudget) {
          const r2 = rint(0, 81);
          op = r2 < 30 ? 'add_flight'
            : r2 < 56 ? 'modify_flight'
            : 'timeline_op';
        }
      }
      let done = false;
      if (op === 'add_flight') done = await doAddFlight(fuzzLog);
      else if (op === 'delete_one') done = await doDeleteOne(fuzzLog);
      else if (op === 'delete_all') {
        if (flightCount < 6) done = await doDeleteOne(fuzzLog);
        else done = await doDeleteAll(fuzzLog);
      }
      else if (op === 'modify_flight') done = await doModifyFlight(fuzzLog);
      else done = await doTimelineOp(fuzzLog);

      if (op === 'delete_all' && done && flightCount >= 6) flightCount = 0;
      else {
        try { flightCount = (await getStatus()).flightCount; } catch (_) {}
      }
      if ((op === 'delete_one' || op === 'delete_all') && done) deleteCount++;
      summary.accepted += done ? 1 : 0;
      summary.rejected += done ? 0 : 1;
      log(`op ${i + 1}/${nOps} ${op} → ${done ? '✔' : '✖'}`);
      await window.waitForTimeout(120);
    }
    summary.deletes = deleteCount;

    // A rejected MCP op that names a time bound = generator bug → hard fail.
    // (Store-level timeline rejections are the generator's own guards, prefixed
    // "timeline (" — they never carry server-side bounds messages.)
    for (const r of fuzzLog.rejected) {
      if (!r.startsWith('timeline (') && !/runway_not_in_timeline/.test(r) && /time|range|bounds|clock/.test(r)) {
        throw new Error('time-range rejection during fuzz: ' + r);
      }
    }

    // Aggregate rejection reasons for the report
    for (const r of fuzzLog.rejected) {
      const key = r.split(':')[0];
      summary.rejectedReasons[key] = (summary.rejectedReasons[key] || 0) + 1;
    }

    // ── 4. Ensure viable save state (≥2 flights), re-add if needed ──
    flightCount = (await getStatus()).flightCount;
    while (flightCount < 2) {
      if (!(await doAddFlight(fuzzLog))) {
        throw new Error('could not re-add flights for save (rejections: ' + fuzzLog.rejected.join('; ') + ')');
      }
      flightCount = (await getStatus()).flightCount;
    }
    log(`final flight count: ${flightCount}`);

    // ── 5. Validation gate using the APP's real validator (validators.js) ──
    // The UI blocks saves based on runTripleValidation() from src/utils/validators.js.
    // We run that exact function against the live store snapshot, then REPAIR
    // any issue (fuzz-induced or pre-existing in the original game file — e.g.
    // KDCA_leisure_2 has AAL2017 at 18:44:45 while config start is 18:45:00)
    // with targeted MCP modifications, because the fuzz level is a disposable
    // temp copy. If repairs can't converge, the fuzz fails (generator bug).
    const storeSnap = await window.evaluate(() => {
      const st = window.__AC27_STORE.getState();
      return {
        start: st._configStartTime, end: st._configEndTime,
        runwayTimeline: st.runwayTimeline || { timeline: [] },
      };
    });
    // Re-read the renderer state each repair round — repairs (especially
    // clearing `runwayTimeline`) must be visible to the next validation pass,
    // otherwise `runTriple` keeps seeing the initial snapshot and the runway
    // issues can never converge.
    const refreshStoreSnap = async () => {
      const s = await window.evaluate(() => {
        const st = window.__AC27_STORE.getState();
        return {
          start: st._configStartTime, end: st._configEndTime,
          runwayTimeline: st.runwayTimeline || { timeline: [] },
        };
      });
      storeSnap.start = s.start;
      storeSnap.end = s.end;
      storeSnap.runwayTimeline = s.runwayTimeline;
    };
    // Run the app's real validation against the SAME renderer values it uses.
    const runTriple = (flightRows) => validators.runTripleValidation(
      flightRows, { [icao]: SV }, icao,
      { byAirline: {}, allCallsigns: [], allAirlines: [] },
      null, storeSnap.start, storeSnap.end, storeSnap.runwayTimeline
    );

    const repairFixes = (flightRows, issues) => {
      // Parse the SAME localized messages runTripleValidation produced (both
      // come from the same imported module, so extraction is deterministic).
      const rowByCs = new Map(flightRows.map(f => [f.CallSign, f]));
      const reservedCallsigns = new Set(flightRows.map(f => f.CallSign).filter(Boolean));
      const repairedVoiceCs = new Set();
      const liveRegsByGroup = { arr: new Set(), dep: new Set() };
      for (const fr of flightRows) {
        const rg = (fr._Registration || fr.Registration || '').trim();
        if (rg) (isArrOf(fr) ? liveRegsByGroup.arr : liveRegsByGroup.dep).add(rg);
      }
      const isV3CallsignVoiceOrLangIssue = (m) => (
        m.includes('音频切片') ||
        m.includes('no audio clip') ||
        m.includes('voice_catalog.json') ||
        m.includes('与航班语言') ||
        m.includes('flight language is') ||
        m.includes('航司代码') ||
        m.toLowerCase().includes('airline code') ||
        m.includes('航班号') ||
        m.toLowerCase().includes('flight num') ||
        m.toLowerCase().includes('flight #') ||
        m.toLowerCase().includes('not valid for airline') ||
        ((m.includes('语音') || m.includes('语言') || /\b(Voice|Lang)\b/.test(m)) &&
          (m.includes('不在有效选项中') || m.includes('not in valid options') || m.includes('不能为空') || m.includes('is required')))
      );
      const fixes = [];
      const willClearTimeline = issues.some((m) => m.includes('跑道变更') || /runway.*change/i.test(m));
      let effectiveRt = willClearTimeline
        ? { ...(storeSnap.runwayTimeline || {}), timeline: [] }
        : storeSnap.runwayTimeline;
      let validForRepair = computeValidRunwaysForTimeline(effectiveRt);
      if (
        isV3Level &&
        validForRepair.enforced &&
        (validForRepair.depRunways.length === 0 || (flightRows.some(isArrOf) && validForRepair.arrRunways.length === 0))
      ) {
        const fallbackInitRwy = arrivalCapableRunways[0] || runways[0];
        if (fallbackInitRwy) {
          fixes.push({ timeline: 'ensureViableInitial', runway: fallbackInitRwy });
          effectiveRt = {
            ...(effectiveRt || {}),
            initialRunways: [...new Set([...(effectiveRt?.initialRunways || []), fallbackInitRwy])],
          };
          validForRepair = computeValidRunwaysForTimeline(effectiveRt);
        }
      }
      const activeArrivalRunwaysAt = (landingTimeStr) => {
        const lSec = timeToSec(landingTimeStr);
        if (isNaN(lSec) || !Array.isArray(effectiveRt?.initialRunways) || !effectiveRt.initialRunways.length) {
          return validForRepair.arrRunways;
        }
        const active = new Set(effectiveRt.initialRunways);
        const deact = new Map();
        const sortedTl = [...(effectiveRt.timeline || [])].sort((a, b) => timeToSec(a.time) - timeToSec(b.time));
        for (const entry of sortedTl) {
          const tSec = timeToSec(entry.time);
          if (isNaN(tSec) || tSec > lSec) break;
          for (const ch of (entry.changes || [])) {
            if (ch.source && active.has(ch.source)) {
              active.delete(ch.source);
              deact.set(ch.source, tSec);
              if (ch.dest) {
                active.add(ch.dest);
                deact.delete(ch.dest);
              }
            }
          }
        }
        const eligible = validForRepair.arrRunways.filter((r) => {
          if (active.has(r)) return true;
          const dAt = deact.get(r);
          return dAt != null && (lSec - dAt) <= 600;
        });
        if (eligible.length > 0) return eligible;
        if (!fixes.some((fx) => fx.timeline === 'runwayClear')) {
          fixes.push({ timeline: 'runwayClear' });
        }
        return validForRepair.arrRunways;
      };
      for (const msg of issues) {
        // Runway timeline issues have no callsign — they are like "跑道变更 #1: 切换 ..."
        // Fix by clearing the entire runway timeline (the fuzz often creates many
        // invalid entries like "19→01" when active is "01"; removing one-by-one
        // would need many rounds). Clearing is safe and matches the editor's
        // "validation clean" expectation.
        if (msg.includes('跑道变更') || /runway.*change/i.test(msg)) {
          // Only push one clear per round to avoid duplicate clears
          if (!fixes.some(f => f.timeline === 'runwayClear')) {
            fixes.push({ timeline: 'runwayClear' });
          }
          continue;
        }
        const pair = /^([A-Z0-9]{1,8})\s*(?:和|and)\s*([A-Z0-9]{1,8})/.exec(msg);
        const single = /^([A-Z0-9]{1,8}):/.exec(msg);
        const cs = (pair && rowByCs.get(pair[1]) ? pair[1] : null) ||
          (pair && rowByCs.get(pair[2]) ? pair[2] : null) ||
          (single && rowByCs.get(single[1]) ? single[1] : null);
        if (!cs) continue;
        const f = rowByCs.get(cs);
        if (isV3Level && isV3CallsignVoiceOrLangIssue(msg)) {
          if (repairedVoiceCs.has(cs)) continue;
          const curAl = cs.substring(0, 3);
          const curNum = cs.substring(3);
          const alOk = !airlineWhitelistSet.size || airlineWhitelistSet.has(curAl);
          const allowedNums = SU.flightNums?.[curAl];
          const numOk = !Array.isArray(allowedNums) || !allowedNums.length || allowedNums.includes(curNum);
          const vp = (alOk && numOk)
            ? (pickV3VoiceForCallsign(cs, { langFilter: f.Language }) || pickV3VoiceForCallsign(cs))
            : null;
          if (vp) {
            repairedVoiceCs.add(cs);
            fixes.push({ cs, updates: { Language: vp.Language, Voice: vp.Voice } });
          } else {
            const otherUsed = new Set(reservedCallsigns);
            otherUsed.delete(cs);
            const tp = (alOk && pickV3Tuple({ usedCallsigns: otherUsed, airlineFilter: curAl }))
              || pickV3Tuple({ usedCallsigns: otherUsed });
            if (tp) {
              reservedCallsigns.delete(cs);
              reservedCallsigns.add(tp.CallSign);
              repairedVoiceCs.add(cs);
              const u = {
                AirlineCode: tp.AirlineCode,
                FlightNum: tp.FlightNum,
                Language: tp.Language,
                Voice: tp.Voice,
              };
              if (tp.AirlineCode !== curAl) {
                const grp = isArrOf(f) ? 'arr' : 'dep';
                const newReg = regAvoiding(tp.AirlineCode, f.AircraftType || '', liveRegsByGroup[grp]);
                liveRegsByGroup[grp].add(newReg);
                u.Registration = newReg;
              }
              fixes.push({ cs, updates: u });
            }
          }
        } else if (msg.includes('航班号') || msg.toLowerCase().includes('flight num') || msg.toLowerCase().includes('flight #') || msg.toLowerCase().includes('not valid for airline')) {
          const code = cs.substring(0, 3);
          const nums = SU.flightNums?.[code];
          if (Array.isArray(nums) && nums.length) fixes.push({ cs, updates: { FlightNum: rpick(nums) } });
        } else if (msg.includes('应使用语言') || /must speak/i.test(msg)) {
          // Airline/language mismatch (CN → zh, every other carrier → en) — the
          // game fails to allocate the callsign on load. Set the required
          // Language and a matching Voice.
          const expected = airlineLanguage(cs.substring(0, 3));
          if (expected) fixes.push({ cs, updates: { Language: expected, Voice: pickVoice(expected) || f.Voice || '' } });
        } else if (msg.includes('与航班语言') || msg.includes('flight language is')) {
          const matchedVoice = pickVoice(f.Language);
          if (matchedVoice) fixes.push({ cs, updates: { Voice: matchedVoice } });
        } else if (msg.includes('机型') || msg.toLowerCase().includes('aircraft type')) {
          const tp = typePoolFor(cs.substring(0, 3));
          if (tp.length) fixes.push({ cs, updates: { AircraftType: rpick(tp) } });
        } else if (msg.includes('超出范围') || msg.toLowerCase().includes('range') || msg.toLowerCase().includes('out of')) {
          // Time fixes must also survive the server's stand-conflict validation
          // (moving a time can collide with occupation of the same stand), so
          // generate several candidate fixes: most time-only, a few that also
          // move the flight to a fresh stand.
          const group = isArrOf(f) ? 'arr' : 'dep';
          const variants = [];
          for (let k = 0; k < 7; k++) {
            const t = secToTime(rint(startSec, maxFlightSec - 60));
            const t2 = Math.min(timeToSec(t) + rint(60, 15 * 60), maxFlightSec);
            variants.push(group === 'arr'
              ? { LandingTime: t, InBlockTime: secToTime(t2) }
              : { OffBlockTime: t, TakeoffTime: secToTime(t2) });
          }
          for (let k = 0; k < 3; k++) {
            const t = secToTime(rint(startSec, maxFlightSec - 60));
            const t2 = Math.min(timeToSec(t) + rint(60, 15 * 60), maxFlightSec);
            variants.push({
              Stand: rpick(stands),
              ...(group === 'arr'
                ? { LandingTime: t, InBlockTime: secToTime(t2) }
                : { OffBlockTime: t, TakeoffTime: secToTime(t2) }),
            });
          }
          fixes.push({ cs, variants });
        } else if (msg.includes('进场程序') || msg.toLowerCase().includes('star')) {
          // Missing/incompatible STAR — repair must yield a valid
          // STAR/runway pair (move the runway when it has no STAR data,
          // otherwise the new arrival-no-STAR validator loops forever).
          const suFix = starUpdateFor(f.Runway, validForRepair.arrRunways) || { Airway: '' };
          fixes.push({ cs, updates: suFix });
        } else if (msg.includes('时段') || msg.toLowerCase().includes('conflict') || msg.toLowerCase().includes('overlapping')) {
          // Stand occupancy conflict — move one side to a different stand.
          const otherCs = pair && (rowByCs.get(pair[1]) === f ? pair[2] : pair[1]);
          const target = otherCs && rowByCs.get(otherCs) ? otherCs : cs;
          fixes.push({ cs: target, updates: { Stand: rpick(stands) } });
        } else if (msg.includes('停机位') || msg.toLowerCase().includes('stand')) {
          fixes.push({ cs, updates: { Stand: rpick(stands) } });
        } else if (msg.includes('跑道') || msg.toLowerCase().includes('runway') || msg.includes('进近航线') || msg.toLowerCase().includes('approach route')) {
          if (isArrOf(f)) {
            const activeArr = activeArrivalRunwaysAt(f.LandingTime);
            const nextRwy = rpick(activeArr.length ? activeArr : validForRepair.arrRunways);
            if (nextRwy) {
              fixes.push({
                cs,
                updates: {
                  Runway: nextRwy,
                  Airway: starFor(nextRwy, validForRepair.arrRunways) || f.Airway || '',
                },
              });
            }
          } else {
            const nextRwy = rpick(validForRepair.depRunways.length ? validForRepair.depRunways : runways);
            if (nextRwy) fixes.push({ cs, updates: { Runway: nextRwy } });
          }
        }
      }
      return fixes;
    };

    // Duplicate registrations are reported as a PAIR of callsigns — resolved
    // below with exclusion-aware picks.

    let finalIssues = [];
    let repaired = 0;
    for (let round = 0; round < 14; round++) {
      await refreshStoreSnap();
      const flightRows = (await getFlights()).flights;
      if (!flightRows.length) throw new Error('no flights left before save');
      const issues = runTriple(flightRows);
      if (!issues.length) { finalIssues = []; break; }
      finalIssues = issues;
      log(`save-gate round ${round + 1}: ${issues.length} issue(s) — first: ${issues[0]}`);
      const fixes = repairFixes(flightRows, issues);
      // Duplicate registrations need group-aware re-assignment.
      const dupRegs = issues.filter(m =>
        /^([A-Z0-9]{1,8})\s*(?:和|and)\s*([A-Z0-9]{1,8})/.test(m) &&
        (m.includes('注册号') || /reg\s*"[^"]+"\s*appears/i.test(m))
      );
      if (dupRegs.length) {
        const used = await usedRegs();
        for (const m of dupRegs) {
          const pair = /^([A-Z0-9]{1,8})\s*(?:和|and)\s*([A-Z0-9]{1,8})/.exec(m);
          const victim = pair && (flightRows.find(x => x.CallSign === pair[2]) || flightRows.find(x => x.CallSign === pair[1]));
          if (!victim) continue;
          const group = isArrOf(victim) ? 'arr' : 'dep';
          const reg = regAvoiding(victim.CallSign.substring(0, 3), victim.AircraftType || '', used[group]);
          log(`repair ${victim.CallSign} reg: ${(victim._Registration || victim.Registration || '')} → ${reg}`);
          fixes.push({ cs: victim.CallSign, updates: { Registration: reg } });
        }
      }
      if (!fixes.length) break;
      const ensureInitFixes = fixes.filter(f => f.timeline === 'ensureViableInitial');
      const timelineClearFixes = fixes.filter(f => f.timeline === 'runwayClear');
      const timelineFixes = fixes.filter(f => f.timeline === 'runway').sort((a, b) => b.idx - a.idx);
      const flightFixes = fixes.filter(f => !f.timeline);
      for (const fx of ensureInitFixes) {
        try {
          await window.evaluate((rwy) => {
            const st = window.__AC27_STORE.getState();
            const rw = st.runwayTimeline || { initialRunways: [], timeline: [] };
            const nextInit = [...new Set([...(rw.initialRunways || []), rwy])];
            window.__AC27_STORE.setState({ runwayTimeline: { ...rw, initialRunways: nextInit }, timelineModified: { ...st.timelineModified, runway: true }, modified: true });
            return true;
          }, fx.runway);
          log(`repair runway timeline ensure initial ${fx.runway}`);
          repaired++;
        } catch (e) { log(`repair runway timeline ensure initial: ${e.message}`); }
        await window.waitForTimeout(200);
      }
      for (const fx of timelineClearFixes) {
        try {
          await window.evaluate(() => {
            const st = window.__AC27_STORE.getState();
            const rw = st.runwayTimeline || { initialRunways: [], timeline: [] };
            window.__AC27_STORE.setState({ runwayTimeline: { ...rw, timeline: [] }, timelineModified: { ...st.timelineModified, runway: true }, modified: true });
            return true;
          });
          log(`repair runway timeline clear all`);
          repaired++;
        } catch (e) { log(`repair runway timeline clear: ${e.message}`); }
        await window.waitForTimeout(200);
      }
      for (const fx of timelineFixes) {
        try {
          await window.evaluate((idx) => {
            const st = window.__AC27_STORE.getState();
            const rw = st.runwayTimeline || { initialRunways: [], timeline: [] };
            const tl = [...(rw.timeline || [])];
            if (idx >= 0 && idx < tl.length) {
              tl.splice(idx, 1);
              window.__AC27_STORE.setState({ runwayTimeline: { ...rw, timeline: tl }, timelineModified: { ...st.timelineModified, runway: true }, modified: true });
            }
            return true;
          }, fx.idx);
          log(`repair runway timeline remove #${fx.idx}`);
          repaired++;
        } catch (e) { log(`repair runway timeline ${fx.idx}: ${e.message}`); }
        await window.waitForTimeout(200);
      }
      for (const fx of flightFixes) {
        const variants = fx.variants || [fx.updates];
        for (const u of variants) {
          try {
            await mcpCall('modify_flights', { match: { callsign: fx.cs }, updates: u });
            repaired++;
            break;
          } catch (e) { log(`repair ${fx.cs} alt: ${reasonOf(e)}`); }
          await window.waitForTimeout(200);
        }
      }
    }
    summary.repaired = repaired;
    if (finalIssues.length) {
      throw new Error('validation issues before save (repair could not converge): ' + finalIssues.slice(0, 5).join(' | '));
    }
    log('validation clean (app rules)');

    // Snapshot expected flights (post-save reload comparison)
    const expectedFlights = (await getFlights()).flights;
    const expected = {
      count: expectedFlights.length,
      callsigns: new Set(expectedFlights.map(f => f.CallSign)),
    };

    // ── 6. Hit SAVE through the real UI (with backup) ──
    const save = await saveViaUI(window);
    if (!save.saved) throw new Error('save did not run' + (save.blockedBy ? ' — blocked: ' + save.blockedBy : ''));

    // ── 7. Verify backup + reload ──
    const bakPath = currentPath + '.bak';
    await waitFor(() => fs.existsSync(bakPath), { timeout: 10000, interval: 300, label: '.acl.bak creation' });
    summary.backupCreated = true;
    log('backup created:', bakPath);

    const reloaded = parser.loadFlights(currentPath);
    const reloadedCallsigns = new Set(reloaded.flights.map(f => f.CallSign));
    summary.reloadedCount = reloaded.flights.length;

    const countOk = reloaded.flights.length === expected.count;
    const setOk = reloadedCallsigns.size === expected.callsigns.size &&
      [...expected.callsigns].every(cs => reloadedCallsigns.has(cs));
    log(`reload: ${reloaded.flights.length} flights (expected ${expected.count}) callsigns ${setOk ? 'match' : 'MISMATCH'}`);
    if (!countOk || !setOk) {
      throw new Error(`post-save reload mismatch: store=${expected.count} vs file=${reloaded.flights.length}, callsigns ${setOk ? 'ok' : 'mismatch'}`);
    }

    // Game-compat invariants on the SAVED output (same model as
    // tests/integration/save_gamecompat.test.js). The reload checks above
    // cannot catch files the GAME would crash on (duplicate flight-plan
    // keys, missing docked aircraft entities, stand-allocation conflicts) —
    // a stale build without the save-time normalization passes them and
    // still produces broken levels. Assert the saved file is game-clean.
    const destAudioRoot = process.env.E2E_GAME_ROOT || TMP_DIR;
    const gcA = analyzeAclFile(currentPath, {
      gameRoot: destAudioRoot,
      airportIcao: icao,
      requireV3Audio: isV3Level,
    });
    const gc = runChecks(gcA, {
      voiceLanguages,
      airlineCountries,
      languages,
      gameRoot: destAudioRoot,
      airportIcao: icao,
      requireV3Audio: isV3Level,
    });
    // Filter out the one game-compat code the save pipeline does not yet
    // guarantee: docked-stand-before-offblock (arrival lands before a docked
    // departure's off-block) is correctly detected but not auto-repaired by
    // _normalizeFlightsForGameCompat. `resolution-missing-leg` used to be
    // filtered too — it is now enforced: the save pipeline reconciles the
    // checkpoint frame (orphan runtime-entity removal + stale $fstrref nulling)
    // and encodeV2Archive persists those frame edits (they were previously
    // discarded, re-copying the original v2 frame bytes verbatim).
    const filteredIssues = gc.issues.filter(i => !['docked-stand-before-offblock'].includes(i.code));
    if (filteredIssues.length) {
      // Keep the offending file + diagnostic detail for offline RCA
      // (teardown removes the temp root, so persist the artifact here).
      _persistGcFailArtifact(currentPath, {
        base,
        seed: summary.seed,
        filteredIssues,
        allIssues: gc.issues,
        gcA,
      });
      throw new Error(`saved file has game-compat issues: ${filteredIssues.map(i => `[${i.code}] ${i.msg}`).join(' | ')}`);
    }
    // A valid archive can still place parked aircraft far from their stands if
    // its profile lookup falls back to wheelbases in the wrong units.
    const savedHandle = openAclFile(currentPath);
    const parkingStands = savedHandle.readStandPositions();
    const departures = new Map(reloaded.flights.filter(f => f.isDeparture).map(f => [f._Registration || f.Registration, f]));
    let checkedParking = 0;
    if (savedHandle.format === 'gatcarc4-v3') {
      const schema = getSchemaForHash(savedHandle.container.header.schemaHash);
      for (const frame of savedHandle.container.frames || []) {
        if (!frame?.runtimeData) continue;
        const rtIdx = indexDocumentGraph(frame.runtimeData, schema.roots.runtime, schema);
        const reDict = resolveGraphNode(frame.runtimeData.RuntimeEntities, rtIdx);
        if (!reDict) continue;
        for (const [k, rawV] of dictEntries(reDict)) {
          if (!k.startsWith('aircraft:')) continue;
          const reg = k.slice('aircraft:'.length);
          const flight = departures.get(reg);
          if (!flight) continue;
          const acObj = resolveGraphNode(rawV, rtIdx);
          if (!acObj) continue;
          const stVal = unwrapReactive(acObj._state, rtIdx);
          if (stVal !== 10) continue;
          const stand = parkingStands[flight.Stand] || parkingStands[String(parseInt(flight.Stand, 10))];
          if (!stand) throw new Error(`parked aircraft ${reg}: stand ${flight.Stand} not found`);
          const posTuple = unwrapReactive(acObj._position, rtIdx);
          if (!Array.isArray(posTuple) || posTuple.length < 3) throw new Error(`parked aircraft ${reg}: position not found`);
          const posGu = decodePosition3ToGu(posTuple);
          const offset = Math.hypot(posGu.x - stand.noseX, posGu.z - stand.noseZ);
          if (offset > 2) throw new Error(`parked aircraft ${reg}: ${offset.toFixed(3)} units from stand ${flight.Stand} nose`);
          checkedParking++;
        }
      }
    } else {
      const savedText = savedHandle.rawText;
      const { FRAME_SENTINEL } = require('../../src/acl/gatcarc');
      const { createTokenizer } = require('../../src/acl/tokenizer');
      for (const doc of savedText.split(FRAME_SENTINEL).slice(1)) {
        const tokenizer = createTokenizer(doc);
        for (const match of doc.matchAll(/"\$k"\s*:\s*"(jetway|aircraft):([^"\\]+)"/g)) {
          const start = doc.lastIndexOf('{', match.index);
          const block = doc.slice(start, tokenizer.findObjectEnd(start));
          const reg = (block.match(/flight-plan:([^"\\]+)/) || [])[1] || (match[1] === 'aircraft' ? match[2] : null);
          const flight = departures.get(reg) || (match[1] === 'jetway'
            ? [...departures.values()].find(f => String(parseInt(f.Stand, 10)) === String(parseInt(match[2], 10)))
            : null);
          if (!flight) continue;
          const bt = createTokenizer(block);
          const state = bt.findSection('_state'), pos = bt.findSection('_position');
          if (!state || !pos || !/,\s*10\s*}/.test(block.slice(state.valueStart, state.valueEnd))) continue;
          const stand = parkingStands[flight.Stand] || parkingStands[String(parseInt(flight.Stand, 10))];
          if (!stand) throw new Error(`parked aircraft ${reg}: stand ${flight.Stand} not found`);
          const position = block.slice(pos.valueStart, pos.valueEnd);
          const vector = position.match(/"\$type"\s*:\s*(?:\d+|"[^"]+"),\s*(-?[\d.eE+]+),\s*(-?[\d.eE+]+),\s*(-?[\d.eE+]+)/);
          if (!vector) throw new Error(`parked aircraft ${reg}: position not found`);
          const offset = Math.hypot(Number(vector[1]) - stand.noseX, Number(vector[3]) - stand.noseZ);
          if (offset > 2) throw new Error(`parked aircraft ${reg}: ${offset.toFixed(3)} units from stand ${flight.Stand} nose`);
          checkedParking++;
        }
      }
    }
    log(`parking offsets checked: ${checkedParking}`);
    log('game-compat clean (saved output verified against game invariants)');

    log(`DONE — ${fuzzLog.accepted.length} accepted / ${fuzzLog.rejected.length} rejected ops`);
    log(`  accepted: ${fuzzLog.accepted.slice(0, 6).join('; ')}${fuzzLog.accepted.length > 6 ? '; …' : ''}`);
    log(`  rejected: ${fuzzLog.rejected.slice(0, 6).join('; ') || '(none)'}`);
    if (fuzzLog.rejected.length) log(`  rejected reasons: ${JSON.stringify(fuzzLog.rejected)}`);
    return { ...summary, ok: true };
  } catch (err) {
    summary.error = err.message;
    log('FAIL:', err.message);
    return { ...summary, ok: false };
  }
}

// ── Spec: iterate target levels ─────────────────────────────────────
// Gated on FUZZ_RUN=1 — the fuzz storm is slow (13 files × up to 50 ops)
// and must not slow down `npm run test:e2e` / `npm run test:all`.
const FUZZ_RUN = !!process.env.FUZZ_RUN;

let electronApp;
let window;

test.beforeAll(async () => {
  if (!FUZZ_RUN) return;
  const port = await freePort();
  API_BASE = `http://127.0.0.1:${port}/mcp`;
  electronApp = await electron.launch({
    args: [
      path.join(__dirname, '..', '..', 'dist-electron', 'main.js'),
      `--user-data-dir=${process.env.E2E_USERDATA_DIR}`,
    ],
    env: { ...process.env, AC27_E2E_TMP_DIR: process.env.E2E_TMP_DIR, AC27_API_PORT: String(port) },
    timeout: 60000,
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(2000);

  // The API server is required for the MCP fuzz ops — verify it is reachable.
  await waitFor(async () => {
    try {
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
      });
      return res.ok;
    } catch (_) { return false; }
  }, { timeout: 15000, interval: 500, label: 'editor API server on ' + API_BASE });
});

test.afterAll(async () => {
  if (!FUZZ_RUN) return;
  if (electronApp) await electronApp.close().catch(() => {});
});

function resolveTargetFiles() {
  const raw = process.env.FUZZ_ACL_FILES;
  const entries = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_PROD_FILES;
  return entries.map((e) => {
    if (fs.existsSync(e)) return { path: e, base: path.basename(e, '.acl') };
    const baseName = path.basename(e); // accept "ZSJN_leisure_1.acl" or "ZSJN/ZSJN_leisure_1.acl"
    // Resolve against the temp game root via gamePaths
    const root = gamePaths.airportsDir(TMP_DIR);
    const found = [];
    for (const icao of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const dir = gamePaths.levelsDir(TMP_DIR, icao);
      if (!fs.existsSync(dir)) continue;
      const full = path.join(dir, baseName);
      if (fs.existsSync(full)) found.push(full);
    }
    if (found.length === 0) throw new Error(`target file not found in temp root: ${baseName}`);
    if (found.length > 1) throw new Error(`ambiguous target: ${baseName} matches ${found.join(', ')}`);
    return { path: found[0], base: path.basename(found[0], '.acl') };
  });
}

test.setTimeout(3600000); // 60 min: 13 files × up to 200 ops + build/launch

test('Fuzz save — randomized edit storm on production levels', async () => {
  test.skip(!FUZZ_RUN, 'Skipped — set FUZZ_RUN=1 to run the fuzz save test');
  const rows = window.locator('.level-row');
  await rows.first().waitFor({ state: 'visible', timeout: 90000 }).catch(() => {});
  // Expand auto-collapsed airport cards so the row count covers all airports
  // (a collapsed card renders no rows; FuzzTest re-expands per level anyway).
  const collapsedHeaders = window.locator('.airport-card[data-expanded="false"] .airport-card-header');
  while ((await collapsedHeaders.count()) > 0) {
    await collapsedHeaders.first().click();
    await window.waitForTimeout(200);
  }
  const totalRows = await rows.count();
  console.log(`\nFound ${totalRows} level rows in browser`);
  expect(totalRows).toBeGreaterThanOrEqual(1);

  const seedBase = process.env.FUZZ_SEED ? parseInt(process.env.FUZZ_SEED, 10) : Date.now();
  const files = resolveTargetFiles();
  console.log(`\nFuzz targets (${files.length}): ${files.map(f => f.base).join(', ')}`);
  console.log(`Fuzz seed base: ${seedBase}  (set FUZZ_SEED to reproduce)`);

  const results = [];
  let passed = 0, failed = 0;

  for (let i = 0; i < files.length; i++) {
    const { path: aclPath, base } = files[i];
    console.log(`\n[${i + 1}/${files.length}] ${base}`);
    const r = await FuzzTest(aclPath, { window, seed: seedBase });
    results.push(r);
    if (r.ok && !r.error) {
      passed++;
      console.log(`  ✓ PASSED (${r.accepted} accepted ops, backup=${r.backupCreated})`);
      if (FUZZ_REPLACE) {
        try { copyToRealGame(aclPath, { seed: r.seed }); }
        catch (e) { failed++; console.error(`  ✗ replace copy FAILED: ${e.message}`); }
      }
    }
    else { failed++; console.log(`  ✗ FAILED: ${r.error}`); }
    await goBackToBrowser(window);
    await window.waitForTimeout(1000);
  }

  // ── Report ────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Fuzz Save — All Levels`);
  console.log(`  Total: ${results.length}  Passed: ${passed}  Failed: ${failed}`);
  results.forEach(r => {
    const icon = r.ok && !r.error ? '✓' : '✗';
    console.log(`  ${icon} ${r.file} (seed ${r.seed}, ${r.accepted}✓/${r.rejected}✖ ops, deletes=${r.deletes ?? 0}, backup=${r.backupCreated}, reload=${r.reloadedCount}${r.repaired ? `, repaired=${r.repaired}` : ''})`);
    if (r.rejectedReasons && Object.keys(r.rejectedReasons).length) {
      console.log(`      rejected reasons: ${JSON.stringify(r.rejectedReasons)}`);
    }
  });
  console.log(`${'═'.repeat(60)}\n`);

  expect(failed).toBe(0);
});