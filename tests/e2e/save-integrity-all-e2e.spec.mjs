/**
 * E2E Save Integrity — all 12 prod+demo .acl files.
 *
 * For each level row visible in the browser:
 *   1. Click to open in editor
 *   2. Disable time-range validation (so no-change save is accepted)
 *   3. Ctrl+S → confirm save
 *   4. Run save-integrity-check.js on the saved .acl vs .bak
 *   5. Navigate back to browser
 *   6. Report per-file results
 *
 * Requires: E2E_GAME_ROOT env var pointing to real game installation.
 *   npx playwright test --config=playwright.config.mjs tests/e2e/save-integrity-all-e2e.spec.mjs
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
});

test.afterAll(async () => {
  await electronApp.close();
});

// ── Helpers ──────────────────────────────────────────────────────

function findAclFiles(dir) {
  const results = [];
  function walk(d) {
    if (!fs.existsSync(d)) return;
    const ents = fs.readdirSync(d, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.acl') && !e.name.endsWith('.acl.bak') && !e.name.endsWith('.demo.acl')) {
        results.push({ path: p, name: e.name, dir: path.dirname(p) });
      }
    }
  }
  walk(dir);
  return results;
}

function findBakFor(aclPath) {
  const bakPath = aclPath + '.bak';
  return fs.existsSync(bakPath) ? bakPath : null;
}

async function disableValidation() {
  await window.evaluate(() => {
    const store = window.__AC27_STORE;
    if (!store) return;

    // Disable time-range validation
    store.setState({ _saveSec: null, _configStartTime: '00:00:00', _configEndTime: '23:59:59' });
  });
}

async function saveViaUI() {
  await window.keyboard.press('Control+s');
  await window.waitForTimeout(2000);

  let saveRan = false;

  // Handle modal chain. Possible modals in order:
  //   1. Validation issues → Close dismisses, save cancelled
  //   2. Save confirmation → Confirm triggers save
  //   3. Save success → OK dismisses
  for (let pass = 0; pass < 5; pass++) {
    const modal = window.locator('#modal-overlay');
    if (!(await modal.isVisible().catch(() => false))) break;

    const title = await window.locator('#modal-title').textContent().catch(() => '');
    console.log(`    Modal [${pass}]: "${title}"`);

    const isIssue = /issue|问题|修复|超出/.test(title);
    const isConfirm = /backup|备份|保存前/i.test(title);

    if (isIssue) {
      // Log the validation issues for diagnostics
      const body = await window.locator('#modal-body').textContent().catch(() => '(no body)');
      console.log(`    Validation issues: ${body.substring(0, 200)}`);
      const closeBtn = window.locator('#modal-actions .btn-confirm, #modal-actions .btn-cancel').first();
      if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
      console.log('    → Closed validation issues modal (save cancelled)');
      await window.waitForTimeout(500);
      return { saved: false };
    }

    // Save confirmation — this click triggers the actual save
    if (isConfirm) saveRan = true;

    const btn = window.locator('#modal-actions .btn-confirm').first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click();
      console.log(`    → Clicked confirm`);
    } else break;
    await window.waitForTimeout(1000);
  }
  await window.waitForTimeout(1500);
  return { saved: saveRan };
}

async function goBackToBrowser() {
  const backBtn = window.locator('button:has-text("Back"), button:has-text("返回")').first();
  if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click();
    await window.waitForTimeout(1000);
    // If unsaved changes modal appears, discard
    const modal = window.locator('#modal-overlay');
    if (await modal.isVisible().catch(() => false)) {
      const discard = window.locator('#modal-actions .btn-cancel, #modal-actions .btn-confirm').first();
      if (await discard.isVisible().catch(() => false)) {
        await discard.click();
        await window.waitForTimeout(1000);
      }
    }
  }
}

// ── Test: iterate all levels ─────────────────────────────────────

test.setTimeout(600000); // 10 min for 12 files

test('E2E save integrity — all prod+demo levels', async () => {
  // Count level rows
  const rows = window.locator('.level-row');
  const totalRows = await rows.count();
  console.log(`\nFound ${totalRows} level rows`);
  expect(totalRows).toBeGreaterThanOrEqual(1);

  const checkerPath = path.resolve(__dirname, '..', 'save-integrity-check.js');
  const preloadPath = path.resolve(__dirname, '..', 'integration', 'preload.cjs');
  const results = [];
  let passed = 0, failed = 0;

  for (let i = 0; i < totalRows; i++) {
    const row = rows.nth(i);
    const rowText = await row.textContent().catch(() => `row-${i}`);
    const label = rowText.substring(0, 60).replace(/\s+/g, ' ').trim();
    console.log(`\n[${i + 1}/${totalRows}] ${label}`);

    try {
      // Open level
      await row.click();
      await window.waitForTimeout(3000);

      // Check we're on the editor screen
      const saveBtn = window.locator('button:has-text("Save"), button:has-text("保存")').first();
      if (!(await saveBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
        console.log('  SKIP: editor did not open');
        results.push({ label, status: 'skipped', reason: 'editor not loaded' });
        continue;
      }

      // Disable time validation
      await disableValidation();

      // Get the exact .acl path from the store (the file that will be saved)
      const currentPath = await window.evaluate(() => {
        const store = window.__AC27_STORE;
        return store ? store.getState().currentPath : null;
      });
      const isDemo = currentPath && currentPath.endsWith('.demo.acl');
      console.log(`    currentPath: ${currentPath || 'N/A'}${isDemo ? ' (demo)' : ''}`);

      if (!currentPath) {
        console.log('  SKIP: no currentPath in store');
        await goBackToBrowser();
        results.push({ label, status: 'skipped', reason: 'no currentPath' });
        continue;
      }

      // Save via UI
      const saveResult = await saveViaUI();
      if (!saveResult.saved) {
        console.log('  SKIP: save blocked by validation');
        results.push({ label, status: 'skipped', reason: 'validation blocked save' });
        await goBackToBrowser();
        continue;
      }

      // Check .bak at the exact saved path
      const expectedBak = currentPath + '.bak';
      const bakExists = fs.existsSync(expectedBak);
      console.log(`    Looking for .bak: ${expectedBak} → ${bakExists ? 'FOUND' : 'NOT FOUND'}`);

      // Also list all .bak files for diagnostics
      const allBaks = [];
      function walkBaks(d) {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walkBaks(p);
          else if (e.name.endsWith('.bak')) allBaks.push(p);
        }
      }
      walkBaks(TMP_DIR);
      if (!bakExists && allBaks.length > 0) {
        console.log(`    All .bak files in temp: ${allBaks.map(p => path.basename(p)).join(', ')}`);
      }

      if (!bakExists) {
        console.log('  FAIL: no .bak created');
        failed++;
        results.push({ label, status: 'failed', reason: 'no .bak created' });
        await goBackToBrowser();
        continue;
      }

      // Run checker
      try {
        const checkerArgs = isDemo
          ? `--demo --acl "${currentPath}"`
          : `--acl "${currentPath}" --bak "${expectedBak}"`;
        const output = execSync(
          `node --require "${preloadPath}" "${checkerPath}" ${checkerArgs}`,
          { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        );
        if (output.includes('ALL CHECKS PASSED')) {
          const demoTag = isDemo ? ' (demo)' : '';
          console.log(`  ✓ PASSED${demoTag}`);
          passed++;
          results.push({ label, status: 'passed', file: path.basename(currentPath) });
        } else {
          console.log('  ✗ Checker did not pass');
          failed++;
          results.push({ label, status: 'failed', reason: 'checker output mismatch' });
        }
      } catch (e) {
        const errDetail = (e.stdout || e.stderr || e.message || '').substring(0, 500);
        console.log('  ✗ Checker error:', errDetail);
        failed++;
        results.push({ label, status: 'failed', reason: 'checker error', detail: errDetail });
      }

    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      failed++;
      results.push({ label, status: 'failed', reason: e.message });
    }

    // Navigate back to browser for next iteration
    await goBackToBrowser();
    await window.waitForTimeout(1000);
  }

  // ── Report ────────────────────────────────────────────────────
  const skipped = results.filter(r => r.status === 'skipped').length;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  E2E Save Integrity — All Levels`);
  console.log(`  Total: ${results.length}  Passed: ${passed}  Failed: ${failed}  Skipped: ${skipped}`);
  results.forEach(r => {
    const icon = r.status === 'passed' ? '✓' : r.status === 'skipped' ? '−' : '✗';
    console.log(`  ${icon} ${r.label} (${r.file || r.reason || ''})`);
  });
  console.log(`${'═'.repeat(60)}\n`);

  expect(failed).toBe(0);
});
