#!/usr/bin/env node
/**
 * Master test runner — executes all test layers.
 *
 * Usage:
 *   node tests/run-all.mjs [--game-root <path>]
 *
 * Layers:
 *   1. Vitest (component tests)     — 73 tests, ~1s
 *   2. Integration: save integrity  — 12 prod+demo files, ~20s
 *   3. Playwright E2E                — 16 tests, ~60s (requires build, uses E2E_GAME_ROOT)
 *
 * Default game root: D:\SteamLibrary\steamapps\common\Airport Control 25 Playtest
 */

import { execSync, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Config ────────────────────────────────────────────────────────
const GAME_ROOT = process.argv.includes('--game-root')
  ? process.argv[process.argv.indexOf('--game-root') + 1]
  : 'D:\\SteamLibrary\\steamapps\\common\\Airport Control 25 Playtest';

const PRELOAD = path.join(__dirname, 'integration', 'preload.cjs');
const SAVE_INTEGRITY = path.join(__dirname, 'integration', 'test_save_integrity_all.js');

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const failures = [];

// ── Helpers ───────────────────────────────────────────────────────

function runStep(label, cmd) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`▶ ${label}`);
  console.log(`${'='.repeat(60)}`);

  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', timeout: 300000 });
    totalPassed++;
    console.log(`\n✓ ${label} — PASSED`);
    return 0;
  } catch (e) {
    totalFailed++;
    failures.push(label);
    console.log(`\n✗ ${label} — FAILED (exit ${e.status})`);
    return e.status;
  }
}

// ── Main ──────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║        AC27 Level Editor — Full Test Suite          ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log(`\nGame root: ${GAME_ROOT}`);

const startTime = Date.now();

// ── 1. Vitest ────────────────────────────────────────────────────
runStep('Layer 1: Vitest (73 component tests)', 'npx vitest run');

// ── 2. Save Integrity (12 prod+demo files) ───────────────────────
// Quote paths to handle spaces in game root
const layer2Cmd = `node --require "${PRELOAD}" "${SAVE_INTEGRITY}" --root "${GAME_ROOT}" --prod-demo`;
runStep('Layer 2: Save Integrity (8 prod + 4 demo .acl files)', layer2Cmd);

// ── 3. Build (E2E needs dist-electron/main.js) ──────────────────
console.log(`\n${'='.repeat(60)}`);
console.log('▶ Build (required for E2E)');
console.log(`${'='.repeat(60)}`);
try {
  execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });
  console.log('✓ Build complete');
} catch (e) {
  console.log('✗ Build failed');
  totalFailed++;
  failures.push('Build');
}

// ── 4. Playwright E2E ────────────────────────────────────────────
// Set E2E_GAME_ROOT so global-setup sources all 12 prod+demo files
// (including KJFK) from the real game installation instead of the
// limited ZSJN-only fixture directory.
const e2eEnv = { ...process.env, E2E_GAME_ROOT: GAME_ROOT };
const layer4Cmd = `npx playwright test --config=playwright.config.mjs`;
console.log(`\n${'='.repeat(60)}`);
console.log('▶ Layer 3: Playwright E2E (16 browser tests)');
console.log(`${'='.repeat(60)}`);
try {
  execSync(layer4Cmd, { cwd: ROOT, stdio: 'inherit', env: e2eEnv, timeout: 600000 });
  totalPassed++;
  console.log(`\n✓ Layer 3: Playwright E2E (16 browser tests) — PASSED`);
} catch (e) {
  totalFailed++;
  failures.push('Layer 3: Playwright E2E');
  console.log(`\n✗ Layer 3: Playwright E2E — FAILED (exit ${e.status})`);
}

// ── Summary ──────────────────────────────────────────────────────
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n${'═'.repeat(60)}`);
console.log('║                 TEST SUITE SUMMARY                    ║');
console.log(`${'═'.repeat(60)}`);
console.log(`  Passed:  ${totalPassed}`);
console.log(`  Failed:  ${totalFailed}`);
console.log(`  Skipped: ${totalSkipped}`);
console.log(`  Time:    ${elapsed}s`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  failures.forEach(f => console.log(`    ✗ ${f}`));
}
console.log(`${'═'.repeat(60)}\n`);

process.exit(totalFailed > 0 ? 1 : 0);
