// ─── Steam Workshop livery publish (main process) ─────────
// Standalone uploader built on the Steamworks SDK via the `steamworks.js`
// npm package (prebuilt N-API module, no compiler), used from the Electron
// main process only (see plan.md §2, §5).
//
// The native module is lazily required (same trick as `_getNativeImage` in
// livery.js) so unit tests and dev machines without Steam never crash at
// load. Tests inject a fake client via `_setSteamworksForTests`.
//
// Identity model (plan.md §3): one Workshop item per livery folder, tracked
// by a `.workshop.json` sidecar inside the livery folder (travels with the
// livery, survives cache resets, never packed into share ZIPs).

const fs = require('fs');
const path = require('path');
const livery = require('./livery');

// Single source of truth lives in src/utils/constants/steam.js (ESM). The
// main process is CommonJS and require(esm) is not portable, so keep literal
// fallbacks and prefer the module only when it loads.
//
// Workshop host is the Playtest/Editor app, plain and simple: the editor,
// its own Workshop item, and the game it runs against are all Playtest
// today (3328490 is where the editor "will migrate to" per steam.js —
// a future step, not today's target).
let STEAM_WORKSHOP_APP_ID = '4004140';
try {
  // eslint-disable-next-line global-require
  const steamConsts = require('../src/utils/constants/steam.js');
  if (steamConsts && steamConsts.STEAM_APP_ID) STEAM_WORKSHOP_APP_ID = String(steamConsts.STEAM_APP_ID);
} catch (_) {}

const SIDECAR_NAME = (livery && livery.WORKSHOP_SIDECAR) || '.workshop.json';
// Saved preview image inside the livery folder (`.workshop-preview.<ext>`):
// remembers the image used for the Workshop item so repeat uploads reuse it.
const PREVIEW_BASENAME = (livery && livery.WORKSHOP_PREVIEW_BASENAME) || '.workshop-preview';
const DEFAULT_TAGS = ['Livery'];
// Steamworks UGC visibility codes (UgcItemVisibility): 0 public, 1 friends,
// 2 private, 3 unlisted. Private is the safe default for a first upload.
const DEFAULT_VISIBILITY = 2;

function _codedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

// ─── Logger ─────────────────────────────────────────────
// Every workshop step is logged to the console and, best-effort, to
// <userData>/workshop-upload.log (updater.log precedent — packaged builds
// have no visible console). Never logs pixels, descriptions in full, or
// anything larger than an id.
let _logPath; // undefined = unresolved, null = unavailable (e.g. unit tests)

function _logFile() {
  if (_logPath !== undefined) return _logPath;
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    _logPath = path.join(app.getPath('userData'), 'workshop-upload.log');
  } catch (_) {
    _logPath = null;
  }
  return _logPath;
}

function _safeJson(value) {
  try {
    return JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  } catch (_) {
    return String(value);
  }
}

function _wlog(...args) {
  const line = `[Workshop] ${args.map((a) => (typeof a === 'string' ? a : _safeJson(a))).join(' ')}`;
  console.log(line);
  try {
    const file = _logFile();
    if (file) fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf-8');
  } catch (_) { /* best-effort */ }
}

// Absolute path of the workshop log file (null when unresolvable, e.g.
// unit tests). The renderer offers it behind a "View log" button so a
// failure can be diagnosed from a packaged build with no console.
function getLogPath() {
  return _logFile();
}

// Append one preformatted line (used for renderer-side dialog events so the
// whole upload story lives in a single file).
function appendLogLine(text) {
  try {
    const file = _logFile();
    if (file) fs.appendFileSync(file, `[${new Date().toISOString()}] ${String(text)}\n`, 'utf-8');
  } catch (_) { /* best-effort */ }
}

