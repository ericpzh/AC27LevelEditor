/**
 * BepInEx Debug Mode — download, install, uninstall for Airport Control 27.
 *
 * All functions run in the Electron main process. The module uses only Node.js
 * built-ins (https, fs, path, child_process) so it adds zero dependencies.
 *
 * The download URL is discovered by scraping the BepInEx Bleeding Edge builds
 * page. If the page format changes, _findDownloadUrl will throw and the error
 * is surfaced to the user — no silent failure.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app } = require('electron');

// ─── Constants ─────────────────────────────────────────────

const BEPINEX_BUILDS_URL = 'https://builds.bepinex.dev/projects/bepinex_be';
const ARTIFACT_PATTERN = /BepInEx-Unity\.IL2CPP-win-x64/i;
const REQUIRED_ITEMS = ['BepInEx', 'dotnet', 'doorstop_config.ini', 'winhttp.dll'];

// ─── Helpers ───────────────────────────────────────────────

/** Simple GET with manual redirect following. Returns { statusCode, headers, body }. */
function _httpsGet(url, timeoutMs = 15000, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const doGet = (target, redirectsLeft) => {
      const req = https.get(target, { timeout: timeoutMs }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          const redirectUrl = new URL(res.headers.location, target).toString();
          res.resume(); // drain response
          doGet(redirectUrl, redirectsLeft - 1);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('BEPINEX_HTTP_' + res.statusCode));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('BEPINEX_TIMEOUT')); });
    };

    doGet(url, maxRedirects);
  });
}

// ─── Self-reference for spy-able calls ─────────────────────
// Internal functions call each other through `api` so vitest can
// spyOn the exports and intercept cross-function calls in tests.
const api = module.exports;

// ─── Public API ────────────────────────────────────────────

/**
 * Check whether BepInEx is installed in the game root.
 * @param {string} gameRoot
 * @returns {{ installed: boolean, missing: string[] }}
 */
function checkStatus(gameRoot) {
  if (!gameRoot) return { installed: false, missing: REQUIRED_ITEMS };
  const missing = REQUIRED_ITEMS.filter((item) => !fs.existsSync(path.join(gameRoot, item)));
  return { installed: missing.length === 0, missing };
}

/**
 * Find the latest BepInEx IL2CPP Windows x64 download URL.
 * Scrapes the BepInEx Bleeding Edge builds listing page.
 * @returns {Promise<{ url: string, version: string }>}
 */
async function findDownloadUrl() {
  const { body } = await api._httpsGet(BEPINEX_BUILDS_URL);

  // Look for an <a> tag whose href contains the artifact pattern
  const hrefRegex = /href="([^"]*BepInEx-Unity\.IL2CPP-win-x64[^"]*\.zip)"/i;
  const match = body.match(hrefRegex);

  if (!match) {
    throw new Error('BEPINEX_ARTIFACT_NOT_FOUND');
  }

  const url = new URL(match[1], BEPINEX_BUILDS_URL).toString();

  // Extract version string from the filename
  const versionMatch = match[1].match(/BepInEx-Unity\.IL2CPP-win-x64-([^/]+)\.zip/);
  const version = versionMatch ? versionMatch[1] : 'unknown';

  return { url, version };
}

/**
 * Download a file from url to destPath, reporting progress.
 * @param {string} url
 * @param {string} destPath
 * @param {(pct: number) => void} onProgress
 * @returns {Promise<string>} destPath on success
 */
function downloadZip(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let received = 0;
    let total = 0;

    const doGet = (target, redirectsLeft) => {
      const req = https.get(target, { timeout: 30000 }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          const redirectUrl = new URL(res.headers.location, target).toString();
          res.resume();
          doGet(redirectUrl, redirectsLeft - 1);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          file.close();
          try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
          reject(new Error('BEPINEX_DOWNLOAD_HTTP_' + res.statusCode));
          return;
        }

        const contentLength = res.headers['content-length'];
        if (contentLength) total = parseInt(contentLength, 10);

        res.on('data', (chunk) => {
          received += chunk.length;
          file.write(chunk);
          if (total > 0) {
            const pct = Math.round((received / total) * 100);
            onProgress(pct);
          }
        });

        res.on('end', () => {
          file.end();
          resolve(destPath);
        });
      });

      req.on('error', (err) => {
        file.close();
        try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
        reject(err);
      });
      req.on('timeout', () => {
        req.destroy();
        file.close();
        try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
        reject(new Error('BEPINEX_DOWNLOAD_TIMEOUT'));
      });
    };

    doGet(url, 5);
  });
}

