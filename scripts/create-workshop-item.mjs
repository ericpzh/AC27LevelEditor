#!/usr/bin/env node
/**
 * create-workshop-item.mjs — bootstrap a brand-new Steam Workshop item for an
 * app that does not have one yet.
 *
 * The release flow (`.github/workflows/release.yml`) only ever UPDATES the
 * existing item (app 4004140, publishedfileid 3793213548). This script exists
 * for the future migration to another app (e.g. the Airport Control 27 full
 * game, app 3328490): a Workshop item is CREATED by handing steamcmd a VDF
 * that sets `appid` and NO `publishedfileid`; on success steamcmd writes the
 * new `publishedfileid` back into the same VDF, which this script then reads
 * out and prints.
 *
 * Usage:
 *   # dry run — writes the VDF, prints the exact steamcmd command (no login)
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Keys written with a fixed column so the generated VDF stays readable.
const KEY_WIDTH = 16;

export function escapeVdf(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
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

export function buildSteamCmdArgs({ username, vdfPath }) {
  return ['+login', username, '+workshop_build_item', vdfPath, '+quit'];
}

export function parseArgs(argv) {
  const args = { visibility: '2', run: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run') {
      args.run = true;
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

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.appid || !/^\d+$/.test(args.appid)) {
    console.error('error: --appid <numeric app id> is required');
    process.exit(1);
  }
  if (!['0', '1', '2', '3'].includes(String(args.visibility))) {
    console.error('error: --visibility must be 0 (public), 1 (friends), 2 (private) or 3 (unlisted)');
    process.exit(1);
  }

  const contentfolder = args.content ? resolveExisting(args.content) : null;
  if (contentfolder && !fs.statSync(contentfolder).isDirectory()) {
    console.error(`error: --content is not a directory: ${args.content}`);
    process.exit(1);
  }
  const previewfile = resolveExisting(args.preview || 'icon.png');
  const title = args.title || readIfExists(path.join(ROOT, 'workshop', 'title.txt')) || 'AC27Editor';
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

  const username = process.env.STEAM_USERNAME || '';
  const steamcmd = process.env.STEAMCMD || 'steamcmd';
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
  console.log('[create-item] commit the VDF, then wire the id into release.yml / update-workshop-i18n.mjs for the new app.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