function _short(s, max = 120) {
  const str = String(s == null ? '' : s);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

// Full native-side error text for the log/detail (napi errors carry the
// Steam reason split across .code/.message, e.g. code='GenericFailure').
function _describeNativeError(err, fallback) {
  const code = err && err.code;
  const msg = (err && err.message) || String(err == null ? fallback : err);
  return code && code !== msg ? `${code}: ${msg}` : msg;
}

// Module-load marker: proves the main process runs the current build.
// Renderer code hot-reloads without restart while main does not, so a log
// WITHOUT this line means a stale main process (restart the app).
_wlog(`module loaded host=${STEAM_WORKSHOP_APP_ID}`);

// ─── Injectable native module ───────────────────────────

let _injectedLib;
let _hasInjectedLib = false;
let _loadError = null;

function _setSteamworksForTests(lib) {
  _injectedLib = lib;
  _hasInjectedLib = true;
}

function _resetSteamworksForTests() {
  _injectedLib = undefined;
  _hasInjectedLib = false;
  _loadError = null;
  _logPath = undefined;
  _client = null;
  _clientAppId = null;
}

function _requireSteamworks() {
  if (_hasInjectedLib) return _injectedLib || null;
  try {
    // eslint-disable-next-line global-require
    return require('steamworks.js');
  } catch (err) {
    _loadError = err;
    _wlog('native module not loaded:', (err && err.message) || err);
    return null;
  }
}

// ─── Client singleton ───────────────────────────────────
// steamworks.js 0.4.0 returns a client object from init(appId) carrying the
// workshop/localplayer/apps namespaces. (Newer typings expose them on the
// module itself — support both shapes.)
let _client = null;
let _clientAppId = null;

function _initLibClient(lib, appIdNum) {
  const maybe = lib.init(appIdNum); // throws when Steam is not running
  if (maybe && maybe.workshop) return maybe;
  if (lib && lib.workshop) return lib;
  throw _codedError('STEAM_UNAVAILABLE', 'steamworks init returned no workshop namespace');
}

function _isSubscribed(client, appIdNum) {
  try {
    return Boolean(client.apps.isSubscribedApp(appIdNum));
  } catch (_) {
    return false;
  }
}

// Resolve the single Workshop host client, initialising SteamAPI once per
// process (re-init hangs). A failed target init surfaces as STEAM_UNAVAILABLE —
// we never probe another app id (no Spacewar/480 fallback) so the editor
// never accrues playtime on a game the user did not launch.
function _resolveClient() {
  if (_client) return _client;
  const lib = _requireSteamworks();
  if (!lib) {
    throw _codedError(
      'STEAM_UNAVAILABLE',
      'steamworks.js not loaded' + (_loadError ? `: ${_loadError.message}` : ''),
    );
  }
  const target = Number(STEAM_WORKSHOP_APP_ID);
  let shaped = null;
  let initError = null;
  try {
    const raw = lib.init(target); // throws when Steam is down or the app is not owned
    shaped = (raw && raw.workshop) ? raw : (lib && lib.workshop ? lib : null);
  } catch (err) {
    initError = err;
    shaped = null;
  }
  if (shaped) {
    if (!_isSubscribed(shaped, target)) {
      _wlog(`init app ${target} ok, not subscribed -> NO_LICENSE`);
      throw _codedError('NO_LICENSE', `not subscribed to app ${target}`);
    }
    _wlog(`init app ${target} ok, subscribed`);
    _client = { client: shaped, appId: String(target) };
    _clientAppId = target;
    return _client;
  }
  _wlog(`init app ${target} failed:`, (initError && (initError.code || initError.message)) || initError);
  throw _codedError('STEAM_UNAVAILABLE', 'steamworks init failed: Steam client not running');
}

function _getClient(appId) {
  const resolved = _resolveClient();
  if (appId == null || String(appId) === resolved.appId) return resolved.client;
  // Explicit different app (tests / tooling): attempt a direct init. The
  // native layer throws napi errors carrying foreign codes (e.g.
  // 'GenericFailure') — never let those leak as IPC error codes; callers
  // map by code, so anything outside our contract becomes STEAM_UNAVAILABLE
  // (the underlying message is preserved for the log/detail).
  const lib = _requireSteamworks();
  if (!lib) throw _codedError('STEAM_UNAVAILABLE');
  try {
    return _initLibClient(lib, Number(appId));
  } catch (err) {
    throw _codedError(_asCode(err, 'STEAM_UNAVAILABLE'), _describeNativeError(err, 'STEAM_UNAVAILABLE'));
  }
}

function _resolveAppId() {
  return String(STEAM_WORKSHOP_APP_ID || '4004140');
}

// ─── Availability ───────────────────────────────────────

// Every code the IPC layer may surface (dialog maps each to an
// `livery_err_*` string; anything else is a bug — see _getClient).
const KNOWN_ERROR_CODES = new Set([
  'STEAM_UNAVAILABLE', 'NO_LICENSE', 'NO_GAME_ROOT', 'BAD_FOLDER',
  'NO_MANIFEST', 'BAD_TITLE', 'BAD_ID', 'BAD_IMAGE', 'NO_PREVIEW',
  'IMAGE_MISSING', 'CREATE_FAILED', 'UPLOAD_FAILED', 'STEAM_AGREEMENT',
  'PREVIEW_LIMIT',
]);

// Clamp any throwable (napi errors carry foreign codes like 'GenericFailure',
// fs errors carry 'ENOENT', …) to our IPC contract.
function _asCode(err, fallback) {
  const code = (err && err.code) || fallback;
  return KNOWN_ERROR_CODES.has(code) ? code : fallback;
}

// IPC-safe error shape: mapped `error` code + raw `detail` for the log and
// the dialog's muted detail line. A sanitized foreign code (e.g. napi
// 'GenericFailure') is kept as a prefix of the detail so the true reason
// stays visible. Detail is truncated, never binary.
function toPublicError(err, fallback = 'UPLOAD_FAILED') {
  const rawCode = (err && err.code) || '';
  const msg = _short((err && err.message) || String(err == null ? fallback : err), 300);
  if (!rawCode || KNOWN_ERROR_CODES.has(rawCode)) {
    return { error: rawCode || fallback, detail: msg };
  }
  return { error: fallback, detail: `${rawCode}: ${msg}` };
}

function isAvailable() {
  const lib = _requireSteamworks();
  if (!lib) return { available: false, appId: _resolveAppId(), reason: 'STEAM_UNAVAILABLE' };
  try {
    const { appId } = _resolveClient();
    _wlog(`isAvailable: available app ${appId}`);
    return { available: true, appId };
  } catch (err) {
    const reason = (err && err.code) || 'STEAM_UNAVAILABLE';
    _wlog(`isAvailable: unavailable reason=${reason} detail=${_short(err && err.message)}`);
    return { available: false, appId: _resolveAppId(), reason };
  }
}

// ─── Sidecar ────────────────────────────────────────────

function _sidecarPath(liveryDir) {
  return path.join(liveryDir, SIDECAR_NAME);
}

function readSidecar(liveryDir) {
  try {
    if (!liveryDir) return null;
    const raw = fs.readFileSync(_sidecarPath(liveryDir), 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch (_) {
    return null;
  }
}

function writeSidecar(liveryDir, data) {
  try {
    fs.writeFileSync(_sidecarPath(liveryDir), JSON.stringify(data, null, 2) + '\n', 'utf-8');
    return true;
  } catch (_) {
    return false;
  }
}

// Absolute path of the saved preview image inside the livery folder, or null.
function _savedPreviewPath(liveryDir) {
  try {
    const entry = fs.readdirSync(liveryDir).find(n => n.startsWith(`${PREVIEW_BASENAME}.`));
    return entry ? path.join(liveryDir, entry) : null;
  } catch (_) {
    return null;
  }
}

// Copy the preview image used for the item into the livery folder so the next
// upload can reuse it (the source may be a temp file that is cleaned up, or a
// user-picked file outside the folder). Only one saved preview is kept.
// Returns the stored file name, or null when the source is unusable.
function _savePreview(liveryDir, srcPath) {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) return null;
    const abs = path.resolve(String(srcPath));
    // Already the saved preview (reuse path): nothing to copy.
    if (path.dirname(abs) === path.resolve(liveryDir)
      && path.basename(abs).startsWith(`${PREVIEW_BASENAME}.`)) {
      return path.basename(abs);
    }
    const ext = path.extname(abs).toLowerCase();
    const safeExt = (ext === '.png' || ext === '.jpg' || ext === '.jpeg') ? ext : '.jpg';
    try {
      for (const entry of fs.readdirSync(liveryDir)) {
        if (entry.startsWith(`${PREVIEW_BASENAME}.`)) {
          try { fs.rmSync(path.join(liveryDir, entry), { force: true }); } catch (_) {}
        }
      }
    } catch (_) {}
    const name = `${PREVIEW_BASENAME}${safeExt}`;
    fs.copyFileSync(abs, path.join(liveryDir, name));
    return name;
  } catch (_) {
    return null;
  }
}

// Accept a bare numeric id or a Steam community URL
// (…/sharedfiles/filedetails/?id=123… or any URL containing the id).
function parseWorkshopId(input) {
  const s = String(input == null ? '' : input).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/[?&]id=(\d+)/) || s.match(/filedetails\/(\d+)/) || s.match(/(\d{6,})/);
  return m ? m[1] : null;
}

