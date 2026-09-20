#!/usr/bin/env node
/**
 * fetch-airlines.mjs — one-off generator for the livery airline-name lookup.
 *
 * Pulls the two Wikipedia lists once and writes a compact ICAO → { en, zh }
 * table to src/utils/constants/airlines.wiki.js:
 *
 *   - EN: https://en.wikipedia.org/wiki/List_of_airline_codes  (transcludes the
 *     per-letter subpages; parsed from the rendered HTML table)
 *   - ZH: https://zh.wikipedia.org/wiki/国际民航组织航空公司代码  (fetched as
 *     the zh-cn variant so names are simplified, matching the app's zh-Hans UI)
 *
 * Source content is CC BY-SA 4.0 — the generated file carries attribution.
 * Re-run with `node scripts/fetch-airlines.mjs` to refresh the snapshot.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'utils', 'constants', 'airlines.wiki.js');
const UA = 'AC27Editor-airline-gen/1.0 (https://github.com/anomalyco/opencode)';
const ICAO_RE = /^[A-Z0-9]{3}$/;

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

function clean(text) {
  return String(text || '')
    .replace(/\[\s*(?:\d+|[a-z])\s*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a rowspan/colspan-aware text grid from the first sortable wikitable. */
function parseEnTable(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const table = doc.querySelector('table.wikitable.sortable') || doc.querySelector('table.wikitable');
  if (!table) throw new Error('EN: no wikitable found');

  const rows = [...table.querySelectorAll('tr')];
  const grid = [];
  rows.forEach((tr, r) => {
    if (!grid[r]) grid[r] = [];
    let c = 0;
    for (const cell of tr.children) {
      while (grid[r][c] !== undefined) c += 1;
      const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
      const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1);
      const link = cell.querySelector('a');
      const text = clean(link ? link.textContent : cell.textContent);
      if (text) {
        for (let i = 0; i < colspan; i += 1) {
          for (let j = 0; j < rowspan; j += 1) {
            if (!grid[r + j]) grid[r + j] = [];
            if (grid[r + j][c + i] === undefined) grid[r + j][c + i] = text;
          }
        }
      }
      c += colspan;
    }
  });

  const out = new Map();
  for (let r = 0; r < grid.length; r += 1) {
    const row = grid[r] || [];
    const icao = clean(row[1]).toUpperCase();
    const name = clean(row[2]);
    if (!ICAO_RE.test(icao) || !name || /^icao$/i.test(icao)) continue;
    const comments = clean(row[5]).toLowerCase();
    const defunct = /defunct/.test(comments) || /defunct/i.test(clean(row[3]));
    const prev = out.get(icao);
    if (!prev) out.set(icao, { name, defunct });
    else if (prev.defunct && !defunct) out.set(icao, { name, defunct });
  }
  return out;
}

/** Parse the ZH rendered list (fetched as the zh-cn variant) of "* CODE : Name". */
function parseZhHtml(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const out = new Map();
  for (const li of doc.querySelectorAll('li')) {
    const text = clean(li.textContent);
    const m = /^([A-Z0-9]{3})\s*[:：]\s*(.+)$/.exec(text);
    if (!m) continue;
    const code = m[1].toUpperCase();
    const defunct = Boolean(li.querySelector('s')) || /倒闭|結業|结业/.test(text);
    // Drop the trailing country/region parenthetical and defunct marker, then
    // any leaked empty parens and corporate suffixes so the value stays a
    // display name ("捷蓝航空", not "捷蓝航空公司（）").
    const name = clean(m[2]
      .replace(/[（(][^（()）]*[)）]/g, '')
      .replace(/倒闭|結業|结业/g, '')
      .replace(/^[)）\s]+/, '')
      .replace(/(?:股份有限公司|有限公司|控股公司|公司)$/u, '')
      .replace(/[，,、;；:：\s]+$/, ''));
    // Keep only CJK names; a value with no CJK is a duplicated/empty EN fallback.
    if (!name || !/[\u3400-\u9fff]/.test(name)) continue;
    const prev = out.get(code);
    if (!prev) out.set(code, { name, defunct });
    else if (prev.defunct && !defunct) out.set(code, { name, defunct });
  }
  return out;
}

function jsStr(s) {
  return JSON.stringify(s);
}

async function main() {
  const EN_URL =
    'https://en.wikipedia.org/w/api.php?action=parse&page=' +
    encodeURIComponent('List of airline codes') +
    '&prop=text&format=json&formatversion=2';
  const ZH_URL =
    'https://zh.wikipedia.org/w/api.php?action=parse&page=' +
    encodeURIComponent('国际民航组织航空公司代码') +
    '&prop=text&variant=zh-cn&format=json&formatversion=2';

  console.log('[fetch-airlines] fetching EN ...');
  const enJson = JSON.parse(await fetchText(EN_URL));
  console.log('[fetch-airlines] fetching ZH ...');
  const zhJson = JSON.parse(await fetchText(ZH_URL));
  if (enJson.error) throw new Error('EN API: ' + enJson.error.info);
  if (zhJson.error) throw new Error('ZH API: ' + zhJson.error.info);

  const en = parseEnTable(enJson.parse.text);
  const zh = parseZhHtml(zhJson.parse.text);
  console.log(`[fetch-airlines] EN codes: ${en.size}, ZH codes: ${zh.size}`);

  const codes = [...new Set([...en.keys(), ...zh.keys()])].sort();
  const lines = [];
  for (const code of codes) {
    const e = en.get(code);
    const z = zh.get(code);
    const enName = e ? e.name : '';
    const zhName = z ? z.name : '';
    if (!enName && !zhName) continue;
    const entry = [];
    if (enName) entry.push(`en:${jsStr(enName)}`);
    if (zhName) entry.push(`zh:${jsStr(zhName)}`);
    lines.push(`  ${code}: { ${entry.join(', ')} },`);
  }

  const header = `// AUTO-GENERATED by scripts/fetch-airlines.mjs — do not edit by hand.
// ICAO airline designator -> airline name (en + zh), merged from the Wikipedia
// "List of airline codes" (en) and "国际民航组织航空公司代码" (zh) pages.
// Source content is available under CC BY-SA 4.0:
//   https://en.wikipedia.org/wiki/List_of_airline_codes
//   https://zh.wikipedia.org/wiki/国际民航组织航空公司代码
// Snapshot: ${new Date().toISOString()}
export const WIKI_AIRLINE_NAMES = {
${lines.join('\n')}
};
`;
  fs.writeFileSync(OUT, header, 'utf8');
  console.log(`[fetch-airlines] wrote ${path.relative(ROOT, OUT)} (${lines.length} airlines)`);
}

main().catch((err) => {
  console.error('[fetch-airlines] failed:', err.message);
  process.exit(1);
});
