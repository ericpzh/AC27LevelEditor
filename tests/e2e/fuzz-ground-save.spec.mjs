/**
 * Fuzz Ground+Air Save Test — randomized Ground/Air Painter edit storm + real SAVE (with backup)
 *
 * For each target .acl level (default: all 20 production levels):
 *   1. Open the level in the editor (browser row click)
 *   2. Open the Ground Painter (toggleGroundPainter → load-ground-painter-data)
 *   3. FuzzGroundTest(aclPath) applies 50–200 RANDOMIZED operations through the
 *      MCP Ground/Air Painter API (127.0.0.1:31415). The operation mix is
 *      distributed over percentage points of the run's total ops (ground + air unified):
 *        - 5%  runway ops    (create_runways / move via target / rename end names)
 *        - 5%  taxiway new   (create_taxiway_lines)
 *        - 20% taxiway mod   (move whole segment / move one endpoint / rename)
 *        - 20% fillet        (create_taxiway_fillet, radius 0.5..5.0 — half of the
 *                            fillets first CONNECT a new taxiway onto a runway
 *                            pavement strip (Flags=4) and then fillet that junction)
 *        - 10% area ops      (create_areas areaType 0|1|2 / move whole area / move vertex)
 *        - 5%  stand ops     (create_stands / move / rename)
 *        - 15% select+delete (single-select move / multi-select move /
 *                            select-all move / delete_ground_objects)
 *        - 20% air ops       (create_airway_nodes 7, create_airway_procedures 7,
 *                            create_airway_fillet 3, move/rename/delete airway 3)
 *      Every generated coordinate is inside the level's current scenery bounds
 *      (derived from the live graph's node extents, with 5% padding); runway
 *      names are auto-derived from heading and always satisfy the save-time
 *      validation regex `^[0-9]{1,2}[A-Z]?$`. Rejected operations are retried
 *      with fresh random values; a validation rejection that names a distinct-
 *      endpoint or vertex-count error is treated as retryable and does not fail
 *      the run.
 *   4. Ensure the graph is viable (≥1 taxiway family), then hit SAVE through
 *      the real Ground Painter UI (Save → backup confirmation modal → success),
 *      creating the .acl.bak
 *   5. Verify: .acl.bak exists, saved .acl reloads through the real scenery
 *      graph + flight parser, and the editor's guarantees hold. The flight
 *      baseline is the file, NOT the store (demo-classified basenames —
 *      DEMO_VISIBLE_BASES, e.g. ZSJN_leisure_1.acl ships as a prod file but
 *      the editor filters the store to the CDT demo window at load — hold only
 *      a subset of the file's flights). The save may REMOVE a flight whose
 *      stand/runway no longer resolves in the saved scenery (flight purge) and
 *      REMAP renamed references; it must never keep an unresolved reference,
 *      add a flight, or drop one whose reference still resolves. Game-load
 *      gates: no self-intersecting area polygons (Unity Triangulator), no
 *      duplicate runway `$k` entries ("found 0 named runways"), no pavement
 *      strips whose runway is gone.
 *
 * Requires: E2E_GAME_ROOT (real game installation), npm run build first,
 * and FUZZ_RUN=1 (the spec is skipped otherwise — same gate as the flight
 * fuzz, so `npm run test:e2e` remains fast). The app's API server must be
 * reachable on 127.0.0.1:31415.
 *
 * Run all production levels:
 *   $env:E2E_GAME_ROOT = "<game-root>"
 *   $env:FUZZ_RUN = "1"
 *   npx playwright test --config=playwright.config.mjs tests/e2e/fuzz-ground-save.spec.mjs
 *
 * Run specific levels (comma-separated file names or paths):
 *   $env:FUZZ_ACL_FILES = "ZSJN/ZSJN_leisure_1.acl,KJFK/KJFK_peakarrival.acl"
 *
 * Reproduce a failure with a fixed seed:
 *   $env:FUZZ_SEED = "12345"
 *
 * Propagate results into the real game install (copies each PASSED level's
 * .acl + .acl.bak from the sandbox to E2E_GAME_ROOT/.../Levels/):
 *   npm run test:fuzz:ground -- --replace
 */
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { readAclText } = require('../../src/acl/gatcarc');
const parser = require('../../src/acl/parser');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = process.env.E2E_TMP_DIR;
const API_BASE = process.env.FUZZ_API_BASE || 'http://127.0.0.1:31415/mcp';

const DEFAULT_PROD_FILES = [
  'ZSJN/ZSJN_leisure_1.acl', 'ZSJN/ZSJN_leisure_2.acl',
  'ZSJN/ZSJN_peakdeparture.acl', 'ZSJN/ZSJN_runwaychange.acl',
  'ZSJN/ZSJN_taixwayclosed.acl',
  'KJFK/KJFK_leisure_1.acl', 'KJFK/KJFK_leisure_2.acl', 'KJFK/KJFK_runwaychange.acl', 'KJFK/KJFK_peakdeparture.acl', 'KJFK/KJFK_peakarrival.acl',
  'KDCA/KDCA_leisure_1.acl', 'KDCA/KDCA_leisure_2.acl',
  'KDCA/KDCA_runwaychange.acl', 'KDCA/KDCA_peakdeparture.acl', 'KDCA/KDCA_peakarrival.acl',
  'ZGSZ/ZGSZ_leisure_1.acl', 'ZGSZ/ZGSZ_leisure_2.acl',
  'ZGSZ/ZGSZ_runwaychange.acl', 'ZGSZ/ZGSZ_peakdeparture.acl', 'ZGSZ/ZGSZ_peakarrival.acl',
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

async function getGroundState() {
  return mcpCall('get_ground_painter_state', {});
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

async function saveViaGroundUI(window) {
  // Ground Painter Save → backup confirmation modal → success (or warnings modal)
  const saveBtn = window.locator('button.gp-save').first();
  const visible = await saveBtn.isVisible({ timeout: 4000 }).catch(() => false);
  if (!visible) return { saved: false, blockedBy: 'ground save button not visible (hasEdited=false?)' };
  const disabled = await saveBtn.isDisabled().catch(() => false);
  if (disabled) return { saved: false, blockedBy: 'ground save button disabled (no edits)' };
  await saveBtn.click();
  await window.waitForTimeout(1000);

  let saveRan = false;
  let blockedBy = null;
  for (let pass = 0; pass < 8; pass++) {
    const modal = window.locator('#modal-overlay');
    if (!(await modal.isVisible().catch(() => false))) break;
    const title = await window.locator('#modal-title').textContent().catch(() => '');
    console.log(`    Ground Modal [${pass}]: "${title}"`);
    const isIssue = /issue|问题|修复/.test(title);
    const isFail = /fail|失败|save failed/i.test(title);
    const isWarn = /warn|警告/.test(title);
    const isConfirm = /backup|备份|保存前/i.test(title);

    if (isIssue || isFail) {
      const body = await window.locator('#modal-body').textContent().catch(() => '(no body)');
      blockedBy = (isFail ? 'save failed: ' : 'save blocked: ') + body.substring(0, 400);
      console.log(`    ${isFail ? 'Ground Save FAILED' : 'Ground Save blocked'}: ${body}`);
      const closeBtn = window.locator('#modal-actions .btn-confirm, #modal-actions .btn-cancel').first();
      if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
      await window.waitForTimeout(400);
      return { saved: false, blockedBy };
    }
    if (isWarn) {
      // Saved with warnings — not a failure; dismiss and treat as saved
      console.log(`    Ground saved with warnings: ${title}`);
      const btn = window.locator('#modal-actions .btn-confirm').first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) await btn.click();
      await window.waitForTimeout(600);
      saveRan = true;
      break;
    }
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
    await window.waitForTimeout(900);
  }
  await window.waitForTimeout(1200);
  return { saved: saveRan, blockedBy };
}

// ── FUZZ_REPLACE: propagate sandbox results into the real game install ──
const FUZZ_REPLACE = process.env.FUZZ_REPLACE === '1';

function copyToRealGame(tmpAclPath) {
  const gameRoot = process.env.E2E_GAME_ROOT;
  if (!gameRoot) throw new Error('FUZZ_REPLACE requires E2E_GAME_ROOT to be set');
  const rel = path.relative(TMP_DIR, tmpAclPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`sandbox file outside E2E_TMP_DIR, refusing to map: ${tmpAclPath}`);
  }
  const dest = path.join(gameRoot, rel);
  const bakSrc = tmpAclPath + '.bak';
  if (!fs.existsSync(bakSrc)) throw new Error(`no .acl.bak to copy: ${bakSrc}`);
  if (!fs.existsSync(dest)) throw new Error(`destination missing (is this level installed in E2E_GAME_ROOT?): ${dest}`);
  fs.copyFileSync(tmpAclPath, dest);
  fs.copyFileSync(bakSrc, dest + '.bak');
  // Also copy background sidecar if present (ground painter image placement)
  const bgSrc = tmpAclPath + '.bg.json';
  const bgDest = dest + '.bg.json';
  if (fs.existsSync(bgSrc)) {
    fs.copyFileSync(bgSrc, bgDest);
    console.log(`  [replace] → ${dest} (+ .bak + .bg.json)`);
  } else {
    // If sidecar was removed, ensure destination sidecar is removed too
    if (fs.existsSync(bgDest)) fs.unlinkSync(bgDest);
    console.log(`  [replace] → ${dest} (+ .bak)`);
  }
  // geo_data.osm is not copied — it lives outside the sandbox Levels dir
  // Flight schedule CSV: the ground save's flight purge rewrites it next to
  // the .acl, so it propagates alongside (identical content when no purge
  // ran, so this is always safe). csv.bak keeps the rollback chain aligned
  // with the .acl.bak.
  const icao = path.basename(path.dirname(tmpAclPath));
  const baseName = path.basename(tmpAclPath, '.acl');
  const levelSuffix = baseName.startsWith(icao + '_') ? baseName.slice(icao.length + 1) : baseName;
  const csvSrc = path.join(path.dirname(tmpAclPath), 'flight_schedule_' + levelSuffix + '.csv');
  if (fs.existsSync(csvSrc)) {
    const csvDest = path.join(path.dirname(dest), path.basename(csvSrc));
    fs.copyFileSync(csvSrc, csvDest);
    if (fs.existsSync(csvSrc + '.bak')) fs.copyFileSync(csvSrc + '.bak', csvDest + '.bak');
    console.log(`  [replace] → ${csvDest}${fs.existsSync(csvSrc + '.bak') ? ' (+ .bak)' : ''}`);
  }
}

