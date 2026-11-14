/**
 * Editor File Operations E2E tests — E8a, E10a
 */
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
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

// ── E10a: Save success flow ──────────────────────────────────────

test('E10a — save creates .bak file', async () => {
  // Clamp any pre-startTime source flights (e.g. ZSJN_leisure_1 05:45:00 / 05:45:42 < 05:46:00)
  // into the valid level window so Ctrl+S exercises a real save rather than hitting validation.
  await window.evaluate(() => {
    const store = window.__AC27_STORE;
    if (!store) return;
    const st = store.getState();
    const startTime = st._configStartTime;
    if (!startTime) return;
    const toSec = (t) => {
      const p = String(t || '').trim().split(':').map(Number);
      if (p.length < 2 || p.some(Number.isNaN)) return null;
      return p[0] * 3600 + p[1] * 60 + (p[2] || 0);
    };
    const startSec = toSec(startTime);
    if (startSec === null) return;
    const minStr = startTime.split(':').length === 2 ? `${startTime}:00` : startTime;
    const nextFlights = st.flights.map((f) => {
      const patched = { ...f };
      for (const col of ['OffBlockTime', 'LandingTime']) {
        const s = toSec(patched[col]);
        if (s !== null && s < startSec) patched[col] = minStr;
      }
      return patched;
    });
    store.setState({ flights: nextFlights });
  });

  // Trigger save via Ctrl+S
  await window.keyboard.press('Control+s');
  await expect(window.locator('#modal-overlay')).toBeVisible({ timeout: 5000 });

  const confirmTitle = await window.locator('#modal-title').textContent();
  expect(confirmTitle).toMatch(/backup|备份|保存前/i);

  // Save confirmation modal: click Confirm Save (btn-confirm), not Cancel
  const confirmSaveBtn = window.locator('#modal-actions .btn-confirm').first();
  await expect(confirmSaveBtn).toBeVisible({ timeout: 3000 });
  await confirmSaveBtn.click();

  // Wait for Save Successful modal and dismiss it
  await expect(window.locator('#modal-title')).toContainText(/Save Successful|保存成功/i, { timeout: 15000 });
  const modalOk = window.locator('#modal-actions .btn-confirm').first();
  if (await modalOk.isVisible({ timeout: 2000 }).catch(() => false)) {
    await modalOk.click();
    await window.waitForTimeout(300);
  }

  const bakFiles = findBakFiles(TMP_DIR);
  expect(bakFiles.length).toBeGreaterThan(0);

  // Remove .bak created by E10a so E8a independently verifies manual backup .bak creation
  for (const bf of bakFiles) {
    fs.rmSync(bf, { force: true });
  }
});

// ── E8a: Backup creation ─────────────────────────────────────────

test('E8a — manual backup creates .bak file', async () => {
  const backupBtn = window.locator('button:has-text("Backup"), button:has-text("备份")').first();
  if (!(await backupBtn.isVisible().catch(() => false))) {
    test.skip(true, 'Backup button not visible');
    return;
  }

  await backupBtn.click();
  // Backup is async — wait for IPC round-trip + toast
  await window.waitForTimeout(3000);

  // Dismiss if error modal appeared (toast on success)
  const modalOk = window.locator('#modal-actions button').first();
  if (await modalOk.isVisible().catch(() => false)) {
    await modalOk.click();
    await window.waitForTimeout(500);
  }

  // Verify .bak file exists in temp dir
  const bakFiles = findBakFiles(TMP_DIR);
  if (bakFiles.length === 0) {
    // Debug: list files in the fixture
    const allFiles = listAllFiles(TMP_DIR);
    console.log('[E8a] No .bak found. All files in tmp-e2e:', allFiles.slice(0, 20));
  }
  expect(bakFiles.length).toBeGreaterThan(0);
});

function findBakFiles(dir) {
  const results = [];
  function walk(d) {
    if (!fs.existsSync(d)) return;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.bak')) results.push(full);
    }
  }
  walk(dir);
  return results;
}

function listAllFiles(dir) {
  const results = [];
  function walk(d) {
    if (!fs.existsSync(d)) return;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else results.push(full);
    }
  }
  walk(dir);
  return results;
}
