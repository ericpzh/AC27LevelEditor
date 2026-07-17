/**
 * Auto-Update — check for, download, and install new versions of AC27 Editor.
 *
 * All functions run in the Electron main process. The module uses only Node.js
 * built-ins (https, fs, path, crypto, child_process) so it adds zero dependencies.
 *
 * Update detection fetches a companion .md5 file stored alongside the exe in R2
 * and returns it as the ETag header. The Worker proxies HEAD to R2 and augments the
 * response with the real MD5. No version.json manifest needed.
 *
 * Platform gating: packaged builds must be Windows portable (PORTABLE_EXECUTABLE_FILE
 * set by the electron-builder portable launcher). macOS (DMG) is a no-op. Dev mode
 * (!app.isPackaged) skips the check by default so `npm start` never prompts —
 * opt in with AC27_UPDATE_DEV_CHECK=1 or AC27_UPDATE_TARGET to debug the flow
 * against a local build artifact (see resolveTargetExe); install is forced to
 * dry-run in dev.
 *
 * Every decision step is logged via log() — console + <userData>/updater.log.
 *
 * ## Env var overrides (for testing)
 *   AC27_UPDATE_SERVER    — base URL for update checks (default: https://ericpzh.rest/editor)
 *   AC27_UPDATE_DRY_RUN   — '1' skips actual spawn of updater.bat ('0' forces real install in dev)
 *   AC27_UPDATE_DEV_CHECK — dev only: '1' enables the check under npm start (auto-discovers a build artifact)
 *   AC27_UPDATE_TARGET    — dev only: explicit path to the exe whose MD5 is compared (also enables the check)
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

// ─── Logger ────────────────────────────────────────────────
// Packaged portable exes have no visible console, so every decision is also
// appended to <userData>/updater.log (best-effort — never blocks the app).

let _logPath = null;
function log(...args) {
  console.log(...args);
  try {
    if (!_logPath) _logPath = path.join(app.getPath('userData'), 'updater.log');
    fs.appendFileSync(_logPath, `[${new Date().toISOString()}] ${args.join(' ')}\n`, 'utf-8');
  } catch (_) { /* best-effort */ }
}

// ─── Constants ─────────────────────────────────────────────

const UPDATE_BASE = process.env.AC27_UPDATE_SERVER || 'https://ericpzh.rest/editor';
const HEAD_TIMEOUT = 10000;   // 10s — fail silent if no response
// In dev mode installUpdate() defaults to dry-run so the update .bat never
// swaps/relaunches dev files — opt in to a real install with AC27_UPDATE_DRY_RUN=0.
const DRY_RUN = app.isPackaged
  ? process.env.AC27_UPDATE_DRY_RUN === '1'
  : process.env.AC27_UPDATE_DRY_RUN !== '0';

// ─── Self-reference for spy-able calls ─────────────────────
const api = module.exports;

// ─── Platform gate ─────────────────────────────────────────

/**
 * Only Windows portable builds support auto-update.
 * macOS uses DMG distribution (no auto-update).
 * Dev mode (!app.isPackaged) also skips.
 * @returns {boolean}
 */
function isUpdateSupported() {
  return app.isPackaged
    && process.platform === 'win32'
    && !!process.env.PORTABLE_EXECUTABLE_FILE;
}

// ─── MD5 computation ──────────────────────────────────────

/**
 * Compute the MD5 hex digest of a file without loading it entirely into memory.
 * @param {string} filePath
 * @returns {Promise<string>} hex-encoded MD5
 */
function computeFileMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ─── Remote metadata ──────────────────────────────────────

/**
 * Send a HEAD request to the update server and return R2 object metadata.
 * The Worker fetches the real MD5 from the companion .md5 file and returns it
 * as the `etag` header, alongside last-modified and content-length from R2.
 * @returns {Promise<{ etag: string, lastModified: string|null, contentLength: number }>}
 */
