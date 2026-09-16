// ─── Custom livery pack helpers (own pack dir) ──────────────
// Pure CommonJS logic for the livery IPC handlers in main.js.
// Renderer source of truth for the table: src/utils/constants/livery.js
// (ESM — values duplicated here because main is CommonJS; keep in sync).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createZip, listZipFiles, extractZip } = require('../src/utils/zipUtils');

const OWN_PACK = 'AC27 Custom Liveries';
const REFERENCE_PACK = 'AC27 Realistic Aircraft Livery';
const SHORT_CODE_TO_PLANE_ID = {
  A19N: 'AIRBUS A-319neo', A20N: 'AIRBUS A-320neo', A21N: 'AIRBUS A-321neo',
  A319: 'AIRBUS A-319ceo', A320: 'AIRBUS A-320ceo', A333: 'AIRBUS A-330-300',
  A359: 'AIRBUS A-350-900', A388: 'AIRBUS A-380-800', B38M: 'BOEING 737 MAX 8',
  B738: 'BOEING 737-800', B748: 'BOEING 747-8I', B77W: 'BOEING 777-300ER',
  B789: 'BOEING 787-9', C919: 'COMAC C-919',
};
const LIVERY_FOLDER_RE = /^[A-Z0-9]{3,4}_[A-Z]{3}$/;
const AIRLINE_RE = /^[A-Z]{3}$/;
const TEXTURE_SIZE = 2048;