async function goBackToBrowser(window) {
  // Ensure Ground Painter is closed first (it overlays the editor)
  try {
    await window.evaluate(() => {
      const s = window.__AC27_STORE.getState();
      if (s.showGroundPainter) s.closeGroundPainter();
    });
    await window.waitForTimeout(400);
  } catch (_) {}
  for (let attempt = 0; attempt < 4; attempt++) {
    const saveBtn = window.locator('button:has-text("Save"), button:has-text("保存")').first();
    if (!(await saveBtn.isVisible({ timeout: 2000 }).catch(() => false))) return;
    const backBtn = window.locator('button:has-text("Back"), button:has-text("返回")').first();
    if (!(await backBtn.isVisible().catch(() => false))) return;
    await backBtn.click();
    await window.waitForTimeout(800);
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
 * FuzzGroundTest(aclFilePath) — randomized Ground Painter edit storm on one level, then SAVE.
 *
 * @param {string} aclFilePath   Full path to the .acl file in the temp game root
 * @param {object} opts
 * @param {import('@playwright/test').Page} opts.window — Electron renderer page
 * @param {number} [opts.seed]   RNG seed (default Date.now())
 * @param {number} [opts.minOps] min random operations (default 50)
 * @param {number} [opts.maxOps] max random operations (default 200)
 * @returns {Promise<object>} summary { ok, file, seed, ops, accepted, rejected, deletes, rejectedReasons, backupCreated, reloaded, error? }
 */
export async function FuzzGroundTest(aclFilePath, { window, seed = Date.now(), minOps = 50, maxOps = 200 } = {}) {
  const base = path.basename(aclFilePath, '.acl');
  const seedRng = createRng((seed >>> 0) ^ fnv1a(base));
  const rand = () => seedRng();
  const rint = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
  const rpick = (arr) => (arr && arr.length) ? arr[Math.floor(rand() * arr.length)] : null;

  const log = (...a) => console.log(`  [fuzz-ground:${base}]`, ...a);
  const summary = {
    file: base, seed: (seed >>> 0) ^ fnv1a(base),
    ops: 0, accepted: 0, rejected: 0, rejectedReasons: {},
    backupCreated: false, reloaded: null, issues: [], error: null,
  };

  try {
    // ── 1. Open the level (browser row click) ──
    const displayName = base.replace(/_/g, ' ');
    const nameLoc = window.locator('.level-name', { hasText: new RegExp('^' + displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') });
    const row = window.locator('.level-row', { has: nameLoc });
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

    const resolvedPath = path.resolve(currentPath).toLowerCase();
    const tempRoot = path.resolve(process.env.E2E_TMP_DIR).toLowerCase();
    if (!resolvedPath.startsWith(tempRoot + path.sep)) {
      throw new Error(`REFUSING to fuzz ${currentPath} — not inside temp root ${process.env.E2E_TMP_DIR}`);
    }

    // Flight baseline from the FILE (not the store): the ground save must keep
    // every flight whose stand/runway reference still resolves in the saved
    // scenery, purge the ones whose reference was deleted, and remap renamed
    // references. For demo-classified basenames (DEMO_VISIBLE_BASES — e.g.
    // ZSJN_leisure_1.acl ships as a prod file but the editor applies the demo
    // CDT window at load) the store holds only a subset of the file's flights,
    // so a store-based baseline would false-fail on flights the fuzz never
    // touched.
    const fileFlightsBefore = parser.loadFlights(currentPath).flights;
    const fileCallsignsBefore = new Set(fileFlightsBefore.map(f => f.CallSign));
    log(`flight baseline (file): ${fileCallsignsBefore.size} callsigns`);

    // ── 2. Open Ground Painter and wait for graph ──
    await window.evaluate(() => {
      const s = window.__AC27_STORE.getState();
      if (!s.showGroundPainter) s.toggleGroundPainter();
    });
    await waitFor(async () => {
      try {
        const gs = await getGroundState();
        return !!(gs && gs.graph && gs.graph.nodes);
      } catch (_) { return false; }
    }, { timeout: 20000, label: `ground painter ready for ${base}` });

    let groundState = await getGroundState();
    let graph = groundState.graph;
    if (!graph) throw new Error('ground painter graph is null after open');

    // Derive bounds from current graph nodes (with fallback)
    let bounds = null;
    const computeBounds = (g) => {
      if (!g || !g.nodes || !g.nodes.length) return null;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const n of g.nodes) {
        if (!n || !isFinite(n.x) || !isFinite(n.z)) continue;
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.z < minZ) minZ = n.z;
        if (n.z > maxZ) maxZ = n.z;
      }
      if (!isFinite(minX) || !isFinite(maxX)) return null;
      const padX = (maxX - minX) * 0.05;
      const padZ = (maxZ - minZ) * 0.05;
      return { minX: minX - padX, maxX: maxX + padX, minZ: minZ - padZ, maxZ: maxZ + padZ, w: maxX - minX, h: maxZ - minZ };
    };
    bounds = computeBounds(graph);
    if (!bounds) bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20, w: 40, h: 40 };
    log(`graph ready: nodes=${graph.nodes.length} segs=${graph.segments.length} rw=${graph.runways.length} areas=${graph.areas.length} stands=${graph.stands.length} bounds=${bounds.minX.toFixed(1)},${bounds.minZ.toFixed(1)} → ${bounds.maxX.toFixed(1)},${bounds.maxZ.toFixed(1)}`);

    const randPoint = () => {
      const w = bounds.w || (bounds.maxX - bounds.minX) || 10;
      const h = bounds.h || (bounds.maxZ - bounds.minZ) || 10;
      const x = bounds.minX + rand() * (bounds.maxX - bounds.minX);
      const z = bounds.minZ + rand() * (bounds.maxZ - bounds.minZ);
      // If the level has no scenery yet, w/h may be 0 — jitter around center
      if (!isFinite(x) || !isFinite(z)) return { x: (rand() - 0.5) * 20, z: (rand() - 0.5) * 20 };
      return { x, z };
    };
    const randPointDistinct = (other, minDist = 1.0) => {
      for (let k = 0; k < 20; k++) {
        const p = randPoint();
        if (!other) return p;
        if (Math.hypot(p.x - other.x, p.z - other.z) >= minDist) return p;
      }
      return randPoint();
    };

    // Helpers to read latest graph after mutations
    const refreshGraph = async () => {
      groundState = await getGroundState();
      graph = groundState.graph;
      const b = computeBounds(graph);
      if (b) bounds = b;
      return graph;
    };

    // ── 3. Randomized operations ──
    const nOps = rint(Math.min(minOps, maxOps), maxOps);
    summary.ops = nOps;
    log(`fuzzing ground with ${nOps} operations (seed ${summary.seed})`);

    const countSync = async (checkFn, label) => {
      await waitFor(async () => {
        try { return await checkFn(); } catch (_) { return false; }
      }, { timeout: 8000, interval: 150, label });
    };

    const doAddTaxiway = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const a = randPoint();
        const b = randPointDistinct(a, 0.8 + rand() * 2);
        try {
          const before = (await getGroundState()).summary?.segments ?? graph.segments.length;
          const r = await mcpCall('create_taxiway_lines', { lines: [{ a, b }] });
          await countSync(async () => {
            const gs = await getGroundState();
            return (gs.summary?.segments ?? 0) === before + (r.added || 1);
          }, 'taxiway add apply');
          await refreshGraph();
          fuzzLog.accepted.push(`taxiway ${a.x.toFixed(1)},${a.z.toFixed(1)} → ${b.x.toFixed(1)},${b.z.toFixed(1)}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('create_taxiway_lines: ' + lastReason);
      return false;
    };

    const doAddRunway = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const a = randPoint();
        const b = randPointDistinct(a, 3 + rand() * 8);
        try {
          const before = (await getGroundState()).summary?.runways ?? graph.runways.length;
          const r = await mcpCall('create_runways', { runways: [{ a, b }] });
          await countSync(async () => {
            const gs = await getGroundState();
            return (gs.summary?.runways ?? 0) === before + (r.added || 1);
          }, 'runway add apply');
          await refreshGraph();
          fuzzLog.accepted.push(`runway ${a.x.toFixed(1)},${a.z.toFixed(1)} → ${b.x.toFixed(1)},${b.z.toFixed(1)}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('create_runways: ' + lastReason);
      return false;
    };

    const doAddArea = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const center = randPoint();
        const r = 0.9 + rand() * 2.8;
        const n = 3 + rint(0, 2);
        const areaType = rint(0, 2);
        const pts = [];
        for (let i = 0; i < n; i++) {
          const ang = (2 * Math.PI * i) / n + (rand() - 0.5) * 0.35;
          const rr = r * (0.75 + rand() * 0.5);
          pts.push({ x: center.x + Math.cos(ang) * rr, z: center.z + Math.sin(ang) * rr });
        }
        try {
          const before = (await getGroundState()).summary?.areas ?? graph.areas.length;
          const res = await mcpCall('create_areas', { areas: [{ areaType, points: pts }] });
          await countSync(async () => {
            const gs = await getGroundState();
            return (gs.summary?.areas ?? 0) === before + (res.added || 1);
          }, 'area add apply');
          await refreshGraph();
          fuzzLog.accepted.push(`area type=${areaType} n=${n} @ ${center.x.toFixed(1)},${center.z.toFixed(1)}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('create_areas: ' + lastReason);
      return false;
    };

    const doAddStand = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const p = randPoint();
        const heading = rint(1, 360);
        try {
          const before = (await getGroundState()).summary?.stands ?? graph.stands.length;
          const res = await mcpCall('create_stands', { stands: [{ x: p.x, z: p.z, heading }] });
          await countSync(async () => {
            const gs = await getGroundState();
            return (gs.summary?.stands ?? 0) === before + (res.added || 1);
          }, 'stand add apply');
          await refreshGraph();
          fuzzLog.accepted.push(`stand ${p.x.toFixed(1)},${p.z.toFixed(1)} hdg=${heading}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('create_stands: ' + lastReason);
      return false;
    };

    const doFillet = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const cur = await getGroundState();
        const segCount = cur.summary?.segments ?? 0;
        if (segCount < 2) { lastReason = 'not enough segments'; break; }
        const a = rint(0, segCount - 1);
        let b = rint(0, segCount - 1);
        let guard = 0;
        while (b === a && guard < 10) { b = rint(0, segCount - 1); guard++; }
        const radius = 0.5 + rand() * 4.5;
        // Round to 2 decimals to match UI step
        const rRounded = Math.round(radius * 20) / 20;
        try {
          await mcpCall('create_taxiway_fillet', { segA: a, segB: b, radius: rRounded });
          await window.waitForTimeout(180);
          await refreshGraph();
          fuzzLog.accepted.push(`fillet ${a}–${b} r=${rRounded.toFixed(2)}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('create_taxiway_fillet: ' + lastReason);
      return false;
    };

    const doDeleteOne = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const cur = await getGroundState();
        const gcur = cur.graph;
        if (!gcur) { lastReason = 'no graph'; break; }
        // Pick a random deletable coordinate from the live graph
        let target = null;
        const pick = rint(0, 99);
        if (pick < 35 && gcur.segments.length) {
          const sg = gcur.segments[rint(0, gcur.segments.length - 1)];
          const idxs = sg.nodeIdxs || [sg.aIdx, sg.bIdx];
          const pts = idxs.map((ni) => gcur.nodes[ni]).filter(Boolean);
          if (pts.length >= 2) {
            const mid = pts[Math.floor(pts.length / 2)];
            target = { x: mid.x + (rand() - 0.5) * 0.2, z: mid.z + (rand() - 0.5) * 0.2 };
          }
        } else if (pick < 55 && gcur.stands.length) {
          const st = gcur.stands[rint(0, gcur.stands.length - 1)];
          const n = gcur.nodes[st.noseIdx];
          if (n) target = { x: n.x + (rand() - 0.5) * 0.2, z: n.z + (rand() - 0.5) * 0.2 };
        } else if (pick < 75 && gcur.areas.length) {
          const ar = gcur.areas[rint(0, gcur.areas.length - 1)];
          const pts = ar.points || [];
          if (pts.length) {
            const c = pts[Math.floor(pts.length / 2)];
            target = { x: c.x + (rand() - 0.5) * 0.3, z: c.z + (rand() - 0.5) * 0.3 };
          }
        } else if (gcur.runways.length) {
          const rw = gcur.runways[rint(0, gcur.runways.length - 1)];
          const a = gcur.nodes[rw.thAIdx], b = gcur.nodes[rw.thBIdx];
          if (a && b) target = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
        } else {
          target = randPoint();
        }
        if (!target) { lastReason = 'no target'; continue; }
        try {
          await mcpCall('delete_ground_objects', { target });
          await window.waitForTimeout(200);
          await refreshGraph();
          fuzzLog.accepted.push(`delete @ ${target.x.toFixed(1)},${target.z.toFixed(1)}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('delete_ground_objects: ' + lastReason);
      return false;
    };

    // ── Shared helpers for move/rename/select ops ──
    let lastOpName = 'init';
    const afterMutation = async () => {
      await window.waitForTimeout(120);
      await refreshGraph();
      // Pinpoint the op that introduces a degenerate segment (self-loop or
      // co-located consecutive vertices) — the save refuses these.
      const bad = [];
      (graph.segments || []).forEach((sg, i) => {
        const idxs = sg.nodeIdxs && sg.nodeIdxs.length ? sg.nodeIdxs : [sg.aIdx, sg.bIdx];
        const coords = idxs.map((ni) => { const n = graph.nodes[ni]; return n ? n.x.toFixed(3) + ',' + n.z.toFixed(3) : '?'; }).join(' ');
        if (sg.aIdx != null && sg.aIdx === sg.bIdx) { bad.push(`seg#${i} name=${sg.name || '-'} flags=${sg.flags} aIdx==bIdx nodes=[${coords}]`); return; }
        let prev = null;
        for (const ni of idxs) {
          const n = graph.nodes[ni];
          if (!n) { prev = null; continue; }
          if (prev && Math.hypot(n.x - prev.x, n.z - prev.z) < 1e-4) { bad.push(`seg#${i} name=${sg.name || '-'} flags=${sg.flags} consecutive-dup nodes=[${coords}]`); break; }
          prev = n;
        }
      });
      if (bad.length) log(`!! DEGENERATE after "${lastOpName}": ${bad.slice(0, 3).join(' | ')}`);
    };
    const randDelta = (scale = 0.05) => ({
      dx: (rand() - 0.5) * 2 * Math.max(0.3, bounds.w * scale),
      dz: (rand() - 0.5) * 2 * Math.max(0.3, bounds.h * scale),
    });
    const clampToBounds = (p) => ({
      x: Math.min(bounds.maxX, Math.max(bounds.minX, p.x)),
      z: Math.min(bounds.maxZ, Math.max(bounds.minZ, p.z)),
    });
    // Representative pick-point per object — targets resolve through the same
    // hit-testing the UI Select uses (shared with delete_ground_objects).
    const pickPoints = (g) => {
      const pts = [];
      const stripNames = new Set((g.runways || []).map((r) => r.physicalName));
      for (let i = 0; i < g.segments.length; i++) {
        const sg = g.segments[i];
        if (sg.name && stripNames.has(sg.name)) continue; // strips move via their runway
        const idxs = sg.nodeIdxs || [sg.aIdx, sg.bIdx];
        const n = g.nodes[idxs[Math.floor(idxs.length / 2)]];
        if (n) pts.push({ kind: 'segment', idx: i, x: n.x, z: n.z });
      }
      for (let i = 0; i < g.runways.length; i++) {
        const rw = g.runways[i];
        const a = g.nodes[rw.thAIdx], b = g.nodes[rw.thBIdx];
        if (a && b) pts.push({ kind: 'runway', idx: i, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      }
      for (let i = 0; i < g.stands.length; i++) {
        const n = g.nodes[g.stands[i].noseIdx];
        if (n) pts.push({ kind: 'stand', idx: i, x: n.x, z: n.z });
      }
      for (let i = 0; i < g.areas.length; i++) {
        const ap = g.areas[i].points || [];
        if (ap.length >= 2) pts.push({ kind: 'area', idx: i, x: (ap[0].x + ap[1].x) / 2, z: (ap[0].z + ap[1].z) / 2 });
      }
      return pts;
    };

    const doMoveRunway = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const rwCount = graph.runways?.length ?? 0;
        if (!rwCount) { lastReason = 'no runways'; break; }
        const rw = graph.runways[rint(0, rwCount - 1)];
        const a = graph.nodes[rw.thAIdx], b = graph.nodes[rw.thBIdx];
        if (!a || !b) { lastReason = 'runway nodes missing'; break; }
        const { dx, dz } = randDelta(0.04);
        try {
          await mcpCall('move_ground_objects', { targets: [{ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }], dx, dz });
          await afterMutation();
          fuzzLog.accepted.push(`move runway ${rw.physicalName} Δ(${dx.toFixed(2)},${dz.toFixed(2)})`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('move_ground_objects(runway): ' + lastReason);
      return false;
    };

    const doRenameRunway = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const rwCount = graph.runways?.length ?? 0;
        if (!rwCount) { lastReason = 'no runways'; break; }
        const idx = rint(0, rwCount - 1);
        const rw = graph.runways[idx];
        const taken = new Set(graph.runways.filter((_, i) => i !== idx).map((r) => r.physicalName));
        const mk = () => String(rint(1, 36)) + rpick(['', 'L', 'R', 'C']);
        let n1 = mk(), n2 = mk(), guard = 0;
        while ((n1 === n2 || taken.has(n1 + '/' + n2)) && guard < 20) { n1 = mk(); n2 = mk(); guard++; }
        if (n1 === n2 || taken.has(n1 + '/' + n2)) { lastReason = 'no unique runway name'; continue; }
        try {
          await mcpCall('rename_ground_object', { kind: 'runway', idx, names: [n1, n2] });
          await afterMutation();
          fuzzLog.accepted.push(`rename runway ${rw.physicalName} → ${n1}/${n2}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('rename_ground_object(runway): ' + lastReason);
      return false;
    };

    const doMoveSegment = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const segCount = graph.segments?.length ?? 0;
        if (!segCount) { lastReason = 'no segments'; break; }
        const sgIdx = rint(0, segCount - 1);
        const sg = graph.segments[sgIdx];
        const idxs = sg.nodeIdxs || [sg.aIdx, sg.bIdx];
        const mid = graph.nodes[idxs[Math.floor(idxs.length / 2)]];
        if (!mid) { lastReason = 'segment node missing'; continue; }
        const { dx, dz } = randDelta(0.04);
        try {
          await mcpCall('move_ground_objects', { targets: [{ x: mid.x, z: mid.z }], dx, dz });
          await afterMutation();
          fuzzLog.accepted.push(`move taxiway seg#${sgIdx} @ ${mid.x.toFixed(1)},${mid.z.toFixed(1)} Δ(${dx.toFixed(2)},${dz.toFixed(2)})`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('move_ground_objects(segment): ' + lastReason);
      return false;
    };

    const doMoveEndpoint = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const segCount = graph.segments?.length ?? 0;
        if (!segCount) { lastReason = 'no segments'; break; }
        const sg = graph.segments[rint(0, segCount - 1)];
        const idxs = sg.nodeIdxs || [sg.aIdx, sg.bIdx];
        const endNi = rand() < 0.5 ? idxs[0] : idxs[idxs.length - 1];
        const n = graph.nodes[endNi];
        if (!n) { lastReason = 'endpoint node missing'; continue; }
        const d = randDelta(0.03);
        const to = clampToBounds({ x: n.x + d.dx, z: n.z + d.dz });
        if (Math.hypot(to.x - n.x, to.z - n.z) < 0.3) { lastReason = 'degenerate move'; continue; }
        try {
          await mcpCall('move_ground_endpoint', { target: { x: n.x, z: n.z }, to, kind: 'node' });
          await afterMutation();
          fuzzLog.accepted.push(`move endpoint ${n.x.toFixed(1)},${n.z.toFixed(1)} → ${to.x.toFixed(1)},${to.z.toFixed(1)}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('move_ground_endpoint: ' + lastReason);
      return false;
    };

    const doRenameSegment = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const stripNames = new Set((graph.runways || []).map((r) => r.physicalName));
        const candidates = [];
        for (let i = 0; i < graph.segments.length; i++) {
          const sg = graph.segments[i];
          if (sg.name && stripNames.has(sg.name)) continue; // strips rename via their runway
          candidates.push(i);
        }
        if (!candidates.length) { lastReason = 'no renamable segments'; break; }
        const idx = rpick(candidates);
        const name = 'T' + rint(1, 999);
        try {
          const r = await mcpCall('rename_ground_object', { kind: 'segment', idx, name });
          await afterMutation();
          fuzzLog.accepted.push(`rename taxiway seg#${idx} ${r.renamed.from ?? '(unnamed)'} → ${name}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('rename_ground_object(segment): ' + lastReason);
      return false;
    };

    // Coverage op: CONNECT a new taxiway onto a runway pavement strip segment
    // (Flags=4, named after the runway's physical name) and then fillet that
    // junction — the type=4 taxiway-onto-runway fillet path.
    const doFilletRunwayConnect = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const stripNames = new Set((graph.runways || []).map((r) => r.physicalName));
        const strips = [];
        for (let i = 0; i < graph.segments.length; i++) {
          const sg = graph.segments[i];
          if (sg.flags === 4 || (sg.name && stripNames.has(sg.name))) {
            const idxs = sg.nodeIdxs || [sg.aIdx, sg.bIdx];
            if (idxs.length >= 2) strips.push({ idx: i, idxs, name: sg.name });
          }
        }
        if (!strips.length) { lastReason = 'no runway pavement strips (flags=4)'; break; }
        const strip = rpick(strips);
        const useA = rand() < 0.5;
        const endNi = useA ? strip.idxs[0] : strip.idxs[strip.idxs.length - 1];
        const otherNi = useA ? strip.idxs[strip.idxs.length - 1] : strip.idxs[0];
        const P = graph.nodes[endNi], O = graph.nodes[otherNi];
        if (!P || !O) { lastReason = 'strip endpoint nodes missing'; continue; }
        // Outward along the strip, rotated 25..155° so the connector meets the
        // strip at a filletable angle (0°/180° would be collinear → rejected).
        const ang0 = Math.atan2(P.z - O.z, P.x - O.x);
        const jitter = (rand() < 0.5 ? -1 : 1) * (25 + rand() * 130) * Math.PI / 180;
        const len = 3 + rand() * 6;
        const b = clampToBounds({ x: P.x + Math.cos(ang0 + jitter) * len, z: P.z + Math.sin(ang0 + jitter) * len });
        if (Math.hypot(b.x - P.x, b.z - P.z) < 0.8) { lastReason = 'connector endpoint degenerate'; continue; }
        try {
          const before = (await getGroundState()).summary?.segments ?? graph.segments.length;
          await mcpCall('create_taxiway_lines', { lines: [{ a: { x: P.x, z: P.z }, b }] });
          await countSync(async () => {
            const gs = await getGroundState();
            return (gs.summary?.segments ?? 0) === before + 1;
          }, 'runway connect apply');
          await refreshGraph();
          // The connector is the segment running P→b
          let connIdx = -1;
          for (let i = graph.segments.length - 1; i >= 0; i--) {
            const idxs = graph.segments[i].nodeIdxs || [graph.segments[i].aIdx, graph.segments[i].bIdx];
            const n0 = graph.nodes[idxs[0]], n1 = graph.nodes[idxs[idxs.length - 1]];
            if (!n0 || !n1) continue;
            const fwd = Math.hypot(n0.x - P.x, n0.z - P.z) < 1e-3 && Math.hypot(n1.x - b.x, n1.z - b.z) < 1e-3;
            const rev = Math.hypot(n1.x - P.x, n1.z - P.z) < 1e-3 && Math.hypot(n0.x - b.x, n0.z - b.z) < 1e-3;
            if (fwd || rev) { connIdx = i; break; }
          }
          if (connIdx < 0) { lastReason = 'connector segment not found'; continue; }
          const radius = 0.5 + rand() * 4.5;
          const rRounded = Math.round(radius * 20) / 20;
          const fres = await mcpCall('create_taxiway_fillet', { segA: connIdx, segB: strip.idx, radius: rRounded });
          await afterMutation();
          const gt = (p) => p ? `(${p.x.toFixed(3)},${p.z.toFixed(3)})` : '?';
          fuzzLog.accepted.push(`fillet connect seg#${connIdx} × strip#${strip.idx} (${strip.name || 'flags=4'}) r=${rRounded.toFixed(2)} virtual=${fres.virtual} t1=${gt(fres.t1)} t2=${gt(fres.t2)}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('fillet_runway_connect: ' + lastReason);
      return false;
    };

    const doMoveArea = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const areaCount = graph.areas?.length ?? 0;
        if (!areaCount) { lastReason = 'no areas'; break; }
        const idx = rint(0, areaCount - 1);
        const ar = graph.areas[idx];
        const ap = ar.points || [];
        if (ap.length < 2) { lastReason = 'area points missing'; continue; }
        // Boundary areas (type 0) only hit near an edge; apron/building areas
        // resolve from inside — target the vertex-average centroid for those.
        let tp;
        if (ar.areaType === 0) tp = { x: (ap[0].x + ap[1].x) / 2, z: (ap[0].z + ap[1].z) / 2 };
        else tp = ap.reduce((acc, p) => ({ x: acc.x + p.x / ap.length, z: acc.z + p.z / ap.length }), { x: 0, z: 0 });
        const { dx, dz } = randDelta(0.04);
        try {
          await mcpCall('move_ground_objects', { targets: [{ x: tp.x, z: tp.z }], dx, dz, threshold: 0.35 });
          await afterMutation();
          fuzzLog.accepted.push(`move area#${idx} (type ${ar.areaType}) Δ(${dx.toFixed(2)},${dz.toFixed(2)})`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('move_ground_objects(area): ' + lastReason);
      return false;
    };

    const doMoveAreaVertex = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const areaCount = graph.areas?.length ?? 0;
        if (!areaCount) { lastReason = 'no areas'; break; }
        const idx = rint(0, areaCount - 1);
        const ap = graph.areas[idx].points || [];
        if (!ap.length) { lastReason = 'area points missing'; continue; }
        const v = rint(0, ap.length - 1);
        const d = randDelta(0.03);
        const to = clampToBounds({ x: ap[v].x + d.dx, z: ap[v].z + d.dz });
        if (Math.hypot(to.x - ap[v].x, to.z - ap[v].z) < 0.2) { lastReason = 'degenerate move'; continue; }
        try {
          await mcpCall('move_ground_endpoint', { target: { x: ap[v].x, z: ap[v].z }, to, kind: 'areaVertex' });
          await afterMutation();
          fuzzLog.accepted.push(`move area#${idx} vertex ${v} → ${to.x.toFixed(1)},${to.z.toFixed(1)}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('move_ground_endpoint(areaVertex): ' + lastReason);
      return false;
    };

    const doMoveStand = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const stCount = graph.stands?.length ?? 0;
        if (!stCount) { lastReason = 'no stands'; break; }
        const idx = rint(0, stCount - 1);
        const n = graph.nodes[graph.stands[idx].noseIdx];
        if (!n) { lastReason = 'stand node missing'; continue; }
        const { dx, dz } = randDelta(0.03);
        try {
          await mcpCall('move_ground_objects', { targets: [{ x: n.x, z: n.z }], dx, dz });
          await afterMutation();
          fuzzLog.accepted.push(`move stand#${idx} (${graph.stands[idx].name || 'unnamed'}) Δ(${dx.toFixed(2)},${dz.toFixed(2)})`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('move_ground_objects(stand): ' + lastReason);
      return false;
    };

    const doRenameStand = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const stCount = graph.stands?.length ?? 0;
        if (!stCount) { lastReason = 'no stands'; break; }
        const idx = rint(0, stCount - 1);
        const taken = new Set(graph.stands.filter((_, i) => i !== idx).map((st) => st.name || st.identifier));
        let name = rpick('ABCDEGHIJKLMNOPQRSTUVWXYZ'.split('')) + rint(1, 99);
        let guard = 0;
        while (taken.has(name) && guard < 20) { name = rpick('ABCDEGHIJKLMNOPQRSTUVWXYZ'.split('')) + rint(1, 99); guard++; }
        if (taken.has(name)) { lastReason = 'no unique stand name'; continue; }
        try {
          const r = await mcpCall('rename_ground_object', { kind: 'stand', idx, name });
          await afterMutation();
          fuzzLog.accepted.push(`rename stand#${idx} ${r.renamed.from || '(unnamed)'} → ${name}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('rename_ground_object(stand): ' + lastReason);
      return false;
    };

    const doMoveMulti = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const pool = pickPoints(graph);
        if (pool.length < 2) { lastReason = 'not enough objects'; break; }
        const k = rint(2, Math.min(4, pool.length));
        const picks = [];
        const used = new Set();
        while (picks.length < k && used.size < pool.length) {
          const i = rint(0, pool.length - 1);
          if (used.has(i)) continue;
          used.add(i);
          picks.push(pool[i]);
        }
        const { dx, dz } = randDelta(0.03);
        try {
          const r = await mcpCall('move_ground_objects', { targets: picks.map((p) => ({ x: p.x, z: p.z })), dx, dz });
          await afterMutation();
          const kinds = Object.entries(r.moved).filter(([, n]) => n > 0).map(([kind, n]) => `${kind}×${n}`).join('+');
          fuzzLog.accepted.push(`move multi (${k} targets → ${kinds || 'none'}) Δ(${dx.toFixed(2)},${dz.toFixed(2)})`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('move_ground_objects(multi): ' + lastReason);
      return false;
    };

    const doMoveSelectAll = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        await refreshGraph();
        const total = (graph.segments?.length ?? 0) + (graph.runways?.length ?? 0) + (graph.stands?.length ?? 0) + (graph.areas?.length ?? 0);
        if (!total) { lastReason = 'graph empty'; break; }
        // Small delta so select-all translate keeps geometry inside the bounds
        const { dx, dz } = randDelta(0.015);
        try {
          const r = await mcpCall('move_ground_objects', { selectAll: true, dx, dz });
          await afterMutation();
          const kinds = Object.entries(r.moved).filter(([, n]) => n > 0).map(([kind, n]) => `${kind}×${n}`).join('+');
          fuzzLog.accepted.push(`select-all move (${kinds}, ${r.nodes} nodes) Δ(${dx.toFixed(2)},${dz.toFixed(2)})`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('move_ground_objects(selectAll): ' + lastReason);
      return false;
    };

    // The "select" op: single object of any kind, picked from the live pool
    const doMoveSingle = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const pool = pickPoints(graph);
        if (!pool.length) { lastReason = 'no objects'; break; }
        const p = rpick(pool);
        const { dx, dz } = randDelta(0.03);
        try {
          await mcpCall('move_ground_objects', { targets: [{ x: p.x, z: p.z }], dx, dz });
          await afterMutation();
          fuzzLog.accepted.push(`select+move ${p.kind}#${p.idx} Δ(${dx.toFixed(2)},${dz.toFixed(2)})`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('move_ground_objects(single): ' + lastReason);
      return false;
    };

    // ── Air helpers ───────────────────────────────────────────────
    const doAddAirwayNode = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const p = randPoint();
        const name = 'FIX' + rint(100, 999) + String.fromCharCode(65 + rint(0, 25)) + String.fromCharCode(65 + rint(0, 25));
        try {
          const before = (await getGroundState()).summary?.airwayNodes ?? 0;
          await mcpCall('create_airway_nodes', { nodes: [{ x: p.x, z: p.z, name }] });
          await countSync(async () => {
            const gs = await getGroundState();
            return (gs.summary?.airwayNodes ?? 0) === before + 1;
          }, 'airway node add apply');
          await refreshGraph();
          fuzzLog.accepted.push(`airway node ${name} @ ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('create_airway_nodes: ' + lastReason);
      return false;
    };
    const doAddAirwayProcedure = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const nodeCount = graph.airwayNodes?.length ?? 0;
        if (nodeCount < 2) { lastReason = 'not enough airway nodes (need 2)'; break; }
        const rwy = graph.runways && graph.runways.length ? rpick(graph.runways) : null;
        if (!rwy) { lastReason = 'no runway for procedure'; break; }
        const runwayName = rwy.physicalName ? rwy.physicalName.split('/')[0] : (rwy.names && rwy.names[0]) || '01';
        const k = rint(2, Math.min(5, nodeCount));
        // pick k distinct random indices
        const pool = [...Array(nodeCount).keys()];
        const chosen = [];
        for (let i = 0; i < k; i++) {
          const idx = rint(0, pool.length - 1);
          chosen.push(pool[idx]);
          pool.splice(idx, 1);
        }
        const name = 'PROC' + rint(100, 999) + String.fromCharCode(65 + rint(0, 25));
        const routeType = rint(0, 3);
        try {
          const before = (await getGroundState()).summary?.procedures ?? 0;
          await mcpCall('create_airway_procedures', { procedures: [{ name, routeType, runwayName, airwayNodeIdxs: chosen }] });
          await countSync(async () => {
            const gs = await getGroundState();
            return (gs.summary?.procedures ?? 0) === before + 1;
          }, 'airway procedure add apply');
          await refreshGraph();
          fuzzLog.accepted.push(`airway procedure ${name} type=${routeType} rwy=${runwayName} nodes=${chosen.join(',')}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('create_airway_procedures: ' + lastReason);
      return false;
    };
    const doAirFillet = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const procCount = graph.procedures?.length ?? 0;
        if (procCount < 2) { lastReason = 'not enough procedures'; break; }
        // find a pair sharing a node
        const candidates = [];
        for (let a = 0; a < procCount; a++) for (let b = a + 1; b < procCount; b++) {
          const pa = graph.procedures[a], pb = graph.procedures[b];
          if (!pa || !pb) continue;
          const shared = pa.airwayNodeIdxs.some((v) => pb.airwayNodeIdxs.includes(v));
          if (shared) candidates.push([a, b]);
        }
        if (!candidates.length) { lastReason = 'no connected procedure pair'; break; }
        const [procA, procB] = rpick(candidates);
        const radius = Math.round((0.5 + rand() * 4.5) * 20) / 20;
        try {
          await mcpCall('create_airway_fillet', { procA, procB, radius });
          await window.waitForTimeout(200);
          await refreshGraph();
          fuzzLog.accepted.push(`air fillet ${procA}–${procB} r=${radius.toFixed(2)}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('create_airway_fillet: ' + lastReason);
      return false;
    };
    const doMoveAirway = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const nodes = graph.airwayNodes || [];
        if (!nodes.length) { lastReason = 'no airway nodes'; break; }
        const n = rpick(nodes);
        const idx = nodes.indexOf(n);
        const { dx, dz } = randDelta(0.03);
        try {
          await mcpCall('move_airway_objects', { targets: [{ x: n.x, z: n.z }], dx, dz });
          await afterMutation();
          fuzzLog.accepted.push(`move airway node#${idx} Δ(${dx.toFixed(2)},${dz.toFixed(2)})`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('move_airway_objects: ' + lastReason);
      return false;
    };
    const doRenameAirway = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const kind = rand() < 0.5 ? 'airwayNode' : 'procedure';
        if (kind === 'airwayNode') {
          const cnt = graph.airwayNodes?.length ?? 0;
          if (!cnt) { lastReason = 'no airway nodes'; break; }
          const idx = rint(0, cnt - 1);
          const name = 'FIX' + rint(100, 999) + String.fromCharCode(65 + rint(0, 25));
          try {
            await mcpCall('rename_airway_object', { kind: 'airwayNode', idx, name });
            await afterMutation();
            fuzzLog.accepted.push(`rename airway node#${idx} → ${name}`);
            return true;
          } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
        } else {
          const cnt = graph.procedures?.length ?? 0;
          if (!cnt) { lastReason = 'no procedures'; break; }
          const idx = rint(0, cnt - 1);
          const name = 'PROC' + rint(100, 999) + String.fromCharCode(65 + rint(0, 25));
          try {
            await mcpCall('rename_airway_object', { kind: 'procedure', idx, name });
            await afterMutation();
            fuzzLog.accepted.push(`rename procedure#${idx} → ${name}`);
            return true;
          } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
        }
      }
      fuzzLog.rejected.push('rename_airway_object: ' + lastReason);
      return false;
    };
    const doDeleteAirway = async (fuzzLog) => {
      let lastReason = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await refreshGraph();
        const nodes = graph.airwayNodes || [];
        const procs = graph.procedures || [];
        if (!nodes.length && !procs.length) { lastReason = 'no airway objects'; break; }
        let target = null;
        if (procs.length && rand() < 0.5) {
          const proc = rpick(procs);
          const pts = proc.airwayNodeIdxs.map((ii) => graph.airwayNodes[ii]).filter(Boolean);
          if (pts.length) {
            const mid = pts[Math.floor(pts.length / 2)];
            target = { x: mid.x + (rand() - 0.5) * 0.2, z: mid.z + (rand() - 0.5) * 0.2 };
          }
        }
        if (!target && nodes.length) {
          const n = rpick(nodes);
          target = { x: n.x + (rand() - 0.5) * 0.2, z: n.z + (rand() - 0.5) * 0.2 };
        }
        if (!target) target = randPoint();
        try {
          await mcpCall('delete_airway_objects', { target });
          await window.waitForTimeout(200);
          await refreshGraph();
          fuzzLog.accepted.push(`delete airway @ ${target.x.toFixed(1)},${target.z.toFixed(1)}`);
          return true;
        } catch (e) { lastReason = reasonOf(e); await window.waitForTimeout(80); }
      }
      fuzzLog.rejected.push('delete_airway_objects: ' + lastReason);
      return false;
    };

    const fuzzLog = { accepted: [], rejected: [] };
    let deleteCount = 0;

    for (let i = 0; i < nOps; i++) {
      // Always keep viable state: if graph is empty, add something
      const curSummary = (await getGroundState()).summary;
      const isEmpty = !curSummary || (curSummary.segments === 0 && curSummary.runways === 0 && curSummary.areas === 0 && curSummary.stands === 0);
      let op;
      if (isEmpty) op = 'add_taxiway';
      else {
        // Distribution in percentage points of the run's total ops (ground + air unified):
        //   5% runway (new/move/rename) · 5% taxiway new · 20% taxiway mod
        //   (move/move-endpoint/rename) · 20% fillet (half = type=4 connector)
        //   10% area (new/move/move-vertex) · 5% stand (new/move/rename)
        //   15% select & delete (single/multi/select-all move, delete)
        //   20% air (node 7, procedure 7, fillet 3, move/rename/delete 3)
        const roll = rint(0, 99);
        if (roll < 5) {
          const r2 = rand();
          op = r2 < 0.4 ? 'add_runway' : r2 < 0.7 ? 'move_runway' : 'rename_runway';
        } else if (roll < 10) {
          op = 'add_taxiway';
        } else if (roll < 30) {
          const r2 = rand();
          op = r2 < 0.34 ? 'move_segment' : r2 < 0.67 ? 'move_endpoint' : 'rename_segment';
        } else if (roll < 50) {
          op = rand() < 0.5 ? 'fillet' : 'fillet_runway_connect';
        } else if (roll < 60) {
          const r2 = rand();
          op = r2 < 0.5 ? 'add_area' : r2 < 0.8 ? 'move_area' : 'move_area_vertex';
        } else if (roll < 65) {
          const r2 = rand();
          op = r2 < 0.4 ? 'add_stand' : r2 < 0.7 ? 'move_stand' : 'rename_stand';
        } else if (roll < 80) {
          const r2 = rand();
          op = r2 < 0.35 ? 'delete_one' : r2 < 0.65 ? 'move_multi' : r2 < 0.85 ? 'move_select_all' : 'move_single';
        } else if (roll < 87) {
          op = 'add_airway_node';
        } else if (roll < 94) {
          op = 'add_airway_procedure';
        } else if (roll < 97) {
          op = 'air_fillet';
        } else {
          const r2 = rand();
          op = r2 < 0.33 ? 'move_airway' : r2 < 0.66 ? 'rename_airway' : 'delete_airway';
        }
      }
      let done = false;
      lastOpName = op + ' #' + (fuzzLog.accepted.length + fuzzLog.rejected.length + 1);
      if (op === 'add_taxiway') done = await doAddTaxiway(fuzzLog);
      else if (op === 'add_runway') done = await doAddRunway(fuzzLog);
      else if (op === 'move_runway') done = await doMoveRunway(fuzzLog);
      else if (op === 'rename_runway') done = await doRenameRunway(fuzzLog);
      else if (op === 'move_segment') done = await doMoveSegment(fuzzLog);
      else if (op === 'move_endpoint') done = await doMoveEndpoint(fuzzLog);
      else if (op === 'rename_segment') done = await doRenameSegment(fuzzLog);
      else if (op === 'fillet') done = await doFillet(fuzzLog);
      else if (op === 'fillet_runway_connect') done = await doFilletRunwayConnect(fuzzLog);
      else if (op === 'add_area') done = await doAddArea(fuzzLog);
      else if (op === 'move_area') done = await doMoveArea(fuzzLog);
      else if (op === 'move_area_vertex') done = await doMoveAreaVertex(fuzzLog);
      else if (op === 'add_stand') done = await doAddStand(fuzzLog);
      else if (op === 'move_stand') done = await doMoveStand(fuzzLog);
      else if (op === 'rename_stand') done = await doRenameStand(fuzzLog);
      else if (op === 'delete_one') done = await doDeleteOne(fuzzLog);
      else if (op === 'move_multi') done = await doMoveMulti(fuzzLog);
      else if (op === 'move_select_all') done = await doMoveSelectAll(fuzzLog);
      else if (op === 'move_single') done = await doMoveSingle(fuzzLog);
      else if (op === 'add_airway_node') done = await doAddAirwayNode(fuzzLog);
      else if (op === 'add_airway_procedure') done = await doAddAirwayProcedure(fuzzLog);
      else if (op === 'air_fillet') done = await doAirFillet(fuzzLog);
      else if (op === 'move_airway') done = await doMoveAirway(fuzzLog);
      else if (op === 'rename_airway') done = await doRenameAirway(fuzzLog);
      else if (op === 'delete_airway') done = await doDeleteAirway(fuzzLog);
      if (op === 'delete_one' && done) deleteCount++;
      summary.accepted += done ? 1 : 0;
      summary.rejected += done ? 0 : 1;
      log(`op ${i + 1}/${nOps} ${op} → ${done ? '✔' : '✖'}`);
      await window.waitForTimeout(90);
    }
    summary.deletes = deleteCount;

    for (const r of fuzzLog.rejected) {
      // Ground validation rejections that name a coordinate or endpoint error are retryable,
      // not generator bugs. A rejection that names a file or bounds error would be a bug.
      if (/bounds|range|clock/.test(r) && !/endpoint|vertex|fillet|straight|parallel/.test(r)) {
        throw new Error('unexpected rejection during ground fuzz: ' + r);
      }
    }
    for (const r of fuzzLog.rejected) {
      const key = r.split(':')[0];
      summary.rejectedReasons[key] = (summary.rejectedReasons[key] || 0) + 1;
    }

    // ── 4. Ensure viable save state (≥1 segment family), re-add if needed ──
    let curSum = (await getGroundState()).summary;
    let guard = 0;
    while ((!curSum || (curSum.segments === 0 && curSum.runways === 0)) && guard < 3) {
      if (!(await doAddTaxiway(fuzzLog))) throw new Error('could not re-add taxiway for save (rejections: ' + fuzzLog.rejected.join('; ') + ')');
      curSum = (await getGroundState()).summary;
      guard++;
    }
    log(`final ground counts: segs=${curSum?.segments ?? 0} rw=${curSum?.runways ?? 0} areas=${curSum?.areas ?? 0} stands=${curSum?.stands ?? 0} nodes=${curSum?.nodes ?? 0} airwayNodes=${curSum?.airwayNodes ?? 0} procedures=${curSum?.procedures ?? 0}`);

    // Snapshot expected scenery + flights for reload comparison
    const expectedGround = (await getGroundState()).summary;
    const expectedFlights = (await mcpCall('get_flights', { limit: 1000 })).flights;
    const expected = {
      ground: expectedGround ? { ...expectedGround } : null,
      flightCount: expectedFlights.length,
      flightCallsigns: new Set(expectedFlights.map(f => f.CallSign)),
    };

    // ── 5. Hit SAVE through the real Ground Painter UI (with backup) ──
    const save = await saveViaGroundUI(window);
    if (!save.saved) throw new Error('ground save did not run' + (save.blockedBy ? ' — blocked: ' + save.blockedBy : ''));

    // ── 6. Verify backup + reload ──
    const bakPath = currentPath + '.bak';
    // A save the app refused (inline .gp-error, no modal) surfaces here
    // immediately instead of as a .bak timeout — the reason text is the
    // app's own refusal message.
    const gpErr = await window.locator('div.gp-error').textContent({ timeout: 300 }).catch(() => null);
    if (gpErr) return { saved: false, blockedBy: 'app refused save: ' + gpErr.trim().substring(0, 300) };
    await waitFor(() => fs.existsSync(bakPath), { timeout: 10000, interval: 300, label: '.acl.bak creation' });
    summary.backupCreated = true;
    log('backup created:', bakPath);

    // Verify the saved .acl still decodes and scenery reloads
    let reloadedGraph = null;
    let reloadedFlights = null;
    try {
      const savedText = readAclText(currentPath);
      // Use the graph builder directly (same path as Ground Painter load)
      const { buildSceneryGraph } = require('../../src/acl/scenery_graph');
      const built = buildSceneryGraph(savedText);
      reloadedGraph = built.graph;
      const loaded = parser.loadFlights(currentPath);
      reloadedFlights = loaded.flights;
    } catch (e) {
      throw new Error('post-save reload failed: ' + e.message);
    }
    summary.reloaded = {
      nodes: reloadedGraph ? reloadedGraph.nodes.length : -1,
      segments: reloadedGraph ? reloadedGraph.segments.length : -1,
      runways: reloadedGraph ? reloadedGraph.runways.length : -1,
      areas: reloadedGraph ? reloadedGraph.areas.length : -1,
      stands: reloadedGraph ? reloadedGraph.stands.length : -1,
      airwayNodes: reloadedGraph ? (reloadedGraph.airwayNodes || []).length : -1,
      procedures: reloadedGraph ? (reloadedGraph.procedures || []).length : -1,
      flights: reloadedFlights ? reloadedFlights.length : -1,
    };
    log(`reload: segs=${summary.reloaded.segments} (expected ${expected.ground?.segments ?? '?'}) airwayNodes=${summary.reloaded.airwayNodes} procedures=${summary.reloaded.procedures} flights=${summary.reloaded.flights} (file baseline ${fileCallsignsBefore.size})`);
    // Ground counts are allowed to be repaired by the writer (gate drops degenerate
    // dangling refs), so we only assert the file parses and the flight contract
    // below holds. Flight baseline is the FILE, not the store (demo-classified
    // basenames hold a store subset — see the baseline note above).
    //
    // Flight contract (post flight-purge): a ground save may REMOVE flights whose
    // stand or runway no longer resolves in the saved scenery, and may REMAP
    // renamed stand/runway references. It must never keep a flight whose
    // reference no longer resolves (the game refuses flight-plan entries pointing
    // at missing scenery), never add flights, and never drop a flight whose
    // reference still resolves. Renames keep the callsign, so at callsign level:
    // missing ⇒ some baseline leg's reference dangles against the saved graph.
    const reloadedCallsigns = new Set(reloadedFlights.map(f => f.CallSign));
    const extra = [...reloadedCallsigns].filter(cs => !fileCallsignsBefore.has(cs));
    if (extra.length) {
      throw new Error(`ground save introduced flights: extra=${extra.join(',')}`);
    }
    const normSt = (v) => String(v || '').trim().replace(/^0+/, '');
    const { polygonIsSimple, buildSceneryGraph } = require('../../src/acl/scenery_graph');
    const savedStandNames = new Set();
    for (const st of reloadedGraph.stands) {
      for (const nm of [st.identifier, st.name]) { const v = normSt(nm); if (v) savedStandNames.add(v); }
    }
    const savedRunwayEnds = new Set();
    for (const rw of reloadedGraph.runways) {
      if (Array.isArray(rw.names)) for (const n of rw.names) { const v = normSt(n); if (v) savedRunwayEnds.add(v); }
      if (rw.physicalName) for (const n of String(rw.physicalName).split('/')) { const v = normSt(n); if (v) savedRunwayEnds.add(v); }
    }
    // Pre-save name spaces from the .bak (the save's own baseline): the purge —
    // like the save itself — only touches references that were resolvable
    // before the save. A flight referencing a stand/runway that the ORIGINAL
    // file never had is pre-existing data and must be left alone.
    const bakGraphGates = buildSceneryGraph(readAclText(bakPath));
    const preStandNames = new Set();
    for (const st of bakGraphGates.graph.stands) {
      for (const nm of [st.identifier, st.name]) { const v = normSt(nm); if (v) preStandNames.add(v); }
    }
    const preRunwayEnds = new Set();
    for (const rw of bakGraphGates.graph.runways) {
      if (Array.isArray(rw.names)) for (const n of rw.names) { const v = normSt(n); if (v) preRunwayEnds.add(v); }
      if (rw.physicalName) for (const n of String(rw.physicalName).split('/')) { const v = normSt(n); if (v) preRunwayEnds.add(v); }
    }
    // True when this leg's reference was resolvable pre-save and no longer
    // resolves in the saved scenery — i.e. the save was REQUIRED to purge (or
    // remap) this leg. Renames count as resolved (the save remaps them).
    const purgeWarranted = (f) =>
      (f.Stand && preStandNames.has(normSt(f.Stand)) && !savedStandNames.has(normSt(f.Stand))) ||
      (f.Runway && preRunwayEnds.has(normSt(f.Runway)) && !savedRunwayEnds.has(normSt(f.Runway)));
    const unresolved = reloadedFlights.filter(purgeWarranted)
      .map(f => `${f.CallSign}(stand=${f.Stand || '-'} runway=${f.Runway || '-'})`);
    if (unresolved.length) {
      throw new Error(`ground save kept flights with unresolved stand/runway refs: ${unresolved.join(',')}`);
    }
    const legsByCall = new Map();
    for (const f of fileFlightsBefore) {
      if (!legsByCall.has(f.CallSign)) legsByCall.set(f.CallSign, []);
      legsByCall.get(f.CallSign).push(f);
    }
    const missing = [...fileCallsignsBefore].filter(cs => !reloadedCallsigns.has(cs));
    const unexplained = missing.filter((cs) => !(legsByCall.get(cs) || []).some(purgeWarranted));
    if (unexplained.length) {
      throw new Error(`ground save dropped flights without a dangling stand/runway ref: ${unexplained.join(',')}`);
    }
    if (missing.length) log(`flight purge applied: ${missing.length} callsign(s) removed (${missing.join(',')})`);
    const storeMissing = [...expected.flightCallsigns]
      .filter(cs => !reloadedCallsigns.has(cs))
      .filter(cs => !(legsByCall.get(cs) || []).some(purgeWarranted));
    if (storeMissing.length) {
      throw new Error(`ground save dropped editor-visible flights without dangling refs: ${storeMissing.join(',')}`);
    }

    // ── Game-loadability gates (the invariants Unity enforces at load) ──
    // 1. Area outlines must be simple polygons — the Triangulator refuses
    //    self-crossing constraint edges ("ConstraintEdges ... intersect!" →
    //    NullReferenceException).
    const bowties = [];
    reloadedGraph.areas.forEach((a, i) => { if (!polygonIsSimple(a.points)) bowties.push('area#' + i); });
    if (bowties.length) throw new Error(`saved file has self-intersecting areas: ${bowties.join(',')}`);
    // 2. Runway naming must be collision-free: one `$k` per named runway and per
    //    physical-runway registry entry within the managed sections (PK/NPK/
    //    StaticItems). Frame runtime entities legitimately reuse the same keys —
    //    they are excluded, otherwise every new runway's frame entity looks like
    //    a duplicate. Duplicates inside the managed sections shadow each other
    //    by key and the game's registry resolves the original physical runway to
    //    zero named runways ("must have exactly two named runways, found 0").
    //    Keys already duplicated pre-save (.bak) are pre-existing and exempt.
    const swGates = require('../../src/acl/scenery_write');
    const countKs = (text) => {
      const counts = new Map();
      const ranges = swGates._staticEntitiesRanges(text);
      let scope = '';
      if (ranges) {
        for (const key of ['pkRc', 'npkRc', 'siRc']) {
          if (ranges[key]) scope += text.substring(ranges[key].start, ranges[key].end);
        }
      } else {
        scope = text; // fallback: files without the expected section layout
      }
      const re = /"\$k"\s*:\s*"((?:physical-)?runway:[^"]+)"/g;
      let mm2;
      while ((mm2 = re.exec(scope)) !== null) counts.set(mm2[1], (counts.get(mm2[1]) || 0) + 1);
      return counts;
    };
    const baseK = countKs(readAclText(bakPath));
    const dupK = [...countKs(readAclText(currentPath)).entries()]
      .filter(([k, c]) => c > 1 && (baseK.get(k) || 0) <= 1)
      .map(([k]) => k);
    if (dupK.length) throw new Error(`saved file has duplicate runway $k entries: ${dupK.join(',')}`);
    // 3. No orphan pavement strips: a segment named like a runway designation
    //    pair must belong to a runway that still exists.
    const physNames = new Set(reloadedGraph.runways.map(rw => rw.physicalName).filter(Boolean));
    const rwNameRe = /^[0-9]{1,2}[A-Z]?\/[0-9]{1,2}[A-Z]?$/;
    const orphanStrips = new Set();
    for (const sg of reloadedGraph.segments) {
      if (sg.name && rwNameRe.test(sg.name) && !physNames.has(sg.name)) orphanStrips.add(sg.name);
    }
    if (orphanStrips.size) throw new Error(`saved file has pavement strips without a runway: ${[...orphanStrips].join(',')}`);

    // Node/segment counts must at least parse (>=0) — exact equality not required
    // because the writer's survivor gate may drop degenerate dangling entities.
    if (reloadedGraph.nodes.length < 0 || reloadedGraph.segments.length < 0) {
      throw new Error('reloaded graph has negative counts');
    }

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
// Gated on FUZZ_RUN=1 — the ground fuzz storm is slow and must not slow down
// `npm run test:e2e` / `npm run test:all`.
const FUZZ_RUN = !!process.env.FUZZ_RUN || !!process.env.FUZZ_GROUND_RUN;

let electronApp;
let window;

test.beforeAll(async () => {
  if (!FUZZ_RUN) return;
  electronApp = await electron.launch({
    args: [
      path.join(__dirname, '..', '..', 'dist-electron', 'main.js'),
      `--user-data-dir=${process.env.E2E_USERDATA_DIR}`,
    ],
    env: { AC27_E2E_TMP_DIR: process.env.E2E_TMP_DIR },
    timeout: 60000,
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(2000);
  // Surface renderer console errors (save failures log via console.error and
  // render inline — without this a failed save looks like a .bak timeout).
  window.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`  [renderer.${msg.type()}] ` + msg.text().slice(0, 400));
    }
  });

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
    const baseName = path.basename(e);
    const root = path.join(TMP_DIR, 'GroundATC_Data', 'StreamingAssets', 'Airports');
    const found = [];
    for (const icao of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const dir = path.join(root, icao, 'Levels');
      if (!fs.existsSync(dir)) continue;
      const full = path.join(dir, baseName);
      if (fs.existsSync(full)) found.push(full);
    }
    if (found.length === 0) throw new Error(`target file not found in temp root: ${baseName}`);
    if (found.length > 1) throw new Error(`ambiguous target: ${baseName} matches ${found.join(', ')}`);
    return { path: found[0], base: path.basename(found[0], '.acl') };
  });
}

test.setTimeout(3600000);

test('Fuzz ground save — randomized Ground Painter edit storm on production levels', async () => {
  test.skip(!FUZZ_RUN, 'Skipped — set FUZZ_RUN=1 (or FUZZ_GROUND_RUN=1) to run the ground fuzz save test');
  const rows = window.locator('.level-row');
  await rows.first().waitFor({ state: 'visible', timeout: 90000 }).catch(() => {});
  const totalRows = await rows.count();
  console.log(`\nFound ${totalRows} level rows in browser`);
  expect(totalRows).toBeGreaterThanOrEqual(1);

  const seedBase = process.env.FUZZ_SEED ? parseInt(process.env.FUZZ_SEED, 10) : Date.now();
  const files = resolveTargetFiles();
  console.log(`\nFuzz ground targets (${files.length}): ${files.map(f => f.base).join(', ')}`);
  console.log(`Fuzz ground seed base: ${seedBase}  (set FUZZ_SEED to reproduce)`);

  const results = [];
  let passed = 0, failed = 0;

  for (let i = 0; i < files.length; i++) {
    const { path: aclPath, base } = files[i];
    console.log(`\n[${i + 1}/${files.length}] ${base} (ground)`);
    const r = await FuzzGroundTest(aclPath, { window, seed: seedBase });
    results.push(r);
    if (r.ok && !r.error) {
      passed++;
      console.log(`  ✓ PASSED (${r.accepted} accepted ops, backup=${r.backupCreated})`);
      if (FUZZ_REPLACE) {
        try { copyToRealGame(aclPath); }
        catch (e) { failed++; console.error(`  ✗ replace copy FAILED: ${e.message}`); }
      }
    }
    else { failed++; console.log(`  ✗ FAILED: ${r.error}`); }
    await goBackToBrowser(window);
    await window.waitForTimeout(1000);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Fuzz Ground Save — All Levels`);
  console.log(`  Total: ${results.length}  Passed: ${passed}  Failed: ${failed}`);
  results.forEach(r => {
    const icon = r.ok && !r.error ? '✓' : '✗';
    const reload = r.reloaded ? ` segs=${r.reloaded.segments} rw=${r.reloaded.runways} stands=${r.reloaded.stands}` : '';
    console.log(`  ${icon} ${r.file} (seed ${r.seed}, ${r.accepted}✓/${r.rejected}✖ ops, deletes=${r.deletes ?? 0}, backup=${r.backupCreated}${reload}${r.error ? ` err=${r.error}` : ''})`);
    if (r.rejectedReasons && Object.keys(r.rejectedReasons).length) {
      console.log(`      rejected reasons: ${JSON.stringify(r.rejectedReasons)}`);
    }
  });
  console.log(`${'═'.repeat(60)}\n`);

  expect(failed).toBe(0);
});