function headRemoteExe() {
  return new Promise((resolve, reject) => {
    const req = https.request(UPDATE_BASE, { method: 'HEAD', timeout: HEAD_TIMEOUT }, (res) => {
      // Follow redirects — same pattern as bepinex._httpsGet
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, UPDATE_BASE).toString();
        res.resume();
        api.headRemoteExeWithUrl(redirectUrl).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error('UPDATE_HEAD_HTTP_' + res.statusCode));
        return;
      }

      resolve({
        etag: (res.headers.etag || '').replace(/^"|"$/g, ''),  // strip surrounding quotes
        lastModified: res.headers['last-modified'] || null,
        contentLength: parseInt(res.headers['content-length'] || '0', 10),
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('UPDATE_HEAD_TIMEOUT')); });
    req.end();
  });
}

/**
 * HEAD request to a specific URL (used for redirect targets).
 * @param {string} url
 * @returns {Promise<{ etag: string, lastModified: string|null, contentLength: number }>}
 */
function headRemoteExeWithUrl(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
      timeout: HEAD_TIMEOUT,
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error('UPDATE_HEAD_HTTP_' + res.statusCode));
        return;
      }
      resolve({
        etag: (res.headers.etag || '').replace(/^"|"$/g, ''),
        lastModified: res.headers['last-modified'] || null,
        contentLength: parseInt(res.headers['content-length'] || '0', 10),
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('UPDATE_HEAD_TIMEOUT')); });
    req.end();
  });
}

// ─── Update check ─────────────────────────────────────────

/**
 * Resolve the exe whose MD5 is compared against the remote build.
 * Packaged behavior is unchanged: PORTABLE_EXECUTABLE_FILE, else process.execPath.
 * Dev mode (!app.isPackaged): AC27_UPDATE_TARGET env var, else the first existing
 * known build artifact under the project root.
 * @returns {string|null} absolute path, or null if no candidate exists (dev only)
 */
