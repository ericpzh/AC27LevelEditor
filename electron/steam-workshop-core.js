// ─── Steam Workshop client core (shared) ───────────────────
// The Steamworks-SDK-facing half of the livery uploader, factored out so the
// exact same code runs in two places:
//   • electron/steam-workshop.js   (Electron main — in-process, test seam)
//   • electron/steam-workshop-worker.js (plain-node child — production)
//
// IMPORTANT: this module must stay free of `electron`, `fs`, `path` and other
// main-process-only imports. The worker runs as plain node via
// ELECTRON_RUN_AS_NODE=1 (no asar support), so it is shipped verbatim beside
// the app (see build.js extraResources).
//
// `lib` is the `steamworks.js` module (injected fake in tests). Both client
// generations are supported: `init(appId)` may return the client (legacy) or
// `undefined` with the namespaces left on the module (modern).

function codedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

// Full native-side error text (napi errors carry the Steam reason split across
// .code/.message, e.g. code='GenericFailure').
function describeNativeError(err, fallback) {
  const code = err && err.code;
  const msg = (err && err.message) || String(err == null ? fallback : err);
  return code && code !== msg ? `${code}: ${msg}` : msg;
}

function toBigItemId(id) {
  try {
    return BigInt(String(id));
  } catch (_) {
    const n = Number(id);
    if (Number.isFinite(n)) return n;
    return id;
  }
}

function workshopItemUrl(publishedFileId) {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${publishedFileId}`;
}

function _isSubscribed(client, appIdNum) {
  try {
    return Boolean(client.apps.isSubscribedApp(appIdNum));
  } catch (_) {
    return false;
  }
}

// Initialise SteamAPI for the Workshop host app and return the client. Throws
// a coded STEAM_UNAVAILABLE (Steam down / init failed) or NO_LICENSE (app not
// owned). The native layer throws napi errors carrying foreign codes — those
// are folded into STEAM_UNAVAILABLE with the true reason preserved in the
// message.
function initClient(lib, appIdNum) {
  let raw;
  try {
    raw = lib.init(appIdNum); // throws when Steam is not running
  } catch (err) {
    throw codedError('STEAM_UNAVAILABLE', describeNativeError(err, 'STEAM_UNAVAILABLE'));
  }
  const client = (raw && raw.workshop) ? raw : (lib && lib.workshop ? lib : null);
  if (!client) throw codedError('STEAM_UNAVAILABLE', 'steamworks init returned no workshop namespace');
  if (!_isSubscribed(client, appIdNum)) {
    throw codedError('NO_LICENSE', `not subscribed to app ${appIdNum}`);
  }
  return client;
}

function getAuthor(client) {
  try {
    return client.localplayer.getName() || '';
  } catch (_) {
    return '';
  }
}

// Normalise a steamworks workshop item to plain JSON (BigInt-free) so it can
// cross the worker boundary and drive the renderer dialog.
function normalizeItem(item, publishedFileId) {
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

async function readLiveItem(client, publishedFileId) {
  const item = await client.workshop.getItem(toBigItemId(publishedFileId), {
    includeLongDescription: true,
  });
  return normalizeItem(item, publishedFileId);
}

// True when the item is gone. A failed lookup is treated as "still exists" so
// a transient API error never silently forks a fresh item.
async function itemMissing(client, publishedFileId) {
  try {
    const item = await client.workshop.getItem(toBigItemId(publishedFileId));
    return !item;
  } catch (_) {
    return false;
  }
}

// Create a fresh Workshop item for the host app. Returns a plain
// `{ itemId: string, needsToAcceptAgreement: boolean }` (itemId stringified so
// the worker can JSON-serialize it).
async function createItem(client, appIdNum) {
  let created;
  try {
    created = await client.workshop.createItem(Number(appIdNum));
  } catch (err) {
    throw codedError('CREATE_FAILED', describeNativeError(err, 'CREATE_FAILED'));
  }
  if (!created || created.itemId == null) throw codedError('CREATE_FAILED');
  if (created.needsToAcceptAgreement) throw codedError('STEAM_AGREEMENT');
  return { itemId: String(created.itemId), needsToAcceptAgreement: false };
}

// Steam's `k_EResultLimitExceeded` (surfaced as `GenericFailure: limit
// exceeded`) means the preview image is too large (must be < 1 MiB) or the
// user's Steam Cloud quota is full — not an update rate limit.
function uploadError(err) {
  const detail = describeNativeError(err, 'UPLOAD_FAILED');
  const code = /limit exceeded/i.test(detail) ? 'PREVIEW_LIMIT' : 'UPLOAD_FAILED';
  return codedError(code, detail);
}

// Promisified `updateItemWithCallback` (Steam hands back progress + result).
function submitUpdate(client, publishedFileId, details, appIdNum, progressCb) {
  return new Promise((resolve, reject) => {
    try {
      client.workshop.updateItemWithCallback(
        toBigItemId(publishedFileId),
        details,
        Number(appIdNum),
        (data) => {
          if (data && data.needsToAcceptAgreement) reject(codedError('STEAM_AGREEMENT'));
          else resolve(data || {});
        },
        (err) => reject(uploadError(err)),
        progressCb,
        500,
      );
    } catch (err) {
      reject(uploadError(err));
    }
  });
}

module.exports = {
  codedError,
  describeNativeError,
  toBigItemId,
  workshopItemUrl,
  initClient,
  getAuthor,
  normalizeItem,
  readLiveItem,
  itemMissing,
  createItem,
  submitUpdate,
};
