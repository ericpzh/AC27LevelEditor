/**
 * Fuzz Ground CLI wrapper — the "node command" entry for the Ground Painter fuzz save test.
 *
 *   node tests/e2e/fuzz-ground-cli.mjs [--replace] [extra playwright args...]
 *   npm  run test:fuzz:ground [-- --replace]
 *
 * --replace: after a level passes, copy the generated .acl and .acl.bak (and
 * the optional .acl.bg.json sidecar) from the temp sandbox into the REAL game
 * level directory (E2E_GAME_ROOT/GroundATC_Data/StreamingAssets/Airports/<icao>/Levels/).
 * The flag becomes the FUZZ_REPLACE env var consumed by fuzz-ground-save.spec.mjs.
 * All other arguments are forwarded to playwright unchanged.
 *
 * Set locally without the flag: $env:FUZZ_REPLACE = "1"; npm run test:fuzz:ground
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);

const replaceIdx = args.indexOf('--replace');
if (replaceIdx !== -1) {
  process.env.FUZZ_REPLACE = '1';
  args.splice(replaceIdx, 1);
}

const pwCli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const r = spawnSync(process.execPath, [
  pwCli,
  'test',
  '--config=playwright.config.mjs',
  'tests/e2e/fuzz-ground-save.spec.mjs',
  ...args,
], { stdio: 'inherit', cwd: repoRoot });

process.exit(r.status === null ? 1 : r.status);