function resolveTargetExe() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return process.env.PORTABLE_EXECUTABLE_FILE;
  if (app.isPackaged) return process.execPath;

  if (process.env.AC27_UPDATE_TARGET) return path.resolve(process.env.AC27_UPDATE_TARGET);

  const root = app.getAppPath(); // project root in dev
  const candidates = [
    path.join(root, 'release', 'AC27Editor.exe'),
    path.join(root, 'release', 'AC27LevelEditor.exe'), // older artifactName
    path.join(root, 'dist', 'AC27 Editor.exe'),
    path.join(root, 'dist', 'win-unpacked', 'AC27 Editor.exe'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/**
 * Check whether a newer version is available on the update server.
 *
 * Sends a HEAD request to get the remote ETag (real MD5 from companion .md5 file),
 * computes MD5 of the target exe (see resolveTargetExe), and compares.
 * Packaged decision logic is identical to isUpdateSupported(); the gate is inlined
 * here so every skip reason gets logged.
 *
 * @returns {Promise<{ hasUpdate: boolean, currentVersion?: string, currentMd5?: string, remoteMd5?: string, remoteDate?: string, contentLength?: number, error?: string }>}
 */
async function checkForUpdate() {
  log('[Updater] check start — platform:', process.platform,
    '| isPackaged:', app.isPackaged,
    '| PORTABLE_EXECUTABLE_FILE:', process.env.PORTABLE_EXECUTABLE_FILE || '(unset)',
    '| server:', UPDATE_BASE);

  if (process.platform !== 'win32') {
    log('[Updater] unsupported platform — skipping');
    return { hasUpdate: false };
  }
  if (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE) {
    log('[Updater] packaged but not portable (no PORTABLE_EXECUTABLE_FILE) — skipping');
    return { hasUpdate: false };
  }
  // Dev mode is opt-in: skip by default so `npm start` never prompts. Setting
  // AC27_UPDATE_TARGET (explicit exe) or AC27_UPDATE_DEV_CHECK=1 (auto-discover
  // a build artifact) re-enables the check for debugging.
  if (!app.isPackaged && process.env.AC27_UPDATE_DEV_CHECK !== '1' && !process.env.AC27_UPDATE_TARGET) {
    log('[Updater] dev mode — check disabled by default (set AC27_UPDATE_DEV_CHECK=1 or AC27_UPDATE_TARGET to enable) — skipping');
    return { hasUpdate: false };
  }

  const targetPath = resolveTargetExe();
  log('[Updater] target exe:', targetPath || '(none found)');
  if (!targetPath) {
    log('[Updater] dev mode: no build artifact to compare (set AC27_UPDATE_TARGET or run npm run build:win) — skipping');
    return { hasUpdate: false };
  }
  if (!fs.existsSync(targetPath)) {
    log('[Updater] target exe not found:', targetPath, '— skipping');
    return { hasUpdate: false };
  }

  try {
    const remote = await headRemoteExe();
    log('[Updater] HEAD ok — etag:', remote.etag,
      '| lastModified:', remote.lastModified,
      '| contentLength:', remote.contentLength);

    const localMd5 = await computeFileMd5(targetPath);
    log('[Updater] local MD5:', localMd5, '| remote MD5:', remote.etag, '| match:', localMd5 === remote.etag);

    // The Worker returns the real MD5 (from the companion .md5 file) as the ETag header.
    // We compare it directly against our locally computed MD5.
    if (localMd5 === remote.etag) {
      log('[Updater] up to date — no update');
      return { hasUpdate: false };
    }

    log('[Updater] Update available — local MD5:', localMd5, 'remote MD5:', remote.etag);

    return {
      hasUpdate: true,
      currentVersion: app.getVersion(),
      currentMd5: localMd5,
      remoteMd5: remote.etag,
      remoteDate: remote.lastModified,
      contentLength: remote.contentLength,
    };
  } catch (err) {
    // Network errors → fail silently, don't block the user
    log('[Updater] check failed:', err.message);
    return { hasUpdate: false, error: err.message };
  }
}

// ─── Download ─────────────────────────────────────────────

/**
 * Download the new exe from the update server with progress reporting.
 *
 * Progress is reported via `event.sender.send('update-download-progress', { percent })`.
 * Follows the same pattern as bepinex.downloadZip.
 *
 * @param {Electron.IpcMainEvent} event — the IPC event for progress pushes
 * @param {string} destDir — directory to write the new exe into
 * @returns {Promise<string>} path to the downloaded file
 */
function downloadUpdate(event, destDir) {
  return new Promise((resolve, reject) => {
    const exePath = path.join(destDir, 'AC27Editor_new.exe');
    const file = fs.createWriteStream(exePath);
    let received = 0;
    let total = 0;

    const notify = (percent) => {
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send('update-download-progress', { percent });
      }
    };

    const doGet = (target, redirectsLeft) => {
      const req = https.get(target, { timeout: 60000 }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          const redirectUrl = new URL(res.headers.location, target).toString();
          res.resume();
          doGet(redirectUrl, redirectsLeft - 1);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          file.close();
          try { fs.unlinkSync(exePath); } catch (_) { /* ignore */ }
          reject(new Error('UPDATE_DOWNLOAD_HTTP_' + res.statusCode));
          return;
        }

        const contentLength = res.headers['content-length'];
        if (contentLength) total = parseInt(contentLength, 10);

        res.on('data', (chunk) => {
          received += chunk.length;
          file.write(chunk);
          if (total > 0) {
            notify(Math.round((received / total) * 100));
          }
        });

        res.on('end', () => {
          file.end();
          resolve(exePath);
        });
      });

      req.on('error', (err) => {
        file.close();
        try { fs.unlinkSync(exePath); } catch (_) { /* ignore */ }
        reject(err);
      });
      req.on('timeout', () => {
        req.destroy();
        file.close();
        try { fs.unlinkSync(exePath); } catch (_) { /* ignore */ }
        reject(new Error('UPDATE_DOWNLOAD_TIMEOUT'));
      });
    };

    notify(0);
    doGet(UPDATE_BASE, 5);
  });
}

