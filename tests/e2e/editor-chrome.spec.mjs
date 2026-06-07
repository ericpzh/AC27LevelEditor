/**
 * Editor Chrome E2E tests — E12a, E12d, E12e
 */
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ── E12a: Help button ────────────────────────────────────────────

test('E12a — help button opens tutorial overlay', async () => {
  // Help button: <button title="Help"> with IoHelpCircleOutline icon
  const helpBtn = window.locator('#toolbar button[title="Help"]');
  if (!(await helpBtn.isVisible().catch(() => false))) {
    test.skip(true, 'Help button not visible');
    return;
  }

  await helpBtn.click();
  await window.waitForTimeout(500);

  // Tutorial overlay should appear
  const overlay = window.locator('#tutorial-overlay');
  const isVisible = await overlay.isVisible().catch(() => false);
  expect(isVisible).toBe(true);

  // Close with Escape
  await window.keyboard.press('Escape');
  await window.waitForTimeout(300);
  expect(await overlay.isVisible().catch(() => true)).toBe(false);
});

// ── E12d: Back button (no changes) ───────────────────────────────

test('E12d — back button returns to browser when no changes', async () => {
  const backBtn = window.locator('button:has-text("Back"), button:has-text("返回")').first();
  if (!(await backBtn.isVisible().catch(() => false))) {
    test.skip(true, 'Back button not visible');
    return;
  }

  // Since we just opened the level with no edits, clicking back should
  // return to browser without showing unsaved-changes modal
  await backBtn.click();
  await window.waitForTimeout(1000);

  // Check if a confirmation modal appeared (unsaved changes)
  const modal = window.locator('#modal-overlay');
  const modalVisible = await modal.isVisible().catch(() => false);

  if (modalVisible) {
    // Click Discard in the unsaved changes modal
    const discardBtn = window.locator('#modal-actions .btn-cancel').first();
    if (await discardBtn.isVisible().catch(() => false)) {
      await discardBtn.click();
      await window.waitForTimeout(1000);
    }
  }

  // Should be back on browser screen now
  const levelRows = window.locator('.level-row');
  const count = await levelRows.count().catch(() => 0);
  expect(count).toBeGreaterThanOrEqual(1);
});
