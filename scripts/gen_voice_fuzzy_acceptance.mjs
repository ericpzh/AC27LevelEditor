#!/usr/bin/env node
/**
 * gen_voice_fuzzy_acceptance.mjs — regenerate the exhaustive fuzzy
 * acceptance table (tests/components/MapWindows/voiceFuzzyAcceptance.json)
 * from the REAL grammar vocab tables + a general English wordlist.
 *
 * The table answers "for each supported word, what can it be fuzzed into":
 * every dictionary word within the slot's D-L cap of every grammar token.
 * It mirrors the RUNTIME rules exactly (same thresholds, eligibility,
 * NON_FUZZY, CURATED_EXCLUDE, exact-key-first), so the round-trip test
 * (voiceFuzzyAcceptance.test.js) can assert every entry resolves at runtime.
 *
 * Usage:
 *   node scripts/gen_voice_fuzzy_acceptance.mjs          — (re)write the fixture
 *   node scripts/gen_voice_fuzzy_acceptance.mjs --check  — diff vs the fixture,
 *                                                          exit 1 on drift
 *
 * Requires network access for the wordlist (dwyl/english-words words_alpha,
 * 370k words) — the fixture itself is committed and needs no network.
 */

import { writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EN_PATTERN_KEYS, EN_APPROACH_TYPE_KEYS } from '../src/components/MapWindows/voiceTranscriptParser.js';
import { EN_NUMBER_FUZZY_KEYS, EN_UNIT_FUZZY_KEYS } from '../src/components/MapWindows/voiceNumberParser.js';
import { getSpokenNameWords } from '../src/components/MapWindows/voiceCallsignParser.js';
import {
  damerauLevenshtein,
  maxDistForWord,
  NON_FUZZY_WORDS,
  CURATED_EXCLUDE,
  isFuzzyEligible,
} from '../src/components/MapWindows/voiceFuzzy.js';

const WORDLIST_URL = 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';

/** Aviation words the generic wordlist lacks (all within the runtime cap). */
const ADDITIONS = { nine: ['niner'] };

const OUT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'tests', 'components', 'MapWindows', 'voiceFuzzyAcceptance.json'
);

const NON_FUZZY_SET = new Set(NON_FUZZY_WORDS);

// ─── Slot key lists ────────────────────────────────────────────────────
// Imported from the runtime modules — the table is generated from the REAL
// tables and the same eligibility/exclusion rules, never duplicated here.
// (Airlines: the runtime fuzzy-matches a transcript token against the
// individual spoken word, so the slot keys are the name words themselves.)

// ─── Accept computation (mirrors fuzzyMatch's runtime rules) ───────────

/**
 * Every wordlist word that the runtime would fuzzy-map to `token`:
 * eligible, not a filler, not an exact key of the slot (exact-first), not
 * in CURATED_EXCLUDE[token], within `cap` D-L.
 */
function acceptSet(token, cap, words, slotKeys) {
  const hits = [];
  for (const w of words) {
    if (w === token) continue;
    if (!isFuzzyEligible(w)) continue;
    if (NON_FUZZY_SET.has(w)) continue;
    if (slotKeys.has(w)) continue;                     // exact match wins at runtime
    if (CURATED_EXCLUDE[token] && CURATED_EXCLUDE[token].includes(w)) continue;
    if (Math.abs(w.length - token.length) > cap) continue;
    if (damerauLevenshtein(w, token) <= cap) hits.push(w);
  }
  return hits.sort((a, b) => a.localeCompare(b));
}

// ─── Partition: each variant to its BEST key ───────────────────────────
// A variant within distance 1 of two keys (e.g. 'light' → right d1,
// flight d2) resolves to the nearer one at runtime — so it may only be
// listed under that key. Ties go to the first key in slot order (the
// runtime's array-order tiebreak).

function partitionSlot(keys, raw) {
  const best = new Map();   // variant → best key (first-in-slot-order wins ties)
  for (const token of keys) {
    for (const w of raw[token]) {
      if (!best.has(w)) best.set(w, token);
      else if (damerauLevenshtein(w, token) < damerauLevenshtein(w, best.get(w))) best.set(w, token);
    }
  }
  const out = {};
  for (const token of keys) out[token] = raw[token].filter((w) => best.get(w) === token);
  return out;
}

// ─── Build the table ───────────────────────────────────────────────────

let _wordCount = 0;

async function buildTable() {
  const res = await fetch(WORDLIST_URL);
  if (!res.ok) throw new Error(`wordlist fetch failed: HTTP ${res.status}`);
  const words = [...new Set(
    (await res.text()).split(/\n/).map((w) => w.trim().toLowerCase()).filter((w) => /^[a-z]+$/.test(w))
  )].concat(Object.values(ADDITIONS).flat());
  _wordCount = words.length;

  const slots = {};
  const slotDefs = [
    ['pattern', EN_PATTERN_KEYS, (t) => maxDistForWord(t)],
    ['approach', EN_APPROACH_TYPE_KEYS, () => 1],
    ['numbers', EN_NUMBER_FUZZY_KEYS, () => 1],
    ['units', EN_UNIT_FUZZY_KEYS, () => 1],
    ['airlines', getSpokenNameWords(), () => 1],
  ];
  for (const [name, keys, capFn] of slotDefs) {
    const keySet = new Set(keys);
    const out = {};
    for (const t of keys) out[t] = acceptSet(t, capFn(t), words, keySet);
    slots[name] = partitionSlot(keys, out);
  }

  return {
    wordlist: 'dwyl/english-words words_alpha',
    additions: ADDITIONS,
    slots,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const check = process.argv.includes('--check');
  const table = await buildTable();
  const json = JSON.stringify(table, null, 1) + '\n';

  if (check) {
    const existing = readFileSync(OUT_FILE, 'utf8');
    if (existing === json) {
      const total = Object.values(table.slots).reduce((n, s) => n + Object.values(s).reduce((m, v) => m + v.length, 0), 0);
      console.log(`voiceFuzzyAcceptance.json up to date (${total} accepts)`);
      return;
    }
    const a = JSON.parse(existing);
    for (const [slot, entries] of Object.entries(table.slots)) {
      const b = a.slots[slot] || {};
      for (const [token, accepts] of Object.entries(entries)) {
        if (JSON.stringify(accepts) !== JSON.stringify(b[token] || [])) {
          console.error(`drift in slot "${slot}" token "${token}":\n  fixture: ${JSON.stringify(b[token])}\n  computed: ${JSON.stringify(accepts)}`);
        }
      }
    }
    console.error('voiceFuzzyAcceptance.json is STALE — run: node scripts/gen_voice_fuzzy_acceptance.mjs');
    process.exit(1);
  }

  writeFileSync(OUT_FILE, json);
  const total = Object.values(table.slots).reduce((n, s) => n + Object.values(s).reduce((m, v) => m + v.length, 0), 0);
  console.log(`wrote voiceFuzzyAcceptance.json (${total} accepts, ${_wordCount} words)`);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
