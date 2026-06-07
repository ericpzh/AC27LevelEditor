import { rmSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.resolve(__dirname, '..');

export default async function () {
  // Clean up temp dirs (comment out to inspect files after a failed run)
  const tmpDir = path.join(TESTS_DIR, 'tmp-e2e');
  const userDataDir = path.join(TESTS_DIR, 'tmp-e2e-userdata');
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true });
    console.log('[E2E teardown] Removed', tmpDir);
  }
  if (existsSync(userDataDir)) {
    rmSync(userDataDir, { recursive: true });
    console.log('[E2E teardown] Removed', userDataDir);
  }
};
