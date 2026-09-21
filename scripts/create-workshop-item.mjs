#!/usr/bin/env node
/**
 * create-workshop-item.mjs — bootstrap a brand-new Steam Workshop item for an
 * app that does not have one yet.
 *
 * The release flow (`.github/workflows/release.yml`) only ever UPDATES the
 * existing item (appid + publishedfileid from `src/utils/constants/steam.js`).
 * This script exists to bootstrap a brand-new item when moving to an app
 * that does not have one yet (e.g. bootstrapping the item for the Airport
 * Control 27 shipping game, app 3328490): a Workshop item is
 * CREATED by handing steamcmd a VDF that sets `appid` and NO
 * `publishedfileid`; on success steamcmd writes the new `publishedfileid`
 * back into the same VDF, which this script then reads out and prints.
 *
  * Guard: before doing anything, the script asks Steam's public Web API
  * whether the configured STEAM_PUBLISHED_FILE_ID already resolves to a live
  * item. If that item belongs to the target --appid, creation aborts (the
  * release flow should UPDATE it instead) unless --force is given. A live item
  * under another app, or no item at all, lets creation proceed.
  *
  * Probe (no login, creates nothing — answers "is this appid ready?"):
  *   node scripts/create-workshop-item.mjs --probe-app 3328490
  * Checks the app exists (store API), where the configured item lives today,
  * and — with STEAM_API_KEY set — whether the app Workshop answers queries.
  * Publish rights still need a real private --run to prove.
  *
  * Usage:
  *   # dry run — runs the existence guard, writes the VDF, prints the exact
  *   # steamcmd command (no login)
  *   node scripts/create-workshop-item.mjs --appid 3328490 --content ./steam-workshop-content
  *
  *   # actually create the item (needs steamcmd on PATH + a cached login)
  *   node scripts/create-workshop-item.mjs --appid 3328490 --content ./steam-workshop-content --run
  *
  * Flags:
  *   --appid <id>            (required) target app whose Workshop gets the item
  *   --content <dir>         folder uploaded as the item content (paths are
  *                           made absolute; omit for a content-less shell)
  *   --preview <file>        primary preview image (default: icon.png)
  *   --title <text>          item title (default: workshop/title.txt)
  *   --description-file <f>  description source (default: workshop/description_en.txt)
  *   --visibility <0-3>      default 2 (private) — flip to 0 once verified
  *   --changenote <text>     change note for this first revision
  *   --out <file>            VDF path (default: workshop/create-item.<appid>.vdf)
  *   --run                   invoke steamcmd (default is dry-run)
  *   --force                 create even if an item already exists for the app
  *   --skip-check            skip the existence guard (offline use)
  *   --probe-app <id>        read-only readiness probe for an app id (no --appid needed)
 *
 * Env (only used with --run):
 *   STEAMCMD            steamcmd binary (default: steamcmd on PATH)
 *   STEAM_USERNAME      account for +login (steamcmd still needs the name even
 *                       when its cached token is present — see the release
 *                       workflow's config.vdf notes)
 *
 * The VDF is kept on disk (it is the only record of the new publishedfileid),
 * so commit it after a successful creation.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  STEAM_WORKSHOP_TITLE,
  STEAM_PUBLISHED_FILE_ID as CONFIGURED_FILE_ID,
  STEAM_VISIBILITY,
  STEAM_ENV,
} from '../src/utils/constants/steam.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Keys written with a fixed column so the generated VDF stays readable.
const KEY_WIDTH = 16;

export function escapeVdf(value) {
  // NOTE: steamcmd's KeyValues parser does not understand \" — an escaped
  // double-quote desyncs the whole file ("got } in key" at EOF). Double quotes
  // are therefore downgraded to single quotes; \\ and \n/\t parse fine.
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/**
 * Build the KeyValues text handed to `steamcmd +workshop_build_item`.
 * `publishedfileid` is deliberately omitted for creation; steamcmd adds it.
 */
export function buildWorkshopVdf(fields) {
  const lines = ['"workshopitem"', '{'];
  const add = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    lines.push(`    "${key}"${' '.repeat(Math.max(1, KEY_WIDTH - key.length))}"${escapeVdf(value)}"`);
  };
  add('appid', fields.appid);
  add('publishedfileid', fields.publishedfileid);
  add('contentfolder', fields.contentfolder);
  add('previewfile', fields.previewfile);
  add('visibility', fields.visibility);
  add('title', fields.title);
  add('description', fields.description);
  add('changenote', fields.changenote);
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** steamcmd rewrites the VDF on success; pull the assigned id back out. */
export function parsePublishedFileId(vdfText) {
  const match = vdfText.match(/"publishedfileid"\s+"(\d+)"/);
  return match ? match[1] : null;
}