function ownPackDir(gameRoot) { return path.join(gameRoot, 'Mods', OWN_PACK); }
function referencePackDir(gameRoot) { return path.join(gameRoot, 'Mods', REFERENCE_PACK); }
function ensureOwnPackDir(gameRoot) {
  const dir = ownPackDir(gameRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Returns the absolute folder path if `folder` stays inside packDir, else null.
function containmentCheck(packDir, folder) {
  const resolved = path.resolve(packDir, String(folder));
  const rel = path.relative(path.resolve(packDir), resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

// Read PNG IHDR width/height at bytes 16-23. Returns {width,height} or null.
function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47 ||
      buf[4] !== 0x0D || buf[5] !== 0x0A || buf[6] !== 0x1A || buf[7] !== 0x0A) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function buildManifest({ folder, shortCode, airline, targetPlaneId }) {
  return {
    id: `${String(folder).toLowerCase()}_default`,
    name: `${shortCode} ${airline} Default Livery`,
    airline,
    targetPlaneId,
    liveryType: 'airline',
    liverySource: 'user',
    targetModelVer: '1',
    parts: [{ partName: 'Body', textures: [{ property: 'BaseMap', fileName: 'base.png' }] }],
  };
}

function readLiveryRow(packDir, folder) {
  const dir = path.join(packDir, folder);
  let mtime = 0;
  try { mtime = fs.statSync(dir).mtimeMs; } catch (_) {}
  const manifestPath = path.join(dir, 'aircraft_livery_manifest.json');
  const hasBasePng = fs.existsSync(path.join(dir, 'base.png'));
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return { folder, id: m.id || '', name: m.name || '', airline: m.airline || '', targetPlaneId: m.targetPlaneId || '', hasBasePng, mtime };
  } catch (_) {
    return { folder, id: '', name: '', airline: '', targetPlaneId: '', hasBasePng, mtime, error: 'BAD_MANIFEST' };
  }
}

// Corrupt manifest → row with error, never abort.
function listPackDir(packDir) {
  if (!packDir || !fs.existsSync(packDir)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(packDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { rows.push(readLiveryRow(packDir, entry.name)); }
    catch (_) { rows.push({ folder: entry.name, id: '', name: '', airline: '', targetPlaneId: '', hasBasePng: false, mtime: 0, error: 'BAD_MANIFEST' }); }
  }
  rows.sort((a, b) => a.folder.localeCompare(b.folder));
  return rows;
}

function listLiveries(gameRoot) {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  try {
    return {
      success: true,
      mine: listPackDir(ownPackDir(gameRoot)),
      reference: listPackDir(referencePackDir(gameRoot)),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function readLiveryImage(gameRoot, folder, pack = 'mine') {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const packDir = pack === 'reference' ? referencePackDir(gameRoot) : ownPackDir(gameRoot);
  const resolved = containmentCheck(packDir, folder || '');
  if (!resolved) return { success: false, error: 'BAD_FOLDER' };
  try {
    const buf = fs.readFileSync(path.join(resolved, 'base.png'));
    return { success: true, imageDataUrl: 'data:image/png;base64,' + buf.toString('base64') };
  } catch (_) {
    return { success: false, error: 'IMAGE_MISSING' };
  }
}

function createLivery(gameRoot, { imageDataUrl, airline, targetPlaneId, shortCode }) {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  if (!AIRLINE_RE.test(String(airline || ''))) return { success: false, error: 'BAD_AIRLINE' };
  if (!SHORT_CODE_TO_PLANE_ID[shortCode] || SHORT_CODE_TO_PLANE_ID[shortCode] !== targetPlaneId) {
    return { success: false, error: 'BAD_PLANE' };
  }
  const folder = `${shortCode}_${airline}`;
  if (!LIVERY_FOLDER_RE.test(folder)) return { success: false, error: 'BAD_AIRLINE' };
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(imageDataUrl || ''));
  if (!m) return { success: false, error: 'BAD_IMAGE' };
  let buf;
  try { buf = Buffer.from(m[1], 'base64'); }
  catch (_) { return { success: false, error: 'BAD_IMAGE' }; }
  const size = pngSize(buf);
  if (!size || size.width !== TEXTURE_SIZE || size.height !== TEXTURE_SIZE) {
    return { success: false, error: 'BAD_IMAGE_DIMENSIONS' };
  }
  try {
    const packDir = ensureOwnPackDir(gameRoot);
    const resolved = containmentCheck(packDir, folder);
    if (!resolved) return { success: false, error: 'BAD_FOLDER' };
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    // Silent overwrite — no .bak, no confirm (locked decision §0.4).
    fs.writeFileSync(path.join(resolved, 'base.png'), buf);
    fs.writeFileSync(
      path.join(resolved, 'aircraft_livery_manifest.json'),
      JSON.stringify(buildManifest({ folder, shortCode, airline, targetPlaneId }), null, 2),
      'utf-8',
    );
    return { success: true, folder };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Own-pack only — reference pack is read-only (no pack arg on purpose).
function deleteLivery(gameRoot, folder) {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const resolved = containmentCheck(ownPackDir(gameRoot), folder || '');
  if (!resolved) return { success: false, error: 'BAD_FOLDER' };
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function readDiskImage(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'IMAGE_MISSING' };
    const ext = path.extname(String(filePath)).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : null);
    if (!mime) return { success: false, error: 'BAD_IMAGE' };
    const buf = fs.readFileSync(filePath);
    return { success: true, imageDataUrl: `data:${mime};base64,` + buf.toString('base64') };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Share / load (P3) ──────────────────────────────────────

// Zip {manifest, base.png} to a temp <folder>.zip for the save dialog.
// Entries are prefixed with the folder name so the recipient can unzip
// straight into <gameRoot>/Mods/<OWN_PACK>/ (share contract).
function exportLivery(gameRoot, folder) {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const resolved = containmentCheck(ownPackDir(gameRoot), folder || '');
  if (!resolved) return { success: false, error: 'BAD_FOLDER' };
  try {
    const manifestRaw = fs.readFileSync(path.join(resolved, 'aircraft_livery_manifest.json'));
    const pngBuf = fs.readFileSync(path.join(resolved, 'base.png'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-livery-export-'));
    const zipPath = path.join(tmpDir, `${folder}.zip`);
    createZip([
      { name: `${folder}/aircraft_livery_manifest.json`, data: manifestRaw },
      { name: `${folder}/base.png`, data: pngBuf },
    ], zipPath);
    return { success: true, filePath: zipPath };
  } catch (err) {
    return { success: false, error: err.message && err.message.includes('ENOENT') ? 'IMAGE_MISSING' : err.message };
  }
}

function _cleanExportTemp(sourcePath) {
  try {
    const parent = path.dirname(String(sourcePath));
    if (path.basename(parent).includes('ac27-livery-export-')) {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  } catch (_) {}
}

// Copy the temp export zip to its final destination + clean the temp dir.
function copyExportedZip(sourcePath, destPath) {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath)) return { success: false, error: 'ZIP_MISSING' };
    if (!destPath) return { success: false, error: 'BAD_PATH' };
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(sourcePath, destPath);
    _cleanExportTemp(sourcePath);
    return { success: true, filePath: destPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Parse a shared livery zip → {folder, manifest, shortCode, imageDataUrl} for
// the install preview. Extracts to temp, reads into memory, cleans up.
function loadLiveryZip(zipPath) {
  if (!zipPath || !fs.existsSync(zipPath)) return { success: false, error: 'ZIP_MISSING' };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-livery-load-'));
  try {
    let names;
    try {
      names = listZipFiles(zipPath);
    } catch (_) {
      return { success: false, error: 'BAD_ZIP' };
    }
    const manifestEntry = names.find(n => n.replace(/\\/g, '/').endsWith('aircraft_livery_manifest.json'));
    if (!manifestEntry) return { success: false, error: 'BAD_ZIP' };
    extractZip(zipPath, tmpDir);
    const norm = manifestEntry.replace(/\\/g, '/');
    const manifestDir = path.posix.dirname(norm);
    const absDir = manifestDir === '.' ? tmpDir : path.join(tmpDir, manifestDir);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(absDir, 'aircraft_livery_manifest.json'), 'utf-8'));
    } catch (_) {
      return { success: false, error: 'BAD_MANIFEST' };
    }
    const texName = (manifest.parts && manifest.parts[0] && manifest.parts[0].textures &&
      manifest.parts[0].textures[0] && manifest.parts[0].textures[0].fileName) || 'base.png';
    let texBuf;
    try {
      texBuf = fs.readFileSync(path.join(absDir, path.basename(texName)));
    } catch (_) {
      return { success: false, error: 'IMAGE_MISSING' };
    }
    const folder = manifestDir === '.' ? path.basename(String(zipPath), path.extname(String(zipPath))) : path.basename(manifestDir);
    const shortCode = String(folder).split('_')[0] || '';
    return {
      success: true,
      folder,
      shortCode,
      manifest,
      imageDataUrl: 'data:image/png;base64,' + texBuf.toString('base64'),
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  OWN_PACK,
  REFERENCE_PACK,
  SHORT_CODE_TO_PLANE_ID,
  LIVERY_FOLDER_RE,
  AIRLINE_RE,
  TEXTURE_SIZE,
  ownPackDir,
  referencePackDir,
  ensureOwnPackDir,
  containmentCheck,
  pngSize,
  buildManifest,
  listPackDir,
  listLiveries,
  readLiveryImage,
  createLivery,
  deleteLivery,
  readDiskImage,
  exportLivery,
  copyExportedZip,
  loadLiveryZip,
};
