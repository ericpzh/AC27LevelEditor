/**
 * Save Integrity E2E test — S1, S2, S3
 *
 * S1: Open level, snapshot flights, save (no edits), find .bak, diff.
 * S2: Categorize diffs: expected (GUID regeneration, timestamps) vs unexpected.
 * S3: Re-load the saved .acl through the parser — verify flight count,
 *     field values, and timeline entries match.
 */
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = process.env.E2E_TMP_DIR;

let electronApp;
let window;

test.setTimeout(90000);

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [
      path.join(__dirname, '..', '..', 'dist-electron', 'main.js'),
      `--user-data-dir=${process.env.E2E_USERDATA_DIR}`,
    ], env: { AC27_E2E_TMP_DIR: process.env.E2E_TMP_DIR },
    timeout: 60000,
  });

  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // Capture renderer console logs for diagnostics
  window.on('console', msg => {
    if (msg.type() === 'log') console.log('[RENDERER]', msg.text());
  });

  await window.waitForSelector('.loading-state', { state: 'hidden', timeout: 70000 }).catch(() => {});
  await window.waitForSelector('.level-row', { state: 'visible', timeout: 10000 });
  const rows = window.locator('.level-row');
  await expect(rows.first()).toBeVisible({ timeout: 10000 });
  await rows.first().click();
  await expect(window.locator('#table-container')).toBeVisible({ timeout: 15000 });
  await window.waitForTimeout(500);
});

test.afterAll(async () => {
  await electronApp.close();
});

// ── Helper ────────────────────────────────────────────────────────

function findAclFiles(tmpDir) {
  const result = { acl: null, bak: null };
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.endsWith('.acl.bak')) {
        result.bak = fullPath;
      } else if (entry.name.endsWith('.acl') && !entry.name.endsWith('.demo.acl')) {
        result.acl = fullPath;
      }
    }
  }
  walk(tmpDir);
  return result;
}

// ── S1+S2+S3: No-change save round-trip ──────────────────────────

test('S1 — no-change save round-trip (parsed-state comparison)', async () => {
  // Check we're on the editor screen
  const saveBtn = window.locator('button:has-text("Save"), button:has-text("保存")').first();
  if (!(await saveBtn.isVisible().catch(() => false))) {
    test.skip(true, 'Not on editor screen');
    return;
  }

  // Get the exact .acl path from the store (same as save-integrity-all-e2e)
  const aclPath = await window.evaluate(() => {
    const store = window.__AC27_STORE;
    return store ? store.getState().currentPath : null;
  });
  expect(aclPath).toBeTruthy();
  console.log('[S1] ACL path:', aclPath);

  // Read the pre-save .acl content for GUID comparison
  const aclBefore = fs.readFileSync(aclPath, 'utf-8');
  const guidCountBefore = (aclBefore.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).length;
  console.log('[S1] Pre-save GUID count:', guidCountBefore);

  // ── Widen config time range to cover all flights ──────────────
  const storeExists = await window.evaluate(() => !!window.__AC27_STORE);
  console.log('[S1] Store accessible:', storeExists);

  await window.evaluate(() => {
    const store = window.__AC27_STORE;
    if (store) {
      const st = store.getState();
      console.log('[APP] _saveSec:', st._saveSec, '_configStartTime:', st._configStartTime, '_configEndTime:', st._configEndTime);
      // Disable time-range validation by setting _saveSec to null.
      // This makes the save integrity test validate GUID regeneration +
      // parser round-trip without flight-time constraints blocking the save.
      store.setState({ _saveSec: null, _configStartTime: '00:00:00', _configEndTime: '23:59:59' });
    }
  });
  console.log('[S1] Disabled time-range validation for save integrity test');

  // ── Trigger save ─────────────────────────────────────────────
  await window.keyboard.press('Control+s');
  await window.waitForTimeout(2000);

  // Handle the modal(s). Order of possible modals:
  // 1. Validation issues (has .btn-cancel/.btn-confirm "Close") → click to dismiss
  // 2. Save confirmation (has .btn-confirm "Save" with backup checkbox) → click to save
  // 3. Save success (has .btn-confirm "OK") → click to dismiss

  let modalPass = 0;
  while (modalPass < 3) {
    const modal = window.locator('#modal-overlay');
    const visible = await modal.isVisible().catch(() => false);
    if (!visible) break;

    const title = await window.locator('#modal-title').textContent().catch(() => '(none)');
    console.log(`[S1] Modal pass ${modalPass}: "${title}"`);

    // Click the confirm button (could be Close, Confirm Save, or OK)
    const btn = window.locator('#modal-actions .btn-confirm').first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      console.log(`[S1]   Clicked .btn-confirm`);
    } else {
      // Try cancel
      const cancelBtn = window.locator('#modal-actions .btn-cancel').first();
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click();
        console.log(`[S1]   Clicked .btn-cancel`);
      }
    }
    await window.waitForTimeout(1500);
    modalPass++;
  }

  // Final wait for async save to complete
  await window.waitForTimeout(2000);

  // The .bak should be at aclPath + '.bak' (same file we saved)
  const bakPath = aclPath + '.bak';
  console.log('[S1] ACL after save:', aclPath);
  console.log('[S1] BAK after save:', fs.existsSync(bakPath) ? bakPath : '(NOT FOUND)');

  expect(fs.existsSync(aclPath)).toBeTruthy();
  expect(fs.existsSync(bakPath)).toBeTruthy();

  // ── Run the parsed-state checker ──────────────────────────────
  const checkerPath = path.resolve(__dirname, '..', 'save-integrity-check.js');
  const preloadPath = path.resolve(__dirname, '..', 'integration', 'preload.cjs');

  // Demo files must be checked with --demo (parsability only) — flight counts differ due to window filtering (like save-integrity-all-e2e)
  const DEMO_VISIBLE = new Set(['KJFK_leisure_1.demo.acl', 'KJFK_peakarrival.demo.acl', 'ZSJN_leisure_1.acl', 'ZSJN_peakdeparture.demo.acl']);
  const isDemo = DEMO_VISIBLE.has(path.basename(aclPath));

  let checkerOutput;
  try {
    const checkerArgs = isDemo
      ? `--demo --acl "${aclPath}"`
      : `--acl "${aclPath}" --bak "${bakPath}"`;
    checkerOutput = execSync(
      `node --require "${preloadPath}" "${checkerPath}" ${checkerArgs}`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    console.log('[S1] Checker output:\n', checkerOutput);
  } catch (e) {
    const errOutput = e.stdout || e.stderr || e.message;
    console.error('[S1] Checker failed:', errOutput);
    throw new Error(`Save integrity check failed: ${errOutput}`);
  }

  expect(checkerOutput).toContain('ALL CHECKS PASSED');
});
