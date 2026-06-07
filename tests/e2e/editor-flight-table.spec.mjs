/**
 * Editor Flight Table E2E tests — E1b, E4
 *
 * Requires: app is on the Browser screen with a level row visible.
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

  // Click the first level row to open the editor
  const firstRow = window.locator('.level-row').first();
  if (await firstRow.isVisible().catch(() => false)) {
    await firstRow.click();
    await window.waitForTimeout(3000);
  }
});

test.afterAll(async () => {
  await electronApp.close();
});

// ── E1b: Select-all / Deselect-all toggle ────────────────────────

test('E1b — select-all toggles all checkboxes', async () => {
  // Check if we're on the editor screen
  const selectAllBtn = window.locator('button:has-text("Select All"), button:has-text("全选")').first();
  if (!(await selectAllBtn.isVisible().catch(() => false))) {
    test.skip(true, 'Not on editor screen — no level to open?');
    return;
  }

  await selectAllBtn.click();
  await window.waitForTimeout(300);

  // Verify checkboxes are checked
  const checkboxes = window.locator('.flight-table input[type="checkbox"]:checked');
  const checkedCount = await checkboxes.count();
  expect(checkedCount).toBeGreaterThan(0);

  // Click again to deselect
  await selectAllBtn.click();
  await window.waitForTimeout(300);

  const unchecked = window.locator('.flight-table input[type="checkbox"]:checked');
  const uncheckedCount = await unchecked.count();
  expect(uncheckedCount).toBe(0);
});

// ── E4a: Add Arrival flight ──────────────────────────────────────

test('E4a — add arrival flight creates new row', async () => {
  const addBtn = window.locator('button:has-text("Add Arrival"), button:has-text("添加进港")').first();
  if (!(await addBtn.isVisible().catch(() => false))) {
    test.skip(true, 'Not on editor screen');
    return;
  }

  // Count rows before
  const beforeCount = await window.locator('.flight-table tbody tr').count();

  await addBtn.click();
  await window.waitForTimeout(500);

  const afterCount = await window.locator('.flight-table tbody tr').count();
  expect(afterCount).toBeGreaterThan(beforeCount);
});

// ── E4c: Delete selected flights ─────────────────────────────────

test('E4c — delete selected flights removes rows', async () => {
  // First, select the first checkbox
  const firstCheckbox = window.locator('.flight-table tbody tr input[type="checkbox"]').first();
  if (!(await firstCheckbox.isVisible().catch(() => false))) {
    test.skip(true, 'No checkboxes visible');
    return;
  }

  await firstCheckbox.click();
  await window.waitForTimeout(200);

  const beforeCount = await window.locator('.flight-table tbody tr').count();

  // Click delete
  const deleteBtn = window.locator('button:has-text("Delete"), button:has-text("删除")').first();
  if (await deleteBtn.isVisible().catch(() => false)) {
    await deleteBtn.click();
    await window.waitForTimeout(500);

    // Confirm the delete modal — button uses class btn-confirm
    const confirmBtn = window.locator('.btn-confirm').first();
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click();
      await window.waitForTimeout(1000);
    }

    const afterCount = await window.locator('.flight-table tbody tr').count();
    expect(afterCount).toBeLessThan(beforeCount);
  }
});