/**
 * Extract a ZIP archive to destDir using PowerShell Expand-Archive.
 * Windows-only — throws on other platforms.
 * @param {string} zipPath
 * @param {string} destDir
 * @returns {Promise<void>}
 */
function extractZip(zipPath, destDir) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('BEPINEX_WINDOWS_ONLY'));
  }

  return new Promise((resolve, reject) => {
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ], { timeout: 60000 }, (err) => {
      if (err) {
        reject(new Error('BEPINEX_EXTRACT_FAILED'));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Copy BepInEx files from extraction directory to game root.
 * The ZIP typically contains a single top-level folder with the 4 items inside.
 * Falls back to the extraction directory itself when there is no wrapping folder.
 * @param {string} extractDir
 * @param {string} gameRoot
 */
function installFiles(extractDir, gameRoot) {
  // Check if the required items exist directly in extractDir (flat structure)
  const hasRequiredItems = REQUIRED_ITEMS.some((item) => fs.existsSync(path.join(extractDir, item)));

  let sourceRoot;
  if (hasRequiredItems) {
    sourceRoot = extractDir;
  } else {
    // Find the first subdirectory (BepInEx ZIP wraps everything in one folder)
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    const subDir = entries.find((e) => e.isDirectory());
    sourceRoot = subDir ? path.join(extractDir, subDir.name) : extractDir;
  }

  for (const item of REQUIRED_ITEMS) {
    const src = path.join(sourceRoot, item);
    const dest = path.join(gameRoot, item);

    if (!fs.existsSync(src)) continue; // dotnet/ may not be present in some builds

    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * Remove BepInEx files from game root.
 * @param {string} gameRoot
 * @returns {{ removed: string[], errors: string[] }}
 */
function removeFiles(gameRoot) {
  const removed = [];
  const errors = [];

  for (const item of REQUIRED_ITEMS) {
    const target = path.join(gameRoot, item);
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(item);
      }
    } catch (err) {
      errors.push(item + ': ' + err.message);
    }
  }

  return { removed, errors };
}

/**
 * Full install pipeline: find URL → download → extract → copy.
 * Reports a single normalized 0-100% progress across all phases.
 *
 * @param {string} gameRoot
 * @param {(data: { percent: number, message: string }) => void} onProgress
 * @returns {Promise<{ success: boolean, version?: string, error?: string }>}
 */
async function installLatest(gameRoot, onProgress) {
  const tmpDir = path.join(app.getPath('temp'), 'ac27-bepinex-' + Date.now());

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // Phase 1: Fetch build URL (0-5%)
    onProgress({ percent: 2, message: 'bepinex_fetching' });
    const { url, version } = await api.findDownloadUrl();
    onProgress({ percent: 5, message: 'bepinex_downloading' });

    // Phase 2: Download (5-85%)
    const zipPath = path.join(tmpDir, 'bepinex.zip');
    await api.downloadZip(url, zipPath, (downloadPct) => {
      const normalized = 5 + Math.round(downloadPct * 0.80); // 5 + 0..80 = 5..85
      onProgress({ percent: normalized, message: 'bepinex_downloading' });
    });

    // Phase 3: Extract (85-93%)
    onProgress({ percent: 85, message: 'bepinex_extracting' });
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    await api.extractZip(zipPath, extractDir);
    onProgress({ percent: 93, message: 'bepinex_installing' });

    // Phase 4: Install files (93-100%)
    api.installFiles(extractDir, gameRoot);
    onProgress({ percent: 100, message: 'bepinex_installed' });

    return { success: true, version };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    // Always clean up temp files
    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

// ─── Exports ───────────────────────────────────────────────

Object.assign(api, {
  checkStatus,
  findDownloadUrl,
  downloadZip,
  extractZip,
  installFiles,
  removeFiles,
  installLatest,
  // Exported for testing
  _httpsGet,
});
