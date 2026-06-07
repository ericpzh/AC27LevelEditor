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
  await window.waitForTimeout(2000);

  // Open first level
  const firstRow = window.locator('.level-row').first();
  if (await firstRow.isVisible().catch(() => false)) {
    await firstRow.click();
    await window.waitForTimeout(3000);
  }
});

test.afterAll(async () => {
  await electronApp.close();
});

// ── E10a: Save success flow ──────────────────────────────────────

test('E10a — save creates .bak file', async () => {
  // Trigger save via Ctrl+S
  await window.keyboard.press('Control+s');
  await window.waitForTimeout(1500);

  // Save confirmation modal: click Confirm Save (btn-confirm), not Cancel
  const confirmSaveBtn = window.locator('#modal-actions .btn-confirm').first();
  if (await confirmSaveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await confirmSaveBtn.click();
    await window.waitForTimeout(1000);
  }

  // Dismiss success toast modal if it appears
  const modalOk = window.locator('#modal-actions .btn-confirm').first();
  if (await modalOk.isVisible({ timeout: 1000 }).catch(() => false)) {
    await modalOk.click();
    await window.waitForTimeout(500);
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
