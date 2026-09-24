// ─── Custom livery pack helpers (own pack dir) ──────────────
// Pure CommonJS logic for the livery IPC handlers in main.js.
// Renderer source of truth for the table: src/utils/constants/livery.js
// (ESM — values duplicated here because main is CommonJS; keep in sync).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createZip, listZipFiles, extractZip } = require('../src/utils/zipUtils');
const { ddsToPngDataUrl } = require('./dds');
const { STEAM_WORKSHOP_SEGMENT, STEAM_WORKSHOP_CONTENT_SEGMENT, STEAM_APP_ID } = require('../src/utils/constants/steam.js');
const gamePaths = require('../src/utils/gamePaths');

const OWN_PACK = 'AC27 Custom Liveries';
const REFERENCE_PACK = 'AC27 Realistic Aircraft Livery';
// The game ships one neutral default livery per aircraft type — the exact UV
// atlas the model expects. The painter seeds new canvases with this so the
// background is never transparent and each aircraft gets its real shape.
// Located per-OS via gamePaths (Windows/Linux `<root>/GroundATC_Data/...`,
// macOS inside `GroundATC.app/Contents/Resources/...`).
// The game treats a folder under Mods/ as a mod only when it carries a
// mod_info.json. The official pack zip ships one inside our own folder that
// still names the *reference* pack, so we (re)write ours on every save/load.
// Field set mirrors the working reference mod (modName + localized names).
const OWN_PACK_MOD_INFO = {
  modName: 'AC27_Custom_Liveries',
  modNameEn: 'AC27 Custom Liveries',
  modNameZhHans: 'AC27 自定义涂装',
  modDescriptionEn: 'Custom aircraft liveries created with the AC27 Editor.',
  modDescriptionZhHans: '使用 AC27 关卡编辑器创建的自定义飞机涂装。',
};
const SHORT_CODE_TO_PLANE_ID = {
  A19N: 'AIRBUS A-319neo', A20N: 'AIRBUS A-320neo', A21N: 'AIRBUS A-321neo',
  A319: 'AIRBUS A-319ceo', A320: 'AIRBUS A-320ceo', A333: 'AIRBUS A-330-300',
  A359: 'AIRBUS A-350-900', A388: 'AIRBUS A-380-800', B38M: 'BOEING 737 MAX 8',
  B738: 'BOEING 737-800', B748: 'BOEING 747-8I', B77W: 'BOEING 777-300ER',
  B789: 'BOEING 787-9', CRJ7: 'BOMBARDIER CRJ700', CRJ9: 'BOMBARDIER CRJ900',
  C750: 'CESSNA CITATION X', C919: 'COMAC C-919', E170: 'EMBRAER E-JET 170',
  E190: 'EMBRAER E-JET 190', GLF6: 'GULFSTREAM 650',
};
// The manifest's targetPlaneId is the source of truth; the short code is only
// a display convenience derived from it — never from the folder name.
const PLANE_ID_TO_SHORT_CODE = Object.fromEntries(
  Object.entries(SHORT_CODE_TO_PLANE_ID).map(([code, id]) => [id, code]),
);
const LIVERY_FOLDER_SAFE_RE = /^(?![.\s])(?!.*[.\s]$)(?!.*[<>:"/\\|?*\x00-\x1f]).{1,64}$/;
const AIRLINE_RE = /^[A-Z]{3}$/;
const TEXTURE_SIZE = 2048;
// List-view preview size: the cards render at ~220px wide (2:1 box,
// object-fit contain), so a 256px thumbnail is visually identical to the
// full 2048px texture at a fraction of the IPC + GPU decode cost.
const THUMBNAIL_SIZE = 256;
// In-memory thumbnail cache: key `${imagePath}:${mtimeMs}` → data-URL.
// Bounded (FIFO evict past 300) — a full reference-pack scan is ~100 rows.
const _thumbCache = new Map();
const _THUMB_CACHE_MAX = 300;

function ownPackDir(gameRoot) { return path.join(gamePaths.modsDir(gameRoot), OWN_PACK); }
function referencePackDir(gameRoot) { return path.join(gamePaths.modsDir(gameRoot), REFERENCE_PACK); }

// ─── Steam Workshop discovery (best-effort) ─────────────────
// Workshop content lives at <SteamLibrary>/steamapps/workshop/content/<appid>/
// <publishedfileid>/. The game root is <SteamLibrary>/steamapps/common/<game>,
// so we walk up from it looking for a sibling `workshop/content` directory.
// Returns null on a non-Steam layout (dev/portable installs, other stores) —
// callers degrade to an empty workshop list.
function workshopContentDir(gameRoot) {
  if (!gameRoot) return null;
  let dir;
  try { dir = path.resolve(String(gameRoot)); } catch (_) { return null; }
  for (let i = 0; i < 6; i++) {
    try {
      const content = path.join(dir, STEAM_WORKSHOP_SEGMENT, STEAM_WORKSHOP_CONTENT_SEGMENT);
      if (fs.existsSync(content)) return content;
    } catch (_) {}
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

function _hasLiveryManifest(dir) {
  try { return fs.existsSync(path.join(dir, 'aircraft_livery_manifest.json')); } catch (_) { return false; }
}

// Depth-bounded scan for livery folders (any directory holding an
// aircraft_livery_manifest.json) under a workshop item. A found livery folder
// is not descended into (liveries never nest). `relPrefix` is the '/'-joined
// path relative to the item root.
function _collectWorkshopLiveryDirs(rootDir, relPrefix, out, depth) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name === 'AircraftDefaultLivery') continue;
    const abs = path.join(rootDir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (_hasLiveryManifest(abs)) { out.push(rel); continue; }
    _collectWorkshopLiveryDirs(abs, rel, out, depth + 1);
  }
}

// Every livery found under the configured app's Steam Workshop content, as rows
// whose `folder` is the '/'-joined path relative to workshop/content (e.g.
// "3328490/123456789/A20N_CCA") — resolved back to disk by the read helpers
// via the same base directory. Only the app we publish under (STEAM_APP_ID) is
// scanned: an appid folder for another app (e.g. the retired Playtest app) is
// not content the user owns, so it is treated as nonexistent. Best-effort: any
// I/O failure yields [].
// A short-TTL cache keyed by the content dir + app id keeps the walk off every
// list refresh (the renderer refetches on each livery-page open).
let _workshopListCache = { key: '', at: 0, rows: null };
const _WORKSHOP_LIST_TTL_MS = 10000;
function listWorkshopLiveries(gameRoot) {
  const contentDir = workshopContentDir(gameRoot);
  if (!contentDir) return [];
  const cacheKey = `${contentDir}\n${STEAM_APP_ID}`;
  const now = Date.now();
  if (_workshopListCache.key === cacheKey && now - _workshopListCache.at < _WORKSHOP_LIST_TTL_MS) {
    return _workshopListCache.rows;
  }
  const rows = [];
  const appDir = path.join(contentDir, STEAM_APP_ID);
  let items;
  try { items = fs.readdirSync(appDir, { withFileTypes: true }); } catch (_) {
    _workshopListCache = { key: cacheKey, at: now, rows };
    return rows;
  }
  for (const item of items) {
    if (!item.isDirectory() || item.name.startsWith('.')) continue;
    const itemDir = path.join(appDir, item.name);
    const rels = [];
    // The item root may itself be a livery folder, a pack of liveries, or a
    // mod wrapper (Mods/<pack>/<livery>).
    if (_hasLiveryManifest(itemDir)) rels.push('');
    else _collectWorkshopLiveryDirs(itemDir, '', rels, 0);
    for (const rel of rels) {
      const folder = rel ? `${STEAM_APP_ID}/${item.name}/${rel}` : `${STEAM_APP_ID}/${item.name}`;
      try { rows.push(readLiveryRow(contentDir, folder)); } catch (_) {
        rows.push({ folder, id: '', name: '', airline: '', targetPlaneId: '', hasBasePng: false, mtime: 0, error: 'BAD_MANIFEST' });
      }
    }
  }
  rows.sort((a, b) => a.folder.localeCompare(b.folder));
  _workshopListCache = { key: cacheKey, at: now, rows };
  return rows;
}

// Resolve the on-disk base directory for a pack id. 'workshop' rows carry a
// path-relative folder under the Steam Workshop content root.
function _packDir(gameRoot, pack) {
  if (pack === 'reference') return referencePackDir(gameRoot);
  if (pack === 'workshop') return workshopContentDir(gameRoot);
  return ownPackDir(gameRoot);
}

// Absolute path of a stored livery folder for "open in file explorer", or
// null when the pack/base dir or the folder itself is missing/out of bounds.
function resolvePackFolder(gameRoot, folder, pack = 'mine') {
  if (!gameRoot || !folder) return null;
  const packDir = _packDir(gameRoot, pack);
  if (!packDir) return null;
  const resolved = containmentCheck(packDir, folder);
  if (!resolved) return null;
  try { return fs.existsSync(resolved) ? resolved : null; } catch (_) { return null; }
}

// Does the game ship a built-in default livery for this plane id? The folder
// name IS the plane id, and its manifest confirms it is a real livery.
function hasBuiltInTemplate(gameRoot, planeId) {
  if (!gameRoot || !planeId) return false;
  try {
    return fs.existsSync(path.join(
      gamePaths.builtinLiveryDir(gameRoot), String(planeId), 'aircraft_livery_manifest.json',
    ));
  } catch (_) {
    return false;
  }
}

// Writes our mod_info.json when it is missing, unreadable or still carries a
// foreign modName (the reference pack's). Best-effort: never throws, so a
// read-only game dir can't break listing/creating.
function ensureModInfo(packDir) {
  const file = path.join(packDir, 'mod_info.json');
  try {
    const current = _readJsonFile(file, 'utf-8');
    if (current && current.modName === OWN_PACK_MOD_INFO.modName) return true;
  } catch (_) {}
  try {
    fs.writeFileSync(file, JSON.stringify(OWN_PACK_MOD_INFO, null, 2) + '\n', 'utf-8');
    return true;
  } catch (_) {
    return false;
  }
}

function ensureOwnPackDir(gameRoot) {
  const dir = ownPackDir(gameRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  ensureModInfo(dir);
  return dir;
}

// Workshop/subscriber manifests are often saved with a UTF-8 BOM — strip it
// before JSON.parse (a leading U+FEFF otherwise throws and the row degrades
// to BAD_MANIFEST / unknown aircraft).
function _parseJsonText(raw) {
  return JSON.parse(String(raw == null ? '' : raw).replace(/^\uFEFF/, ''));
}
function _readJsonFile(file) {
  return _parseJsonText(fs.readFileSync(file, 'utf-8'));
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

// The on-disk BaseMap file name for a part. Single-part liveries keep the
// legacy `base.png`; multi-part types (A388/B38M) use the game's own
// `base_<Part>.png` convention (base_Fuselage.png + base_Wing.png).
function baseFileName(partName, totalParts) {
  if (!totalParts || totalParts <= 1) return 'base.png';
  const safe = String(partName || '').replace(/[^A-Za-z0-9]/g, '');
  return safe ? `base_${safe}.png` : 'base.png';
}

// Build the game's livery manifest. `parts` (when given) is an ordered list of
// `{partName, fileName}` BaseMap bindings — one per painted panel; otherwise a
// single part from `partName`/`base.png` is emitted (legacy/single-part types).
function buildManifest({ folder, shortCode, airline, targetPlaneId, partName, parts, targetModelVer }) {
  // Free-form folders can contain spaces/symbols — sanitize for the id.
  // No-op for conventional SHORT_AIRLINE folders (a20n_cca_default as before).
  const safeId = String(folder).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'livery';
  // partName must match the aircraft's built-in main part (Body vs Fuselage)
  // or the game ignores the texture — A388/B38M use Fuselage.
  const body = partName || 'Body';
  // targetModelVer must match the aircraft's built-in model version or the
  // game flags the livery as broken — the C919 model bumped 1→2 while every
  // other type is still 1. The caller (createLivery) resolves it from the
  // built-in manifest; default '1' keeps this pure helper backward compatible.
  const ver = targetModelVer == null || targetModelVer === '' ? '1' : String(targetModelVer);
  const manifestParts = Array.isArray(parts) && parts.length
    ? parts.map(p => ({
      partName: (p && p.partName) || 'Body',
      textures: [{ property: 'BaseMap', fileName: (p && p.fileName) || 'base.png' }],
    }))
    : [{ partName: body, textures: [{ property: 'BaseMap', fileName: 'base.png' }] }];
  return {
    id: `${safeId}_default`,
    name: `${shortCode} ${airline} Default Livery`,
    airline,
    targetPlaneId,
    liveryType: 'airline',
    liverySource: 'user',
    targetModelVer: ver,
    parts: manifestParts,
  };
}

// The manifest's targetPlaneId is the source of truth; the short code is only
// a display convenience derived from it — never from the folder name.
function _pickMainPartRef(parts) {
  if (!Array.isArray(parts)) return null;
  return parts.find(p => p && p.partName === 'Body')
    || parts.find(p => p && p.partName === 'Fuselage')
    || parts[0] || null;
}

// Main-part BaseMap reference from a manifest ({partName, fileName} or null).
function _mainPartBaseFile(manifest) {
  const part = _pickMainPartRef(manifest && manifest.parts);
  const tex = part && Array.isArray(part.textures)
    ? part.textures.find(t => t && t.property === 'BaseMap' && t.fileName)
    : null;
  return tex ? { partName: part.partName, fileName: tex.fileName } : null;
}

// Resolve the paintable BaseMap file inside a livery folder: the manifest's
// main-part BaseMap first (A388/B38M ship base_Fuselage.png, not base.png),
// then any other part's BaseMap, then the legacy single-file base.png.
function _resolveLiveryImagePath(dir) {
  try {
    const m = _readJsonFile(path.join(dir, 'aircraft_livery_manifest.json'), 'utf-8');
    const main = _mainPartBaseFile(m);
    if (main) {
      const p = path.join(dir, path.basename(main.fileName));
      if (fs.existsSync(p)) return { path: p, partName: main.partName };
    }
    if (m && Array.isArray(m.parts)) {
      for (const part of m.parts) {
        const tex = part && Array.isArray(part.textures)
          ? part.textures.find(t => t && t.property === 'BaseMap' && t.fileName)
          : null;
        if (tex) {
          const p = path.join(dir, path.basename(tex.fileName));
          if (fs.existsSync(p)) return { path: p, partName: part && part.partName };
        }
      }
    }
  } catch (_) {}
  const legacy = path.join(dir, 'base.png');
  if (fs.existsSync(legacy)) return { path: legacy, partName: null };
  return null;
}

// The game's built-in default livery manifest for this aircraft, or null.
// Single reader behind _builtInMainPartName + _builtInTargetModelVer so a
// model bump (e.g. C919 1→2) is picked up in exactly one place.
function _readBuiltInManifest(gameRoot, planeId) {
  try {
    if (!gameRoot || !planeId) return null;
    return _readJsonFile(
      path.join(gamePaths.builtinLiveryDir(gameRoot), String(planeId), 'aircraft_livery_manifest.json'),
      'utf-8',
    );
  } catch (_) {
    return null;
  }
}

// The built-in default livery's model version for this aircraft. Custom
// liveries must carry the same value or the game flags them as broken.
// Falls back to '1' when the built-in manifest is missing/unreadable (every
// type but C919 is still 1, and old tests seed no built-in dir).
function _builtInTargetModelVer(gameRoot, planeId) {
  try {
    const m = _readBuiltInManifest(gameRoot, planeId);
    const v = m && m.targetModelVer;
    if (v == null || v === '') return '1';
    const s = String(v);
    return s || '1';
  } catch (_) {
    return '1';
  }
}

// The built-in default livery's main part name for this aircraft (Body for
// most types, Fuselage for multi-part A388/B38M). Custom liveries must reuse
// it or the game ignores the painted texture.
function _builtInMainPartName(gameRoot, planeId) {
  try {
    const manifest = _readBuiltInManifest(gameRoot, planeId);
    const part = _pickMainPartRef(manifest && manifest.parts);
    if (part && part.partName) return part.partName;
  } catch (_) {}
  return 'Body';
}

// Ordered list of every paintable BaseMap binding in a manifest:
// `[{partName, fileName}]` (A388 → Fuselage + Wing, B38M → Fuselage + Wingtip,
// everything else → a single part). Parts without a BaseMap file are skipped.
function _basePartsFromManifest(manifest) {
  const out = [];
  if (manifest && Array.isArray(manifest.parts)) {
    for (const part of manifest.parts) {
      const tex = part && Array.isArray(part.textures)
        ? part.textures.find(t => t && t.property === 'BaseMap' && t.fileName)
        : null;
      if (tex) out.push({ partName: (part && part.partName) || 'Body', fileName: tex.fileName });
    }
  }
  return out;
}

// The built-in default's BaseMap bindings for this aircraft (source of truth
// for how many painter panels a type needs).
function _builtInBaseParts(gameRoot, planeId) {
  return _basePartsFromManifest(_readBuiltInManifest(gameRoot, planeId));
}

// Decode a texture file to a data-URL: DDS through the DXT decoder (Y-flipped
// to the engine orientation), PNG/JPEG verbatim. Returns null on failure.
function _decodeTextureFile(file) {
  try {
    const buf = fs.readFileSync(file);
    if (/\.dds$/i.test(file)) return ddsToPngDataUrl(buf);
    const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,` + buf.toString('base64');
  } catch (_) {
    return null;
  }
}

function readLiveryRow(packDir, folder) {
  const dir = path.join(packDir, folder);
  let mtime = 0;
  try { mtime = fs.statSync(dir).mtimeMs; } catch (_) {}
  const hasBasePng = Boolean(_resolveLiveryImagePath(dir));
  try {
    const m = _readJsonFile(path.join(dir, 'aircraft_livery_manifest.json'), 'utf-8');
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
    try { ensureOwnPackDir(gameRoot); } catch (_) {}
    return {
      success: true,
      mine: listPackDir(ownPackDir(gameRoot)),
      reference: listPackDir(referencePackDir(gameRoot)),
      workshop: listWorkshopLiveries(gameRoot),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Every aircraft the game ships a built-in default livery for — the source of
// truth for the painter's aircraft-type dropdown. The folder name IS the game's
// plane id; the short code is a display/naming convenience derived from it.
function listAircraftTypes(gameRoot) {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const dir = gamePaths.builtinLiveryDir(gameRoot);
  const types = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!hasBuiltInTemplate(gameRoot, entry.name)) continue;
      types.push({ planeId: entry.name, shortCode: PLANE_ID_TO_SHORT_CODE[entry.name] || '' });
    }
  } catch (_) {
    return { success: true, types: [] };
  }
  types.sort((a, b) => a.planeId.localeCompare(b.planeId));
  return { success: true, types };
}

function readLiveryImage(gameRoot, folder, pack = 'mine') {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const packDir = _packDir(gameRoot, pack);
  const resolved = packDir ? containmentCheck(packDir, folder || '') : null;
  if (!resolved) return { success: false, error: 'BAD_FOLDER' };
  try {
    // Multi-part liveries (A388/B38M) store the paintable texture as
    // base_Fuselage.png etc. — resolve via the manifest, not a fixed name.
    const found = _resolveLiveryImagePath(resolved);
    if (!found) return { success: false, error: 'IMAGE_MISSING' };
    const buf = fs.readFileSync(found.path);
    const ext = path.extname(found.path).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    return { success: true, imageDataUrl: `data:${mime};base64,` + buf.toString('base64') };
  } catch (_) {
    return { success: false, error: 'IMAGE_MISSING' };
  }
}

// Lazy require: electron is available in the packaged/main process but NOT
// in vitest (pure CommonJS tests) — never throw at module load.
let _injectedNativeImage;
let _hasInjectedNativeImage = false;
function _setNativeImageForTests(img) {
  _injectedNativeImage = img;
  _hasInjectedNativeImage = true;
}
function _resetNativeImageForTests() {
  _injectedNativeImage = undefined;
  _hasInjectedNativeImage = false;
}
function _getNativeImage() {
  if (_hasInjectedNativeImage) return _injectedNativeImage || null;
  try {
    // eslint-disable-next-line global-require
    const { nativeImage } = require('electron');
    return nativeImage || null;
  } catch (_) {
    return null;
  }
}

// Downscale a decoded image buffer to a small JPEG data-URL via
// Electron's nativeImage (zero extra deps — sharp is dev-only and not
// shipped in the packaged app). Returns null when unavailable/empty.
function _nativeThumbnail(buf, size) {
  try {
    const nativeImage = _getNativeImage();
    if (!nativeImage) return null;
    const img = nativeImage.createFromBuffer(buf);
    if (!img || img.isEmpty()) return null;
    const resized = img.resize({ width: size, height: size, quality: 'good' });
    if (!resized || resized.isEmpty()) return null;
    const jpeg = resized.toJPEG(72);
    if (!jpeg || !jpeg.length) return null;
    return `data:image/jpeg;base64,` + jpeg.toString('base64');
  } catch (_) {
    return null;
  }
}

// Low-resolution preview for the livery list. Same resolution + containment
// as readLiveryImage, but the payload is a ~256px JPEG (≈20KB) instead of
// the full 2048×2048 PNG (several MB) — the list never needs paintable
// pixels. The painter keeps using readLiveryImage for the full texture.
// Falls back to the full image when nativeImage is unavailable (unit tests)
// so callers always get a renderable data-URL; `thumbnail:false` marks it.
function readLiveryThumbnail(gameRoot, folder, pack = 'mine', size = THUMBNAIL_SIZE) {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const target = Math.max(64, Math.min(512, Number(size) || THUMBNAIL_SIZE));
  const packDir = _packDir(gameRoot, pack);
  const resolved = packDir ? containmentCheck(packDir, folder || '') : null;
  if (!resolved) return { success: false, error: 'BAD_FOLDER' };
  try {
    const found = _resolveLiveryImagePath(resolved);
    if (!found) return { success: false, error: 'IMAGE_MISSING' };
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(found.path).mtimeMs; } catch (_) {}
    const cacheKey = `${found.path}:${mtimeMs}:${target}`;
    const cached = _thumbCache.get(cacheKey);
    if (cached) return { success: true, imageDataUrl: cached, thumbnail: true };
    const buf = fs.readFileSync(found.path);
    const thumb = _nativeThumbnail(buf, target);
    if (thumb) {
      _thumbCache.set(cacheKey, thumb);
      if (_thumbCache.size > _THUMB_CACHE_MAX) {
        const oldest = _thumbCache.keys().next().value;
        _thumbCache.delete(oldest);
      }
      return { success: true, imageDataUrl: thumb, thumbnail: true };
    }
    // Fallback (no Electron — unit tests): serve the full image verbatim.
    const ext = path.extname(found.path).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    return { success: true, imageDataUrl: `data:${mime};base64,` + buf.toString('base64'), thumbnail: false };
  } catch (_) {
    return { success: false, error: 'IMAGE_MISSING' };
  }
}

// Picks the "main" part of a decoded part list: the body/fuselage is the
// large paintable surface shown by single-image callers. Multi-image aircraft
// (A388/B38M) also ship Wing/Wingtip maps; those are returned in the full
// `parts` list, this only chooses the legacy single `imageDataUrl`.
function _pickMainPart(parts) {
  if (!Array.isArray(parts)) return null;
  return parts.find(p => p && p.partName === 'Body')
    || parts.find(p => p && p.partName === 'Fuselage')
    || parts[0] || null;
}

const _templateCache = new Map();

// Returns the built-in default livery's BaseMaps for `planeId` as PNG
// data-URLs — the exact UV atlases the model uses, used as the painter's
// per-aircraft template background. `parts` carries every paintable panel in
// manifest order (A388 → Fuselage + Wing, B38M → Fuselage + Wingtip); the
// legacy `imageDataUrl`/`partName` mirror the main part. Cached per plane id;
// never throws.
function readAircraftTemplate(gameRoot, planeId) {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const id = String(planeId || '');
  if (!id || (!PLANE_ID_TO_SHORT_CODE[id] && !hasBuiltInTemplate(gameRoot, id))) {
    return { success: false, error: 'BAD_PLANE' };
  }
  if (_templateCache.has(id)) return _templateCache.get(id);
  const dir = path.join(gamePaths.builtinLiveryDir(gameRoot), id);
  let result;
  try {
    const manifest = _readJsonFile(path.join(dir, 'aircraft_livery_manifest.json'), 'utf-8');
    const baseParts = _basePartsFromManifest(manifest);
    if (baseParts.length === 0) {
      result = { success: false, error: 'IMAGE_MISSING' };
    } else {
      const decoded = [];
      let anyBaseMap = false;
      let decodeFailed = false;
      for (const bp of baseParts) {
        anyBaseMap = true;
        const file = path.join(dir, path.basename(bp.fileName));
        const imageDataUrl = _decodeTextureFile(file);
        if (imageDataUrl) decoded.push({ partName: bp.partName, fileName: bp.fileName, imageDataUrl });
        else decodeFailed = true;
      }
      if (decoded.length === 0) {
        result = { success: false, error: anyBaseMap && decodeFailed ? 'BAD_TEMPLATE' : 'IMAGE_MISSING' };
      } else {
        const main = _pickMainPart(decoded);
        result = {
          success: true,
          imageDataUrl: main.imageDataUrl,
          partName: main.partName,
          parts: decoded,
        };
      }
    }
  } catch (err) {
    result = { success: false, error: err.code === 'ENOENT' ? 'NO_TEMPLATE' : err.message };
  }
  // Cache only successes — a missing file may appear after a game update.
  if (result.success) _templateCache.set(id, result);
  return result;
}

// Every paintable BaseMap in a stored livery (own or reference pack) as full
// data-URLs — the painter loads all panels so a multi-part livery round-trips.
// `imageDataUrl` mirrors the main part for single-image callers. Never throws.
function readLiveryImages(gameRoot, folder, pack = 'mine') {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const packDir = _packDir(gameRoot, pack);
  const resolved = packDir ? containmentCheck(packDir, folder || '') : null;
  if (!resolved) return { success: false, error: 'BAD_FOLDER' };
  try {
    const manifest = _readJsonFile(path.join(resolved, 'aircraft_livery_manifest.json'), 'utf-8');
    let baseParts = _basePartsFromManifest(manifest);
    // Legacy folder with no manifest BaseMap but a stray base.png.
    if (baseParts.length === 0 && fs.existsSync(path.join(resolved, 'base.png'))) {
      baseParts = [{ partName: _pickMainPartRef(manifest && manifest.parts)?.partName || 'Body', fileName: 'base.png' }];
    }
    const parts = [];
    for (const bp of baseParts) {
      const p = path.join(resolved, path.basename(bp.fileName));
      const imageDataUrl = _decodeTextureFile(p);
      if (imageDataUrl) parts.push({ partName: bp.partName, fileName: bp.fileName, imageDataUrl });
    }
    if (parts.length === 0) return { success: false, error: 'IMAGE_MISSING' };
    return { success: true, imageDataUrl: _pickMainPart(parts).imageDataUrl, parts };
  } catch (_) {
    return { success: false, error: 'IMAGE_MISSING' };
  }
}

// The caller supplies only manifest-truth fields (airline + targetPlaneId)
// plus a free-form, filesystem-safe folder name used verbatim as the storage
// key. `images` is an ordered list of `{partName, imageDataUrl}` paintable
// panels (single entry for legacy callers passing `imageDataUrl`). The short
// code, file names and manifest id are derived — never parsed from the folder.
function createLivery(gameRoot, { images, imageDataUrl, airline, targetPlaneId, folder }) {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  if (!AIRLINE_RE.test(String(airline || ''))) return { success: false, error: 'BAD_AIRLINE' };
  const planeId = String(targetPlaneId || '');
  if (!planeId || (!PLANE_ID_TO_SHORT_CODE[planeId] && !hasBuiltInTemplate(gameRoot, planeId))) {
    return { success: false, error: 'BAD_PLANE' };
  }
  // Known types use the table code; an unknown-but-installed type falls back to
  // a compact alphanumeric code derived from its plane id.
  const shortCode = PLANE_ID_TO_SHORT_CODE[planeId] || planeId.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  // The manifest part must match the aircraft's built-in main part (Fuselage
  // for multi-part A388/B38M) or the game ignores the painted texture.
  const builtInBaseParts = _builtInBaseParts(gameRoot, planeId);
  const mainPartName = _builtInMainPartName(gameRoot, planeId);
  // The manifest version must match the aircraft's built-in model version or
  // the game flags the livery as broken (C919 bumped 1→2; the rest are 1).
  // Deliberately NOT copying `variant`: no built-in manifest carries one, so
  // emitting it would diverge from the validated schema for no benefit.
  const targetModelVer = _builtInTargetModelVer(gameRoot, planeId);
  const rawFolder = String(folder == null ? '' : folder).trim();
  if (!LIVERY_FOLDER_SAFE_RE.test(rawFolder)) return { success: false, error: 'BAD_FOLDER' };

  // Normalize to an ordered `[{partName, buf}]` list.
  const list = Array.isArray(images) && images.length
    ? images.map(im => ({ partName: im && im.partName ? String(im.partName) : '', imageDataUrl: im && im.imageDataUrl }))
    : [{ partName: '', imageDataUrl }];
  const total = list.length;
  const manifestParts = [];
  for (let i = 0; i < total; i++) {
    const item = list[i];
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(item.imageDataUrl || ''));
    if (!m) return { success: false, error: 'BAD_IMAGE' };
    let buf;
    try { buf = Buffer.from(m[1], 'base64'); }
    catch (_) { return { success: false, error: 'BAD_IMAGE' }; }
    const size = pngSize(buf);
    if (!size || size.width !== TEXTURE_SIZE || size.height !== TEXTURE_SIZE) {
      return { success: false, error: 'BAD_IMAGE_DIMENSIONS' };
    }
    // Prefer the caller's part name (from the built-in template); fall back to
    // the built-in binding at the same index, then the main part / Body.
    let partName = item.partName;
    if (!partName && builtInBaseParts[i]) partName = builtInBaseParts[i].partName;
    if (!partName && total === 1) partName = mainPartName;
    if (!partName) partName = 'Body';
    manifestParts.push({ partName, fileName: baseFileName(partName, total), buf });
  }

  try {
    const packDir = ensureOwnPackDir(gameRoot);
    const resolved = containmentCheck(packDir, rawFolder);
    if (!resolved) return { success: false, error: 'BAD_FOLDER' };
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    // Silent overwrite — no .bak (locked decision §0.4). The renderer's Save
    // As flow confirms first when a foreign folder would be clobbered. Stale
    // images from a previous save (e.g. base.png after a multi-part save) are
    // removed so the folder never carries orphan textures.
    const wanted = new Set(manifestParts.map(p => p.fileName.toLowerCase()));
    for (const entry of fs.readdirSync(resolved)) {
      if (entry.startsWith('.')) continue; // keep .workshop.json / .workshop-preview.*
      if ((/\.png$/i.test(entry) || /\.jpe?g$/i.test(entry)) && !wanted.has(entry.toLowerCase())) {
        try { fs.rmSync(path.join(resolved, entry), { force: true }); } catch (_) {}
      }
    }
    for (const p of manifestParts) fs.writeFileSync(path.join(resolved, p.fileName), p.buf);
    fs.writeFileSync(
      path.join(resolved, 'aircraft_livery_manifest.json'),
      JSON.stringify(buildManifest({
        folder: rawFolder, shortCode, airline, targetPlaneId, targetModelVer,
        parts: manifestParts.map(p => ({ partName: p.partName, fileName: p.fileName })),
      }), null, 2),
      'utf-8',
    );
    return { success: true, folder: rawFolder };
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
    if (ext === '.svg') return readSvgImage(filePath);
    const mime = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : null);
    if (!mime) return { success: false, error: 'BAD_IMAGE' };
    const buf = fs.readFileSync(filePath);
    return { success: true, imageDataUrl: `data:${mime};base64,` + buf.toString('base64') };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// SVG stickers: Chromium only rasterizes an <img> SVG that carries intrinsic
// dimensions. Files with width/height in % (or no size at all — viewBox only)
// decode to 0×0, so normalize up front: resolve width×height from the
// width/height attributes (unitless or px) falling back to the viewBox, cap
// the long edge at SVG_RASTER_CAP (the painter scales stickers to ≤1024
// anyway), and inject plain width/height attributes. Returns a BAD_IMAGE
// result when no usable size can be resolved. Scripts never run in an <img>
// context, so no sanitization is needed beyond sizing.
const SVG_RASTER_CAP = 1024;

function svgAttrSize(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']', 'i'));
  if (!m) return null;
  const v = m[1].trim().toLowerCase();
  // Unitless or px only — %, em, pt etc. resolve against a viewport the
  // <img> decode doesn't have, so treat them as missing.
  const num = v.endsWith('px') ? v.slice(0, -2) : v;
  if (!/^\d+(\.\d+)?$/.test(num)) return null;
  const n = parseFloat(num);
  return n > 0 && Number.isFinite(n) ? n : null;
}

function normalizeSvg(svgText) {
  const tagMatch = svgText.match(/<svg[\s>]/i);
  if (!tagMatch) return null;
  const tagStart = tagMatch.index;
  const tagEnd = svgText.indexOf('>', tagStart);
  if (tagEnd === -1) return null;
  const tag = svgText.slice(tagStart, tagEnd + 1);
  let w = svgAttrSize(tag, 'width');
  let h = svgAttrSize(tag, 'height');
  if (w == null || h == null) {
    const vb = tag.match(/viewBox\s*=\s*["']([^"']*)["']/i);
    if (vb) {
      const parts = vb[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
        if (w == null) w = parts[2];
        if (h == null) h = parts[3];
      }
    }
  }
  if (w == null || h == null) return null;
  const k = Math.min(1, SVG_RASTER_CAP / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k));
  const H = Math.max(1, Math.round(h * k));
  const stripped = tag.replace(/\s+(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '');
  const close = stripped.endsWith('/>') ? stripped.slice(0, -2) + ` width="${W}" height="${H}" />` : stripped.slice(0, -1) + ` width="${W}" height="${H}">`;
  return svgText.slice(0, tagStart) + close + svgText.slice(tagEnd + 1);
}

function readSvgImage(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const normalized = normalizeSvg(raw);
    if (!normalized) return { success: false, error: 'BAD_IMAGE' };
    return { success: true, imageDataUrl: 'data:image/svg+xml;base64,' + Buffer.from(normalized, 'utf-8').toString('base64') };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Share / load (P3) ──────────────────────────────────────

// Zip {manifest + all texture images} to a temp <folder>.zip for the save
// dialog. Entries are prefixed with the folder name so the recipient can
// unzip straight into <gameRoot>/Mods/<OWN_PACK>/ (share contract).
// Multi-part liveries (A388/B38M) carry base_Fuselage.png + base_Wing.png —
// every image in the folder is included, not just base.png.
function exportLivery(gameRoot, folder) {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const resolved = containmentCheck(ownPackDir(gameRoot), folder || '');
  if (!resolved) return { success: false, error: 'BAD_FOLDER' };
  try {
    const manifestRaw = fs.readFileSync(path.join(resolved, 'aircraft_livery_manifest.json'));
    const entries = [{ name: `${folder}/aircraft_livery_manifest.json`, data: manifestRaw }];
    for (const entry of fs.readdirSync(resolved)) {
      if (entry.startsWith('.')) continue; // skip .workshop.json / .workshop-preview.*
      if (/\.png$/i.test(entry) || /\.jpe?g$/i.test(entry)) {
        entries.push({
          name: `${folder}/${entry}`,
          data: fs.readFileSync(path.join(resolved, entry)),
        });
      }
    }
    if (entries.length < 2) {
      return { success: false, error: 'IMAGE_MISSING' };
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-livery-export-'));
    const zipPath = path.join(tmpDir, `${folder}.zip`);
    createZip(entries, zipPath);
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
      manifest = _readJsonFile(path.join(absDir, 'aircraft_livery_manifest.json'), 'utf-8');
    } catch (_) {
      return { success: false, error: 'BAD_MANIFEST' };
    }
    const texName0 = (manifest.parts && manifest.parts[0] && manifest.parts[0].textures &&
      manifest.parts[0].textures[0] && manifest.parts[0].textures[0].fileName) || 'base.png';
    const folder = manifestDir === '.' ? path.basename(String(zipPath), path.extname(String(zipPath))) : path.basename(manifestDir);
    // Everything comes from the manifest — the folder is only the storage key
    // (and the unzip target the share contract depends on). Preview with the
    // main-part BaseMap (Fuselage for multi-part A388/B38M), not parts[0].
    const shortCode = PLANE_ID_TO_SHORT_CODE[manifest.targetPlaneId] || '';
    const main = _mainPartBaseFile(manifest);
    const texName = (main && main.fileName) || texName0;
    let texBuf;
    try {
      texBuf = fs.readFileSync(path.join(absDir, path.basename(texName)));
    } catch (_) {
      return { success: false, error: 'IMAGE_MISSING' };
    }
    const texExt = path.extname(String(texName)).toLowerCase();
    const texMime = texExt === '.jpg' || texExt === '.jpeg' ? 'image/jpeg' : 'image/png';
    const imageDataUrl = `data:${texMime};base64,` + texBuf.toString('base64');
    // Every paintable BaseMap in the shared manifest, so the painter can load
    // all panels of a multi-part (A388/B38M) livery.
    const parts = [];
    for (const bp of _basePartsFromManifest(manifest)) {
      const p = path.join(absDir, path.basename(bp.fileName));
      const url = _decodeTextureFile(p);
      if (url) parts.push({ partName: bp.partName, fileName: bp.fileName, imageDataUrl: url });
    }
    return {
      success: true,
      folder,
      shortCode,
      manifest,
      imageDataUrl,
      parts: parts.length ? parts : [{ partName: (main && main.partName) || 'Body', fileName: texName, imageDataUrl }],
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ─── Workshop publish packaging ───────────────────────────
// Standalone-mod layout for Steam Workshop uploads (see plan.md §4): the
// item root IS the mod root and the mod root IS the livery — mod_info.json
// + aircraft_livery_manifest.json + texture files, verbatim. The game's
// LiveryScanner reads mod_info.json; the editor's own
// _collectWorkshopLiveryDirs already accepts an item root that is a livery.
//
// Both builders below throw coded errors (err.code ∈ NO_GAME_ROOT,
// BAD_FOLDER, NO_MANIFEST, IMAGE_MISSING, NO_PREVIEW) instead of returning
// result objects — publishLivery maps them to i18n keys.

// Sidecar + saved-preview file names inside the livery folder. The sidecar
// (Workshop item id, remembered title/description) is private bookkeeping and
// never mod content; the saved preview ships verbatim inside the uploaded mod
// so subscribers see it in the item folder (publishLivery additionally syncs
// the current upload's preview into the content dir, covering a newly picked
// image that is not saved locally until the upload succeeds).
// Both are dot-files, skipped by the share ZIP and the createLivery image
// cleanup.
const WORKSHOP_SIDECAR = '.workshop.json';
const WORKSHOP_PREVIEW_BASENAME = '.workshop-preview';

// True for the editor's own Workshop bookkeeping files inside a livery folder.
function isWorkshopMetaFile(name) {
  const n = String(name || '');
  return n === WORKSHOP_SIDECAR || n.startsWith(`${WORKSHOP_PREVIEW_BASENAME}.`);
}

// Stable, unique modName derived from the livery folder.
function workshopModName(folder) {
  const safe = String(folder || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'livery';
  return `AC27_${safe}`;
}

// Resolve an own-pack livery folder to its absolute dir, or null.
function _resolveOwnLiveryDir(gameRoot, folder) {
  if (!gameRoot || folder == null) return null;
  try {
    const resolved = containmentCheck(ownPackDir(gameRoot), String(folder));
    if (!resolved || !fs.existsSync(resolved)) return null;
    return resolved;
  } catch (_) {
    return null;
  }
}

function _codedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

// Remove a workshop temp dir (guarded: only our own mkdtemp prefixes).
function cleanWorkshopTemp(tempPath) {
  try {
    const parent = fs.existsSync(String(tempPath)) && fs.statSync(String(tempPath)).isDirectory()
      ? String(tempPath)
      : path.dirname(String(tempPath));
    if (path.basename(parent).includes('ac27-livery-ws')) {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  } catch (_) {}
}

// Copy the livery into a temp dir shaped as a game mod:
//   <temp>/mod_info.json, aircraft_livery_manifest.json, base*.png ...
// The ENTIRE livery folder is copied verbatim (every file + subdirectory), so
// any extra assets travel with the item; only the private `.workshop.json`
// sidecar (the publisher's item id) is excluded. The saved
// `.workshop-preview.*` image ships verbatim so the mod folder carries a
// preview.
// Returns { dir, cleanup }. Throws coded errors.
function buildWorkshopContent(gameRoot, folder) {
  if (!gameRoot) throw _codedError('NO_GAME_ROOT');
  const srcDir = _resolveOwnLiveryDir(gameRoot, folder);
  if (!srcDir) throw _codedError('BAD_FOLDER');
  try {
    _readJsonFile(path.join(srcDir, 'aircraft_livery_manifest.json'), 'utf-8');
  } catch (_) {
    throw _codedError('NO_MANIFEST');
  }
  // An image-less mod is ignored by the game — require at least one texture
  // (the sidecar is private bookkeeping and the saved preview is just the
  // item image, neither is a game texture).
  let hasTexture = false;
  try {
    hasTexture = fs.readdirSync(srcDir, { withFileTypes: true })
      .some(e => e.isFile() && !isWorkshopMetaFile(e.name)
        && (/\.png$/i.test(e.name) || /\.jpe?g$/i.test(e.name) || /\.dds$/i.test(e.name)));
  } catch (_) {
    hasTexture = false;
  }
  if (!hasTexture) throw _codedError('IMAGE_MISSING');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-livery-ws-'));
  const cleanup = () => cleanWorkshopTemp(dir);
  try {
    // The item root IS the mod root: copy the whole folder, then synthesize the
    // mod_info.json the game's LiveryScanner requires. Only the private
    // `.workshop.json` sidecar stays behind — everything else, including the
    // saved `.workshop-preview.*` image, travels with the item.
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.name === WORKSHOP_SIDECAR) continue;
      fs.cpSync(path.join(srcDir, entry.name), path.join(dir, entry.name), { recursive: true });
    }
    const modName = workshopModName(folder);
    fs.writeFileSync(path.join(dir, 'mod_info.json'), JSON.stringify({
      modName,
      modNameEn: String(folder),
      modNameZhHans: String(folder),
      modDescriptionEn: 'Aircraft livery created with the AC27 Editor.',
      modDescriptionZhHans: '使用 AC27 关卡编辑器创建的飞机涂装。',
    }, null, 2) + '\n', 'utf-8');
  } catch (err) {
    cleanup();
    throw _codedError(err.code || 'IMAGE_MISSING', err.message);
  }
  return { dir, cleanup };
}

// Render the livery's main BaseMap to a small JPG file for the Steam item
// preview (Steam needs a file path, not a data URL). Target ≤1 MiB via a
// 1024px-wide JPEG; falls back to the raw texture bytes when Electron's
// nativeImage is unavailable (unit tests). Returns { path, cleanup }.
// Throws coded errors (NO_GAME_ROOT, BAD_FOLDER, NO_PREVIEW).
function buildWorkshopPreview(gameRoot, folder, targetWidth = 1024) {
  if (!gameRoot) throw _codedError('NO_GAME_ROOT');
  const srcDir = _resolveOwnLiveryDir(gameRoot, folder);
  if (!srcDir) throw _codedError('BAD_FOLDER');
  const found = _resolveLiveryImagePath(srcDir);
  if (!found) throw _codedError('NO_PREVIEW');
  let buf;
  try {
    buf = fs.readFileSync(found.path);
  } catch (_) {
    throw _codedError('NO_PREVIEW');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-livery-ws-preview-'));
  const cleanup = () => cleanWorkshopTemp(dir);
  try {
    const nativeImage = _getNativeImage();
    if (nativeImage) {
      const img = nativeImage.createFromBuffer(buf);
      if (img && !img.isEmpty()) {
        const size = img.getSize();
        const width = Math.max(64, Math.min(targetWidth, size.width || targetWidth));
        const resized = width < (size.width || width + 1)
          ? img.resize({ width, quality: 'best' })
          : img;
        const jpeg = (!resized.isEmpty() ? resized : img).toJPEG(85);
        if (jpeg && jpeg.length) {
          const outPath = path.join(dir, 'preview.jpg');
          fs.writeFileSync(outPath, jpeg);
          return { path: outPath, cleanup };
        }
      }
    }
    // Fallback (no Electron): ship the raw texture bytes verbatim.
    const ext = path.extname(found.path).toLowerCase() === '.png' ? '.png' : '.jpg';
    const outPath = path.join(dir, 'preview' + ext);
    fs.writeFileSync(outPath, buf);
    return { path: outPath, cleanup };
  } catch (err) {
    cleanup();
    throw _codedError(err.code || 'NO_PREVIEW', err.message);
  }
}

// Steam rejects a Workshop item preview image ≥ 1 MiB with
// `k_EResultLimitExceeded` ("limit exceeded"). Guarantee the file handed to
// Steam is under the cap: an already-small file is returned untouched,
// otherwise it is re-encoded (downscaled + JPEG quality steps) into a temp
// file. Returns { path, cleanup } (cleanup null when nothing was created).
// Without Electron's nativeImage (unit tests) the original path is returned.
const WORKSHOP_PREVIEW_MAX_BYTES = 1024 * 1024;

function ensurePreviewUnderLimit(srcPath, maxBytes = WORKSHOP_PREVIEW_MAX_BYTES) {
  if (!srcPath || !fs.existsSync(srcPath)) return { path: srcPath, cleanup: null };
  let size = 0;
  try { size = fs.statSync(srcPath).size; } catch (_) { return { path: srcPath, cleanup: null }; }
  if (size < maxBytes) return { path: srcPath, cleanup: null };
  const nativeImage = _getNativeImage();
  if (!nativeImage) return { path: srcPath, cleanup: null };
  let buf;
  try { buf = fs.readFileSync(srcPath); } catch (_) { return { path: srcPath, cleanup: null }; }
  const img = nativeImage.createFromBuffer(buf);
  if (!img || img.isEmpty()) return { path: srcPath, cleanup: null };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-livery-ws-preview-'));
  const cleanup = () => cleanWorkshopTemp(dir);
  const outPath = path.join(dir, 'preview.jpg');
  const orig = img.getSize();
  let best = null;
  let width = Math.max(256, Math.min(1024, orig.width || 1024));
  outer:
  for (let attempt = 0; attempt < 6; attempt++) {
    const resized = width < (orig.width || width + 1) ? img.resize({ width, quality: 'best' }) : img;
    const base = (resized && !resized.isEmpty()) ? resized : img;
    for (const quality of [85, 70, 55, 40]) {
      const jpeg = base.toJPEG(quality);
      if (!jpeg || !jpeg.length) continue;
      if (!best || jpeg.length < best.length) best = jpeg;
      if (best.length < maxBytes) break outer;
    }
    width = Math.max(256, Math.floor(width / 2));
  }
  if (best) {
    fs.writeFileSync(outPath, best);
    return { path: outPath, cleanup };
  }
  cleanup();
  return { path: srcPath, cleanup: null };
}

module.exports = {
  OWN_PACK,
  REFERENCE_PACK,
  OWN_PACK_MOD_INFO,
  SHORT_CODE_TO_PLANE_ID,
  PLANE_ID_TO_SHORT_CODE,
  LIVERY_FOLDER_SAFE_RE,
  AIRLINE_RE,
  TEXTURE_SIZE,
  THUMBNAIL_SIZE,
  _thumbCache,
  ownPackDir,
  referencePackDir,
  workshopContentDir,
  resolvePackFolder,
  ensureOwnPackDir,
  ensureModInfo,
  containmentCheck,
  pngSize,
  buildManifest,
  baseFileName,
  listPackDir,
  listLiveries,
  listWorkshopLiveries,
  listAircraftTypes,
  readLiveryImage,
  readLiveryImages,
  readLiveryThumbnail,
  readAircraftTemplate,
  createLivery,
  deleteLivery,
  readDiskImage,
  exportLivery,
  copyExportedZip,
  cleanExportTemp: _cleanExportTemp,
  loadLiveryZip,
  WORKSHOP_SIDECAR,
  WORKSHOP_PREVIEW_BASENAME,
  WORKSHOP_PREVIEW_MAX_BYTES,
  ensurePreviewUnderLimit,
  _setNativeImageForTests,
  _resetNativeImageForTests,
  workshopModName,
  buildWorkshopContent,
  buildWorkshopPreview,
  cleanWorkshopTemp,
};