// ─── Pre-creation guard: does the item already exist on the Workshop? ───
// Steam has no "create only if absent" primitive — workshop_build_item without
// a publishedfileid always mints a NEW item — so a repeated bootstrap would
// silently orphan duplicate items. Before writing/invoking anything, ask the
// public Web API (no key needed) whether the configured STEAM_PUBLISHED_FILE_ID
// already resolves to a live item, and refuse to create when it belongs to the
// target app (unless --force). Read-only, so it also runs on dry runs.
export const STEAM_GET_DETAILS_ENDPOINT =
  'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';

/**
 * Pure interpretation of a GetPublishedFileDetails response.
 * Returns { status, itemAppId, url } with status one of:
 *   exists-same-app  — live item belongs to targetAppId → do NOT create
 *   exists-other-app — live item belongs to another app (e.g. pre-migration) → safe
 *   missing          — id resolves to nothing → safe to create
 *   unknown          — unparseable response → caller warns and continues
 */
export function interpretPublishedFileDetails(json, { targetAppId, fileId }) {
  const details = json && json.response && json.response.publishedfiledetails;
  const entry = Array.isArray(details) ? details[0] : null;
  if (!entry || entry.result !== 1) return { status: 'missing', itemAppId: null, url: null };
  const itemAppId =
    entry.consumer_app_id != null ? String(entry.consumer_app_id)
    : entry.consumer_appid != null ? String(entry.consumer_appid)
    : entry.creator_app_id != null ? String(entry.creator_app_id)
    : entry.creator_appid != null ? String(entry.creator_appid)
    : null;
  const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${fileId}`;
  if (itemAppId != null && itemAppId === String(targetAppId)) {
    return { status: 'exists-same-app', itemAppId, url };
  }
  return { status: 'exists-other-app', itemAppId, url };
}

export async function checkExistingItem({
  fileId, targetAppId, fetchFn = fetch, endpoint = STEAM_GET_DETAILS_ENDPOINT,
}) {
  const body = new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': String(fileId) });
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok || !json) return { status: 'unknown', itemAppId: null, url: null };
  return interpretPublishedFileDetails(json, { targetAppId, fileId });
}

// ─── Read-only app probe: is this appid ready to host a Workshop item? ───
// Steam offers no dry-run upload — workshop_build_item always creates — so the
// closest pre-flight is three read-only checks (see --probe-app): the app
// exists (public store API), the configured item's current home (guard above),
// and whether the app's Workshop answers queries (needs STEAM_API_KEY or
// STEAM_PUBLISHER_KEY). What this canNOT prove: that your account may publish
// there, or that the partner enabled the Workshop tab — only a real (private)
// build_item attempt proves that.
export const STEAM_APP_DETAILS_ENDPOINT =
  'https://store.steampowered.com/api/appdetails';
export const STEAM_QUERY_FILES_ENDPOINT =
  'https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/';

/** { found, name, type } — found false when the store knows no such app. */
export function interpretAppDetails(json, { appid }) {
  const entry = json && json[String(appid)];
  if (!entry || entry.success !== true || !entry.data) {
    return { found: false, name: null, type: null };
  }
  return {
    found: true,
    name: entry.data.name || null,
    type: entry.data.type || null,
  };
}

export async function fetchAppDetails({ appid, fetchFn = fetch, endpoint = STEAM_APP_DETAILS_ENDPOINT }) {
  const res = await fetchFn(`${endpoint}?appids=${encodeURIComponent(String(appid))}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok || !json) return { found: false, name: null, type: null, error: true };
  return interpretAppDetails(json, { appid });
}

/** { ok, total } — ok false without a key, on HTTP failure, or bad payload. */
export async function queryWorkshopTotal({ appid, key, fetchFn = fetch, endpoint = STEAM_QUERY_FILES_ENDPOINT }) {
  if (!key) return { ok: false, total: null, reason: 'no-key' };
  const params = new URLSearchParams({
    key, query_type: '1', appid: String(appid), numperpage: '1', page: '1', totalonly: 'true',
  });
  const res = await fetchFn(`${endpoint}?${params.toString()}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { return { ok: false, total: null, reason: 'bad-payload' }; }
  const response = json && json.response;
  if (!res.ok || !response || response.result !== 1) {
    return { ok: false, total: null, reason: 'api-error' };
  }
  return { ok: true, total: response.total != null ? Number(response.total) : null, reason: null };
}

export function buildSteamCmdArgs({ username, vdfPath }) {
  return ['+login', username, '+workshop_build_item', vdfPath, '+quit'];
}

export function parseArgs(argv) {
  const args = { visibility: '2', run: false, force: false, 'skip-check': false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run' || arg === '--force' || arg === '--skip-check') {
      args[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for ${arg}`);
      }
      args[key] = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function resolveExisting(file) {
  if (!file) return null;
  const abs = path.resolve(ROOT, file);
  if (!fs.existsSync(abs)) throw new Error(`not found: ${file}`);
  return abs;
}

