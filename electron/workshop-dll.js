// ─── Workshop-bundled AC27Approach.dll resolution ───────────
// Extracted from main.js so the candidate order is unit-testable without
// booting Electron (see tests/electron/workshop-dll.test.js).
//
// The Workshop distribution contains AC27Approach.dll in up to four places:
//   (a) as a sibling alongside AC27EditorWorkshop.exe inside the Steam Workshop
//       content item (.../workshop/content/3328490/3806070599/AC27Approach.dll
//       — copied by the release workflow);
//   (b) as an extraResource bundled inside resources/ (resources/AC27Approach.dll)
//       when built via `node build.js --workshop` with the plugin artifact present;
//   (c) under the sibling Steam library layout, reachable from the game root;
//   (d) as an explicit dev/test override via AC27_WORKSHOP_DIR.
//
// Resolution order (first existing path wins):
//   1. AC27_WORKSHOP_DIR override — explicit, so it always wins when set.
//   2. Game-root-relative Workshop item dir — walk up from the game root to the
//      sibling steamapps/workshop/content (livery.workshopContentDir, the same
//      discovery the livery list uses), then append <appid>/<publishedfileid>/.
//      This is exe-independent: the game root is the user's selected install, so
//      a moved/renamed/temp-unpacked exe still resolves.
//   3. resources/AC27Approach.dll — bundled inside the exe at build time, so it
//      survives moving the exe alone.
//   4. <exe-dir>/AC27Approach.dll — legacy fallback. Portable builds set
//      PORTABLE_EXECUTABLE_FILE to the real exe location; app.getPath('exe') and
//      process.execPath can point to a temp unpack dir (electron-builder portable
//      unpacks to %TEMP%), so all three are tried.
// If none exist, the caller returns WORKSHOP_BUNDLED_MISSING → the renderer opens
// the manual load-approach-dll dialog.

const fs = require('fs');
const path = require('path');
const updater = require('./updater');
const livery = require('./livery');
const { STEAM_APP_ID, STEAM_PUBLISHED_FILE_ID } = require('../src/utils/constants/steam.js');

const DLL_NAME = 'AC27Approach.dll';

/**
 * Resolve the AC27Approach.dll that ships with the Workshop item.
 * @param {string|null|undefined} gameRoot - the cached game root, used for the
 *   exe-independent Workshop item path (step 2). May be null.
 * @returns {string|null} the first existing candidate path, or null.
 */
function resolveWorkshopBundledDllPath(gameRoot) {
  if (!updater.isWorkshopBuild()) return null;
  const candidates = [];
  // 1. Explicit dev/test override: `npm start steam <workshop-path>` sets
  //    AC27_WORKSHOP_DIR to the Workshop content dir (or the exe inside it) so
  //    the bundled DLL resolves without a packaged exe (scripts/dev-start.mjs).
  try {
    const dir = process.env.AC27_WORKSHOP_DIR;
    if (dir) {
      let d = dir;
      try { if (fs.statSync(d).isFile()) d = path.dirname(d); } catch (_) {}
      candidates.push(path.join(d, DLL_NAME));
    }
  } catch (_) {}
  // 2. Game-root-relative Workshop item dir (exe-independent). livery's
  //    workshopContentDir walks up from the game root to the sibling
  //    steamapps/workshop/content dir; append the editor's own app/item ids.
  try {
    const contentDir = gameRoot && livery.workshopContentDir(gameRoot);
    if (contentDir) {
      candidates.push(path.join(contentDir, STEAM_APP_ID, STEAM_PUBLISHED_FILE_ID, DLL_NAME));
    }
  } catch (_) {}
  // 3. Bundled inside the exe (build.js --workshop extraResource).
  try {
    if (typeof process.resourcesPath === 'string') {
      candidates.push(path.join(process.resourcesPath, DLL_NAME));
    }
  } catch (_) {}
  // 4. Legacy <exe-dir> fallback: the user may have moved/copied the exe.
  //    Portable remembers the launch location in PORTABLE_EXECUTABLE_FILE;
  //    otherwise process.execPath or app.getPath('exe') is the best guess.
  const exeSet = new Set();
  try { if (process.env.PORTABLE_EXECUTABLE_FILE) exeSet.add(process.env.PORTABLE_EXECUTABLE_FILE); } catch (_) {}
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const ap = app.getPath('exe');
      if (ap) exeSet.add(ap);
    }
  } catch (_) {}
  try { if (process.execPath) exeSet.add(process.execPath); } catch (_) {}
  for (const exe of exeSet) {
    try { if (exe) candidates.push(path.join(path.dirname(exe), DLL_NAME)); } catch (_) {}
  }
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

module.exports = { resolveWorkshopBundledDllPath, DLL_NAME };
