#!/usr/bin/env node
/**
 * update-workshop-i18n.mjs — push bilingual title/description to Steam Workshop
 * via ISteamRemoteStorage / IPublishedFileService Web API.
 *
 * Title is constant "AC27Editor" (workshop/title.txt).
 * Descriptions are static files: workshop/description_en.txt + workshop/description_zh.txt
 * No generation — files are the source of truth.
 *
 * Uses Steam's per-language update via `language` param (ISteamUGC::SetItemUpdateLanguage
 * equivalent). Steam shows the viewer's client language automatically (lang switcher).
 *
 * Required env: STEAM_PUBLISHER_KEY (partner.steam-api.com key, NOT Web API key)
 *   https://partner.steamgames.com/doc/webapi_overview/auth
 *   Secrets: STEAM_PUBLISHER_KEY | STEAM_API_KEY (fallback name)
 *
 * Usage:
 *   STEAM_PUBLISHER_KEY=xxx node scripts/update-workshop-i18n.mjs
 *   STEAM_PUBLISHER_KEY=xxx node scripts/update-workshop-i18n.mjs --dry-run
 *
 * Exit 0 = success or skipped (no key), 1 = failure when key present but push failed.
 */

import fs from 'fs';
import path from 'path';

const APPID = '4004140';
const PUBLISHED_FILE_ID = '3793213548';

const TITLE_PATH = 'workshop/title.txt';
const EN_PATH = 'workshop/description_en.txt';
const ZH_PATH = 'workshop/description_zh.txt';

function read(p) {
  return fs.readFileSync(path.resolve(p), 'utf8').trim();
}

async function post(endpoint, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json, text: text.slice(0, 2000) };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const key = process.env.STEAM_PUBLISHER_KEY || process.env.STEAM_API_KEY || '';

  if (!key) {
    console.log('[i18n] STEAM_PUBLISHER_KEY not set — skipping description push (content upload still handles Workshop).');
    console.log('[i18n] To enable auto cross-lang: add secret STEAM_PUBLISHER_KEY (partner.steam-api.com publisher key) to repo secrets.');
    process.exit(0);
  }

  const title = read(TITLE_PATH);
  const en = read(EN_PATH);
  const zh = read(ZH_PATH);

  console.log(`[i18n] title: "${title}" (${title.length} chars)`);
  console.log(`[i18n] EN: ${en.length} chars, ZH: ${zh.length} chars`);
  console.log(`[i18n] fileId=${PUBLISHED_FILE_ID} appId=${APPID}`);

  if (title !== 'AC27Editor') {
    console.error(`[i18n] title.txt must be "AC27Editor" (constant) — got "${title}"`);
    process.exit(1);
  }

  if (dryRun) {
    console.log('[i18n] --dry-run: not pushing');
    process.exit(0);
  }

  // Steam language codes: english, schinese (simplified Chinese)
  // Endpoint: partner.steam-api.com/IPublishedFileService/UpdatePublishedFile (publisher-only)
  // Fallback endpoints tried: ISteamRemoteStorage
  const payloads = [
    { language: 'english', title, description: en },
    { language: 'schinese', title, description: zh },
  ];

  for (const { language, description } of payloads) {
    const params = {
      key,
      publishedfileid: PUBLISHED_FILE_ID,
      appid: APPID,
      title,
      description,
      language,
    };
    // Primary: partner API (requires publisher key)
    const endpoints = [
      'https://partner.steam-api.com/IPublishedFileService/UpdatePublishedFile/v1/',
      'https://api.steampowered.com/ISteamRemoteStorage/UpdatePublishedFile/v1/',
    ];
    let lastErr = null;
    for (const ep of endpoints) {
      console.log(`[i18n] POST ${ep} language=${language} ...`);
      const r = await post(ep, params);
      console.log(`[i18n] -> HTTP ${r.status} ok=${r.ok}`);
      if (r.ok) {
        // Check Steam result code if present
        const result = r.json?.response?.result ?? r.json?.result;
        if (result !== undefined && result !== 1) {
          console.warn(`[i18n] Steam result != 1 for ${language}:`, JSON.stringify(r.json).slice(0, 800));
        } else {
          console.log(`[i18n] ${language} updated successfully`);
        }
        lastErr = null;
        break;
      } else {
        console.warn(`[i18n] failed ${ep} ${language}:`, r.text.slice(0, 500));
        lastErr = r.text;
      }
    }
    if (lastErr) {
      console.error(`[i18n] FAILED to push ${language}. Last error: ${lastErr.slice(0, 500)}`);
      console.error('[i18n] Hint: ensure STEAM_PUBLISHER_KEY is a publisher key with Workshop permission for app 4004140, not a regular Web API key.');
      process.exit(1);
    }
  }

  console.log('[i18n] Done — both languages pushed. Steam Workshop language switcher will now show EN/ZH automatically.');
}

main().catch(e => { console.error('[i18n] fatal', e); process.exit(1); });