// ─── Install ──────────────────────────────────────────────

/**
 * Generate a Windows batch script that replaces the portable exe and relaunches.
 *
 * Strategy:
 *   1. Wait ~3s for the Electron app to fully exit
 *   2. Remove any stale .old file from a previous failed update
 *   3. Rename the running exe to .old (rename works on locked files, delete does not)
 *   4. Move/copy the new exe to the original path
 *   5. Launch the new version
 *   6. Best-effort cleanup of .old file and self-delete
 *
 * @param {string} updateDir — temp directory holding the downloaded exe
 * @param {string} currentExePath — full path to the currently running .exe
 * @param {string} newExePath — full path to the downloaded new .exe
 * @returns {string} path to the generated .bat script
 */
function createUpdaterScript(updateDir, currentExePath, newExePath) {
  const scriptPath = path.join(updateDir, 'update.bat');
  const currentDir = path.dirname(currentExePath);
  const currentExeName = path.basename(currentExePath);
  const oldExePath = path.join(currentDir, currentExeName + '.old');

  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    '',
    'REM ── AC27 Editor auto-updater ──',
    '',
    'REM Wait for parent Electron process to fully exit',
    'ping 127.0.0.1 -n 4 > nul',
    '',
    'REM Remove any stale .old from a previous failed update',
    'if exist "' + oldExePath + '" del "' + oldExePath + '"',
    '',
    'REM Rename current (locked) exe to .old',
    'rename "' + currentExePath + '" "' + currentExeName + '.old"',
    'if errorlevel 1 (',
    '  echo Failed to rename current exe — it may still be running',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'REM Place new exe at the original location',
    'move /Y "' + newExePath + '" "' + currentExePath + '"',
    'if errorlevel 1 (',
    '  echo Move failed, attempting copy...',
    '  copy /Y "' + newExePath + '" "' + currentExePath + '"',
    ')',
    '',
    'REM Launch the updated app',
    'start "" "' + currentExePath + '"',
    '',
    'REM Background cleanup',
    'ping 127.0.0.1 -n 4 > nul',
    'del "' + oldExePath + '" 2>nul',
    '',
    'REM Self-destruct',
    'del "%~f0"',
    '',
    'exit /b 0',
  ];

  fs.writeFileSync(scriptPath, lines.join('\r\n'), 'utf-8');
  return scriptPath;
}

/**
 * Install the update: generate batch script, spawn it detached, then quit the app.
 *
 * The batch script survives the app quitting because it's spawned with
 * `detached: true` and `windowsHide: true` via `cmd.exe /c start /MIN`.
 *
 * @param {string} updateDir — temp directory holding the downloaded exe
 * @param {string} currentExePath — full path to the currently running .exe
 * @param {string} newExePath — full path to the downloaded new .exe
 */
function installUpdate(updateDir, currentExePath, newExePath) {
  const scriptPath = createUpdaterScript(updateDir, currentExePath, newExePath);

  if (DRY_RUN) {
    log('[Updater] DRY RUN — would execute:', scriptPath);
    log('[Updater]   current:', currentExePath);
    log('[Updater]   new:    ', newExePath);
    return;
  }

  // Spawn the batch script detached so it survives app quit.
  // cmd.exe /c start "" /MIN <script> — opens a minimized cmd window, runs the script.
  const child = spawn('cmd.exe', ['/c', 'start', '', '/MIN', scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // Quit the app — the updater script handles the rest
  setImmediate(() => app.quit());
}

// ─── Exports ───────────────────────────────────────────────

Object.assign(api, {
  // Public API
  isUpdateSupported,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  createUpdaterScript,
  computeFileMd5,
  headRemoteExe,
  headRemoteExeWithUrl,
  resolveTargetExe,
  log,
});