// Read-only pre-flight for a target app id. Creates nothing, needs no login.
// Exit code is 1 only when the store definitively knows no such app; every
// other inconclusive step prints a warning and continues.
async function runAppProbe(appid) {
  if (!/^\d+$/.test(String(appid || ''))) {
    console.error('error: --probe-app <numeric app id> is required');
    process.exit(1);
  }
  console.log(`[probe] target app ${appid}`);

  // 1. The app exists (public store API, no key).
  try {
    const info = await fetchAppDetails({ appid });
    if (info.error) {
      console.log('[probe] 1. store lookup inconclusive (network error) — continuing.');
    } else if (!info.found) {
      console.error(`[probe] 1. store knows no app ${appid} — check the id.`);
      process.exit(1);
    } else {
      console.log(`[probe] 1. app exists: "${info.name}" (type: ${info.type}).`);
    }
  } catch (err) {
    console.log(`[probe] 1. store lookup failed (${(err && err.message) || err}) — continuing.`);
  }

  // 2. Where does our configured item live today (public Web API, no key)?
  if (!CONFIGURED_FILE_ID) {
    console.log('[probe] 2. no STEAM_PUBLISHED_FILE_ID configured — skipping item check.');
  } else {
    try {
      const verdict = await checkExistingItem({ fileId: CONFIGURED_FILE_ID, targetAppId: appid });
      if (verdict.status === 'exists-same-app') {
        console.log(`[probe] 2. item ${CONFIGURED_FILE_ID} already lives under app ${appid}: ${verdict.url}`);
        console.log('[probe]    nothing to bootstrap — use the release workflow to UPDATE it.');
      } else if (verdict.status === 'exists-other-app') {
        console.log(`[probe] 2. item ${CONFIGURED_FILE_ID} lives under app ${verdict.itemAppId} — not the target; a new item is needed here: ${verdict.url}`);
      } else if (verdict.status === 'missing') {
        console.log('[probe] 2. configured item id resolves to nothing — a new item is needed here.');
      } else {
        console.log('[probe] 2. item check inconclusive (network/API error).');
      }
    } catch (err) {
      console.log(`[probe] 2. item check failed (${(err && err.message) || err}).`);
    }
  }

  // 3. The app's Workshop answers queries (needs a Web API or publisher key).
  const key = process.env[STEAM_ENV.PUBLISHER_KEY] || process.env[STEAM_ENV.API_KEY] || '';
  if (!key) {
    console.log('[probe] 3. skipped — set STEAM_API_KEY (or STEAM_PUBLISHER_KEY) to query the app Workshop item count.');
  } else {
    try {
      const q = await queryWorkshopTotal({ appid, key });
      if (q.ok) {
        console.log(`[probe] 3. Workshop queryable for app ${appid} (${q.total != null ? `${q.total} item(s)` : 'item count unavailable'}).`);
      } else {
        console.log(`[probe] 3. Workshop query failed (${q.reason}) — the app may have no Workshop or the key may lack access.`);
      }
    } catch (err) {
      console.log(`[probe] 3. Workshop query failed (${(err && err.message) || err}).`);
    }
  }

  // 4. What this probe cannot show.
  console.log('[probe] remaining manual checks:');
  console.log(`[probe]   a. steamcmd cached login: steamcmd +login <user> +quit  (must not ask for a password)`);
  console.log('[probe]   b. only a real private build_item proves publish rights — run this script with --run (default visibility is private).');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Read-only probe — answers "is this appid ready to host our item?" without
  // creating anything. Takes the app id as its value, so --appid is not needed.
  if (args['probe-app'] != null) {
    await runAppProbe(args['probe-app']);
    return;
  }

  if (!args.appid || !/^\d+$/.test(args.appid)) {
    console.error('error: --appid <numeric app id> is required');
    process.exit(1);
  }
  if (!Object.values(STEAM_VISIBILITY).includes(String(args.visibility))) {
    console.error('error: --visibility must be 0 (public), 1 (friends), 2 (private) or 3 (unlisted)');
    process.exit(1);
  }

  // Pre-creation guard (read-only — also runs on dry runs).
  if (args['skip-check']) {
    console.log('[create-item] --skip-check: existence guard skipped.');
  } else if (!CONFIGURED_FILE_ID) {
    console.log('[create-item] no STEAM_PUBLISHED_FILE_ID configured — existence guard skipped.');
  } else {
    console.log(`[create-item] checking Workshop for existing item ${CONFIGURED_FILE_ID} ...`);
    let verdict = { status: 'unknown' };
    try {
      verdict = await checkExistingItem({ fileId: CONFIGURED_FILE_ID, targetAppId: args.appid });
    } catch (err) {
      verdict = { status: 'unknown', detail: (err && err.message) || String(err) };
    }
    if (verdict.status === 'exists-same-app') {
      console.error(`[create-item] an item already exists for app ${args.appid}: ${verdict.url}`);
      if (args.force) {
        console.error('[create-item] --force: creating ANOTHER item anyway (the old one will be orphaned).');
      } else {
        console.error('[create-item] aborting — use the release workflow to UPDATE it instead. Re-run with --force to mint a duplicate.');
        process.exit(1);
      }
    } else if (verdict.status === 'exists-other-app') {
      console.log(`[create-item] configured item lives under app ${verdict.itemAppId} (${verdict.url}) — not the target app ${args.appid}, proceeding.`);
    } else if (verdict.status === 'missing') {
      console.log('[create-item] no existing item found — safe to create.');
    } else {
      console.log('[create-item] existence check inconclusive (network/API error) — proceeding; pass --skip-check to silence this.');
    }
  }

  const contentfolder = args.content ? resolveExisting(args.content) : null;
  if (contentfolder && !fs.statSync(contentfolder).isDirectory()) {
    console.error(`error: --content is not a directory: ${args.content}`);
    process.exit(1);
  }
  const previewfile = resolveExisting(args.preview || 'icon.png');
  const title = args.title || readIfExists(path.join(ROOT, 'workshop', 'title.txt')) || STEAM_WORKSHOP_TITLE;
  const description = args['description-file']
    ? readIfExists(resolveExisting(args['description-file']))
    : readIfExists(path.join(ROOT, 'workshop', 'description_en.txt'));

  const outPath = path.resolve(ROOT, args.out || path.join('workshop', `create-item.${args.appid}.vdf`));
  const fields = {
    appid: args.appid,
    contentfolder,
    previewfile,
    visibility: args.visibility,
    title,
    description,
    changenote: args.changenote || `Initial Workshop item for app ${args.appid} (created by scripts/create-workshop-item.mjs).`,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildWorkshopVdf(fields));
  console.log(`[create-item] wrote VDF: ${path.relative(ROOT, outPath)}`);
  console.log(`[create-item] appid=${fields.appid} visibility=${fields.visibility} (0=public 1=friends 2=private 3=unlisted)`);
  if (!fields.contentfolder) console.log('[create-item] no --content: item is created without content');

  const username = process.env[STEAM_ENV.USERNAME] || '';
  const steamcmd = process.env[STEAM_ENV.STEAMCMD] || 'steamcmd';
  const cmdArgs = buildSteamCmdArgs({ username: username || '<username>', vdfPath: outPath });
  console.log(`[create-item] command: ${steamcmd} ${cmdArgs.join(' ')}`);

  if (!args.run) {
    console.log('[create-item] dry run — re-run with --run to create the item.');
    return;
  }
  if (!username) {
    console.error('error: --run needs STEAM_USERNAME (steamcmd requires the account name even with a cached token)');
    process.exit(1);
  }

  console.log('[create-item] invoking steamcmd ...');
  const result = spawnSync(steamcmd, cmdArgs, { stdio: 'inherit' });
  if (result.error) {
    console.error(`error: could not run "${steamcmd}" — is steamcmd installed and on PATH? (${result.error.message})`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`error: steamcmd exited ${result.status}`);
    process.exit(result.status ?? 1);
  }

  const publishedFileId = parsePublishedFileId(fs.readFileSync(outPath, 'utf8'));
  if (!publishedFileId) {
    console.error(`error: steamcmd finished but no publishedfileid was written to ${path.relative(ROOT, outPath)}`);
    process.exit(1);
  }
  console.log(`[create-item] created publishedfileid: ${publishedFileId}`);
  console.log(`[create-item] page:  https://steamcommunity.com/sharedfiles/filedetails/?id=${publishedFileId}`);
  console.log(`[create-item] images: https://steamcommunity.com/sharedfiles/managepreviews/?id=${publishedFileId}`);
  console.log('[create-item] the VDF holds machine-specific absolute paths and is gitignored — do NOT commit it. Set STEAM_PUBLISHED_FILE_ID in src/utils/constants/steam.js to the new id (release.yml + update-workshop-i18n.mjs read it from there), then delete this VDF.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
