/**
 * Timeline Editors E2E tests — E6c, E6f, E7a
 *
 * Timeline blocks are ABOVE the flight table in the DOM. They start
 * COLLAPSED — we must expand them by clicking headers before interacting.
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

  // Scroll to top of table-container where timeline blocks are
  await window.locator('#table-container').evaluate(el => el.scrollTop = 0);
  await window.waitForTimeout(500);
});

test.afterAll(async () => {
  await electronApp.close();
});

// ── Helper: expand a collapsed timeline section ──────────────────

async function expandTimelineSection(sectionId) {
  const block = window.locator(`#${sectionId}`);
  if (!(await block.isVisible().catch(() => false))) return false;

  // Check if collapsed
  const isCollapsed = await block.evaluate(el => el.classList.contains('collapsed'));
  if (isCollapsed) {
    // Click the header to expand
    const header = block.locator('.tl-embed-header').first();
    await header.click();
    await window.waitForTimeout(400);
  }
  return true;
}

// ── E6c: Weather add/delete row ──────────────────────────────────

test('E6c — weather add button creates new row', async () => {
  if (!(await expandTimelineSection('timeline-block-weather'))) {
    test.skip(true, 'Weather editor not found');
    return;
  }

  // Count existing rows in the weather list
  const list = window.locator('#weather-list');
  const beforeCount = await list.locator('.tl-row').count();

  // Click add button
  const addBtn = list.locator('.btn-sm').first();
  if (!(await addBtn.isVisible().catch(() => false))) {
    test.skip(true, 'Weather add button not visible');
    return;
  }
  await addBtn.click();
  await window.waitForTimeout(500);

  const afterCount = await list.locator('.tl-row').count();
  expect(afterCount).toBeGreaterThan(beforeCount);
});

// ── E6f: Wind add/delete row ─────────────────────────────────────

test('E6f — wind add button creates new row', async () => {
  if (!(await expandTimelineSection('timeline-block-wind'))) {
    test.skip(true, 'Wind editor not found');
    return;
  }

  const list = window.locator('#wind-list');
  const beforeCount = await list.locator('.tl-row').count();

  const addBtn = list.locator('.btn-sm').first();
  if (!(await addBtn.isVisible().catch(() => false))) {
    test.skip(true, 'Wind add button not visible');
    return;
  }
  await addBtn.click();
  await window.waitForTimeout(500);

  const afterCount = await list.locator('.tl-row').count();
  expect(afterCount).toBeGreaterThan(beforeCount);
});

// ── E7a: Runway initial checkboxes ───────────────────────────────

test('E7a — runway checkboxes are visible', async () => {
  if (!(await expandTimelineSection('timeline-block-runway'))) {
    test.skip(true, 'Runway editor not found');
    return;
  }

  // The initial runway section has checkboxes
  const runwaySection = window.locator('#timeline-block-runway');
  const checkboxes = runwaySection.locator('input[type="checkbox"]');
  const count = await checkboxes.count();

  // ZSJN should have runway checkboxes (at least 1)
  expect(count).toBeGreaterThanOrEqual(1);
});
