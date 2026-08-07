// fetch-vosk-model.mjs — download the vosk recognition models into models/.
//
// Downloads vosk-model-en-us-0.22 (~1.9 GB — the LARGE en model, shipped in
// the voice build for accuracy; the small en-us-0.15 was ditched 2026-08-06
// as too inaccurate) and vosk-model-small-cn-0.22 (~42 MB — zh stays small)
// from alphacephei.com, extracts, and verifies each model's conf/model.conf
// sentinel. Idempotent: skips models already present. Zips are deleted after
// extraction — conf/model.conf is the sentinel.
//
// Usage:
//   node scripts/fetch-vosk-model.mjs          # fetch the pair
//   node scripts/fetch-vosk-model.mjs --check  # verify presence only (exit 1 if missing)
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import { get } from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, 'models');

// name → download URL (pinned versions — models are frozen at release)
const MODELS = {
  'vosk-model-en-us-0.22':
    'https://alphacephei.com/vosk/models/vosk-model-en-us-0.22.zip',
  'vosk-model-small-cn-0.22':
    'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip',
};

const FETCH_CMD = 'node scripts/fetch-vosk-model.mjs';

const checkOnly = process.argv.includes('--check');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => { out.close(); resolve(); });
      out.on('error', reject);
    }).on('error', reject);
  });
}

function extractZip(zip, dest) {
  // tar on win32 handles zip (bsdtar); fall back to PowerShell Expand-Archive.
  try {
    execFileSync('tar', ['-xf', zip, '-C', dest]);
  } catch (_) {
    const script =
      `Expand-Archive -Path '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  }
}

function modelPresent(name) {
  return existsSync(path.join(MODELS_DIR, name, 'conf', 'model.conf'));
}

async function fetchModel(name, url) {
  if (modelPresent(name)) {
    console.log(`[vosk-model] ${name}: already present`);
    return;
  }
  const zip = path.join(MODELS_DIR, `${name}.zip`);
  console.log(`[vosk-model] downloading ${name} (${url}) …`);
  await download(url, zip);
  console.log(`[vosk-model] extracting ${name} …`);
  extractZip(zip, MODELS_DIR);
  if (!modelPresent(name)) {
    throw new Error(`${name}: extracted but conf/model.conf not found (bad archive?)`);
  }
  unlinkSync(zip); // the ~1.9 GB en zip must not linger — conf/model.conf is the sentinel
  console.log(`[vosk-model] ${name}: OK`);
}

(async () => {
  mkdirSync(MODELS_DIR, { recursive: true });
  let ok = true;
  for (const [name, url] of Object.entries(MODELS)) {
    if (!modelPresent(name)) ok = false;
  }
  if (checkOnly) {
    if (ok) console.log('[vosk-model] all models present');
    else console.error(`[vosk-model] MISSING: run \`${FETCH_CMD}\` first`);
    process.exit(ok ? 0 : 1);
  }
  for (const [name, url] of Object.entries(MODELS)) {
    await fetchModel(name, url);
  }
  console.log('[vosk-model] done — models are gitignored; the voice build bundles them via build.js');
})().catch((err) => {
  console.error('[vosk-model] FAILED:', err.message);
  process.exit(1);
});