function workshopItemUrl(publishedFileId) {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${publishedFileId}`;
}

function _toBigItemId(id) {
  try {
    return BigInt(String(id));
  } catch (_) {
    const n = Number(id);
    if (Number.isFinite(n)) return n;
    return id;
  }
}

function _resolveOwnLiveryDir(gameRoot, folder) {
  if (!gameRoot || folder == null) return null;
  try {
    const resolved = livery.containmentCheck(livery.ownPackDir(gameRoot), String(folder));
    if (!resolved || !fs.existsSync(resolved)) return null;
    return resolved;
  } catch (_) {
    return null;
  }
}

function _readManifest(liveryDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(liveryDir, 'aircraft_livery_manifest.json'), 'utf-8'));
  } catch (_) {
    return null;
  }
}

// ─── Publish info (dialog prefill) ──────────────────────
// Merge precedence: live Steam metadata → local sidecar → manifest defaults.

async function readPublishInfo(gameRoot, folder) {
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  const dir = _resolveOwnLiveryDir(gameRoot, folder);
  if (!dir) return { success: false, error: 'BAD_FOLDER' };
  const manifest = _readManifest(dir);
  if (!manifest) return { success: false, error: 'NO_MANIFEST' };

  const sidecar = readSidecar(dir);
  const gate = isAvailable();

  let author = '';
  if (gate.available) {
    try {
      author = _getClient(gate.appId).localplayer.getName() || '';
    } catch (_) {
      author = '';
    }
  }
  // No title line: the default title is composed in the renderer so it can be
  // localized (airline display name + aircraft type + "Livery"/"涂装").
  const defaultDescription = [
    manifest.targetPlaneId ? `Aircraft: ${manifest.targetPlaneId}` : '',
    manifest.airline ? `Airline: ${manifest.airline}` : '',
    author ? `Author: ${author}` : '',
    '',
    'Created with the AC27 Editor.',
  ].filter((line, i, arr) => line !== '' || arr[i - 1] !== '').join('\n').trim();

  const publishedFileId = sidecar && sidecar.publishedFileId ? String(sidecar.publishedFileId) : null;

  // Prefer the preview saved from the previous upload (the exact image the
  // Workshop item uses), falling back to the livery texture thumbnail.
  let previewDataUrl = null;
  try {
    const saved = _savedPreviewPath(dir);
    if (saved) {
      const img = livery.readDiskImage(saved);
      if (img && img.success) previewDataUrl = img.imageDataUrl;
    }
  } catch (_) {}
  if (!previewDataUrl) {
    try {
      const thumb = livery.readLiveryThumbnail(gameRoot, folder, 'mine');
      if (thumb && thumb.success) previewDataUrl = thumb.imageDataUrl;
    } catch (_) {}
  }

  const info = {
    success: true,
    available: gate.available,
    appId: gate.appId,
    reason: gate.reason,
    folder: String(folder),
    publishedFileId,
    url: publishedFileId ? workshopItemUrl(publishedFileId) : (sidecar && sidecar.url) || null,
    title: (sidecar && sidecar.title) || '',
    description: (sidecar && sidecar.description) || defaultDescription,
    airline: manifest.airline || '',
    targetPlaneId: manifest.targetPlaneId || '',
    visibility: (sidecar && Number.isFinite(Number(sidecar.visibility)))
      ? Number(sidecar.visibility)
      : DEFAULT_VISIBILITY,
    tags: (sidecar && Array.isArray(sidecar.tags) && sidecar.tags.length)
      ? sidecar.tags.slice()
      : DEFAULT_TAGS.slice(),
    previewDataUrl,
    author,
  };

  // Overlay live Steam metadata when the item exists (best-effort — a
  // failed lookup keeps the sidecar values so the dialog still opens).
  if (gate.available && publishedFileId) {
    try {
      const liveItem = await readLiveItem(gate.appId, publishedFileId);
      if (liveItem) {
        if (liveItem.title) info.title = liveItem.title;
        if (liveItem.description) info.description = liveItem.description;
        if (liveItem.visibility != null) info.visibility = liveItem.visibility;
        if (liveItem.tags.length) info.tags = liveItem.tags;
        if (liveItem.url) info.url = liveItem.url;
        _wlog(`prefill folder=${folder} live metadata applied`);
      } else {
        // Confirmed gone (deleted on the Workshop): forget the stale
        // association so the dialog shows a fresh publish, not a dead URL.
        info.publishedFileId = null;
        info.url = null;
        _wlog(`prefill folder=${folder} recorded item ${publishedFileId} no longer exists`);
      }
    } catch (err) {
      _wlog(`prefill folder=${folder} live lookup failed: ${_short(_describeNativeError(err, ''), 160)}`);
    }
  } else {
    _wlog(`prefill folder=${folder} available=${gate.available} sidecar=${Boolean(publishedFileId)}`);
  }
  return info;
}

// Async half of the merge: overlay live Steam metadata when the item exists.
// Split out so the sync IPC path stays total; publish flows await this.
async function readLiveItem(appId, publishedFileId) {
  const client = _getClient(appId);
  const item = await client.workshop.getItem(_toBigItemId(publishedFileId), { includeLongDescription: true });
  if (!item) return null;
  return {
    title: item.title || '',
    description: item.description || '',
    visibility: Number.isFinite(Number(item.visibility)) ? Number(item.visibility) : null,
    tags: Array.isArray(item.tags) ? item.tags.slice() : [],
    url: item.url || workshopItemUrl(publishedFileId),
    previewUrl: item.previewUrl || null,
  };
}

// ─── Publish ────────────────────────────────────────────

function _asTags(input) {
  if (Array.isArray(input)) return input.map(t => String(t).trim()).filter(Boolean);
  return String(input == null ? '' : input).split(',').map(t => t.trim()).filter(Boolean);
}

// True when the item is gone (deleted remotely or otherwise inaccessible). A
// failed lookup is treated as "still exists" so a transient API error never
// silently forks a fresh item.
async function _itemMissing(client, publishedFileId) {
  try {
    const item = await client.workshop.getItem(_toBigItemId(publishedFileId));
    return !item;
  } catch (_) {
    return false;
  }
}

// Steam's `k_EResultLimitExceeded` (surfaced as `GenericFailure: limit
// exceeded`) means the preview image is too large (must be < 1 MiB) or the
// user's Steam Cloud quota is full — not an update rate limit. Give it its own
// code so the dialog explains the real cause.
function _uploadError(err) {
  const detail = _describeNativeError(err, 'UPLOAD_FAILED');
  const code = /limit exceeded/i.test(detail) ? 'PREVIEW_LIMIT' : 'UPLOAD_FAILED';
  return _codedError(code, detail);
}

// Promisified `updateItemWithCallback` (Steam hands back progress + result).
function _submitUpdate(client, publishedFileId, details, appId, progressCb) {
  return new Promise((resolve, reject) => {
    try {
      client.workshop.updateItemWithCallback(
        _toBigItemId(publishedFileId),
        details,
        Number(appId),
        (data) => {
          if (data && data.needsToAcceptAgreement) reject(_codedError('STEAM_AGREEMENT'));
          else resolve(data);
        },
        (err) => reject(_uploadError(err)),
        progressCb,
        500,
      );
    } catch (err) {
      reject(_uploadError(err));
    }
  });
}

async function publishLivery(gameRoot, folder, meta, onProgress) {
  const m = meta || {};
  if (!gameRoot) throw _codedError('NO_GAME_ROOT');
  const dir = _resolveOwnLiveryDir(gameRoot, folder);
  if (!dir) throw _codedError('BAD_FOLDER', 'BAD_FOLDER');
  if (!_readManifest(dir)) throw _codedError('NO_MANIFEST');
  const title = String(m.title || '').trim();
  if (!title) throw _codedError('BAD_TITLE');

  const gate = isAvailable();
  if (!gate.available) throw _codedError(gate.reason || 'STEAM_UNAVAILABLE');
  // Single constant host — a stale sidecar appId from another setup never
  // diverts the upload elsewhere.
  const appId = gate.appId;
  const client = _getClient(appId);

  // The Workshop item id is remembered locally in the livery folder's
  // `.workshop.json` sidecar, written on every successful publish. A livery
  // that was never uploaded from this editor has no id and creates a new item;
  // subsequent uploads update the same item with no user input.
  const sidecar = readSidecar(dir);
  let publishedFileId = sidecar && sidecar.publishedFileId ? String(sidecar.publishedFileId) : null;

  // Never trust the recorded id — the item can be deleted on the Workshop
  // between uploads (Steam answers such an update with "a file was not
  // found"). Verify it still exists; a confirmed-missing item republishes as
  // a fresh item instead of failing.
  if (publishedFileId && await _itemMissing(client, publishedFileId)) {
    _wlog(`recorded item ${publishedFileId} no longer exists — publishing a new item`);
    publishedFileId = null;
  }

  let content = null;
  let preview = null;
  let previewGenerated = false;
  let previewShrinkCleanup = null;
  _wlog(`publish start folder=${folder} app=${appId} title=${_short(title, 80)} visibility=${m.visibility} tags=${_safeJson(_asTags(m.tags))} existing=${Boolean(publishedFileId)}`);
  try {
    try {
      content = livery.buildWorkshopContent(gameRoot, folder);
    } catch (err) {
      throw _codedError(_asCode(err, 'UPLOAD_FAILED'), (err && err.message) || 'UPLOAD_FAILED');
    }

    // Preview precedence: a caller-supplied image, then the image saved from a
    // previous upload (so the uploader remembers it), then a fresh render.
    let previewPath = (m.previewPath && String(m.previewPath)) || '';
    if (!previewPath || !fs.existsSync(previewPath)) {
      previewPath = _savedPreviewPath(dir) || '';
    }
    if (!previewPath || !fs.existsSync(previewPath)) {
      try {
        preview = livery.buildWorkshopPreview(gameRoot, folder);
        previewPath = preview.path;
        previewGenerated = true;
      } catch (err) {
        throw _codedError(_asCode(err, 'NO_PREVIEW'), (err && err.message) || 'NO_PREVIEW');
      }
    }
    if (!previewPath) throw _codedError('NO_PREVIEW');

    // Steam rejects a preview ≥ 1 MiB with "limit exceeded" — shrink it first
    // (a user-picked image is passed through untouched otherwise).
    const beforeBytes = (() => { try { return fs.statSync(previewPath).size; } catch (_) { return 0; } })();
    const shrink = livery.ensurePreviewUnderLimit(previewPath);
    previewPath = shrink.path;
    previewShrinkCleanup = shrink.cleanup;
    if (shrink.cleanup) {
      const afterBytes = (() => { try { return fs.statSync(previewPath).size; } catch (_) { return 0; } })();
      _wlog(`preview shrunk ${beforeBytes} -> ${afterBytes} bytes`);
    }

    if (!publishedFileId) {
      let created;
      try {
        _wlog(`createItem app=${appId}`);
        created = await client.workshop.createItem(Number(appId));
      } catch (err) {
        throw _codedError('CREATE_FAILED', _describeNativeError(err, 'CREATE_FAILED'));
      }
      if (!created || created.itemId == null) throw _codedError('CREATE_FAILED');
      if (created.needsToAcceptAgreement) throw _codedError('STEAM_AGREEMENT');
      publishedFileId = String(created.itemId);
      _wlog(`createItem ok id=${publishedFileId}`);
    } else {
      _wlog(`update existing id=${publishedFileId}`);
    }

    // Steam tags: unknown tags are ignored server-side; always keep Livery.
    const tags = _asTags(m.tags);
    if (!tags.includes('Livery')) tags.unshift('Livery');
    const visibility = Number(m.visibility);
    const details = {
      title,
      description: String(m.description || ''),
      changeNote: String(m.changeNote || ''),
      previewPath,
      contentPath: content.dir,
      tags,
      visibility: [0, 1, 2, 3].includes(visibility) ? visibility : DEFAULT_VISIBILITY,
    };

    const progressCb = (prog) => {
      try {
        const update = {
          status: prog ? prog.status : 0,
          progress: prog && prog.progress != null ? Number(prog.progress) : 0,
          total: prog && prog.total != null ? Number(prog.total) : 0,
        };
        if (update.status !== progressCb._lastStatus) {
          progressCb._lastStatus = update.status;
          _wlog(`update progress id=${publishedFileId} status=${update.status} ${update.progress}/${update.total}`);
        }
        if (typeof onProgress === 'function') onProgress(update);
      } catch (_) {}
    };
    progressCb._lastStatus = -1;

    _wlog(`updateItem id=${publishedFileId} title=${_short(title, 80)}`);
    try {
      await _submitUpdate(client, publishedFileId, details, appId, progressCb);
    } catch (err) {
      // The item may have been deleted after the existence check (or while the
      // upload ran). Create a replacement once instead of surfacing a failure.
      if (await _itemMissing(client, publishedFileId)) {
        _wlog(`update FAILED and item ${publishedFileId} is gone — creating a replacement`);
        let created;
        try {
          created = await client.workshop.createItem(Number(appId));
        } catch (createErr) {
          throw _codedError('CREATE_FAILED', _describeNativeError(createErr, 'CREATE_FAILED'));
        }
        if (!created || created.itemId == null) throw _codedError('CREATE_FAILED');
        if (created.needsToAcceptAgreement) throw _codedError('STEAM_AGREEMENT');
        publishedFileId = String(created.itemId);
        _wlog(`createItem ok id=${publishedFileId}`);
        await _submitUpdate(client, publishedFileId, details, appId, progressCb);
      } else {
        throw err;
      }
    }
    _wlog(`updateItem ok id=${publishedFileId}`);

    // Remember the preview image inside the livery folder so the next upload
    // reuses the exact image the item was published with.
    const previewFile = _savePreview(dir, previewPath);

    const url = workshopItemUrl(publishedFileId);
    writeSidecar(dir, {
      appId: String(appId),
      publishedFileId,
      url,
      title,
      description: String(m.description || ''),
      visibility: details.visibility,
      tags,
      previewFile,
      lastUploadedAt: new Date().toISOString(),
    });
    return { publishedFileId, url };
  } catch (err) {
    _wlog(`publish FAILED folder=${folder} code=${(err && err.code) || '?'} detail=${_short(_describeNativeError(err, ''), 300)}`);
    throw err;
  } finally {
    try {
      if (content && typeof content.cleanup === 'function') content.cleanup();
    } catch (_) {}
    try {
      if (previewGenerated && preview && typeof preview.cleanup === 'function') preview.cleanup();
    } catch (_) {}
    try {
      if (typeof previewShrinkCleanup === 'function') previewShrinkCleanup();
    } catch (_) {}
  }
}

module.exports = {
  SIDECAR_NAME,
  DEFAULT_TAGS,
  DEFAULT_VISIBILITY,
  isAvailable,
  readSidecar,
  writeSidecar,
  parseWorkshopId,
  workshopItemUrl,
  readPublishInfo,
  readLiveItem,
  publishLivery,
  toPublicError,
  getLogPath,
  appendLogLine,
  _setSteamworksForTests,
  _resetSteamworksForTests,
  _getClient,
  _resolveAppId,
};
