// gen-vosk-grammar.mjs — build the Vosk setGrammar word lists from the REAL
// parser tables and materialize them into electron/voice-grammar.json.
//
// The grammar is the accuracy core of the voice backend: Vosk's decoder is
// constrained to these words, so whatever the recognizer emits is always
// inside the post-processing vocabulary (no more SAPI open-dictation noise).
// The JSON is committed and pinned by tests/components/MapWindows/
// voiceGrammarConsistency.test.js — any parser-table edit without regenerating
// fails `npm test`.
//
// Usage:
//   node scripts/gen-vosk-grammar.mjs            # write electron/voice-grammar.json
//   node scripts/gen-vosk-grammar.mjs --check    # compare against committed JSON (exit 1 on drift)
//
// Both lists are lowercased (en) / verbatim (zh), deduped, sorted. No
// timestamps — deterministic output.

import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  EN_PATTERNS, ZH_PATTERNS, EN_CONNECTORS, EN_CFA_HEADS,
  EN_APPROACH_TYPES, EN_RUNWAY_SUFFIX,
} from '../src/components/MapWindows/voiceTranscriptParser.js';
import {
  EN_NUMBER_KEYS, EN_UNIT_WORDS, ZH_DIGIT, ZH_UNIT_WORDS,
} from '../src/components/MapWindows/voiceNumberParser.js';
import {
  getSpokenNameWords, EN_FILLER_WORDS,
} from '../src/components/MapWindows/voiceCallsignParser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'electron', 'voice-grammar.json');

/** Spoken airline short forms for ZH callsigns (from voiceCallsignParser's
 *  zhShortForms — kept in sync by the consistency test via getSpokenToCode). */
const ZH_SHORT_FORMS = ['东方', '东航', '国航', '南航', '海航', '海南', '深航', '川航', '厦航', '春秋', '奥凯', '西藏'];

/** Literal phraseology words that are load-bearing for the recognizer to
 *  stay on-phraseology ("…heavy contact tower…"). en 'heavy' and zh '重'/
 *  '重型' are CONSUMED by the callsign parser (optional Heavy keyword);
 *  tower/contact/ground and 联系/塔台/地面/跑道 remain tolerated-only. */
const EN_PHRASEOLOGY = ['heavy', 'tower', 'contact', 'ground'];
const ZH_PHRASEOLOGY = ['联系', '塔台', '重', '重型', '地面', '跑道', '航道', '左', '右', '中'];

/** Aviation number extras not in EN_NUMBER_KEYS: 'triple'/'double' group
 *  digits, 'niner' is the radio pronunciation of nine (the fuzzy layer maps
 *  it at distance 1 — including it keeps the decoder from doing that work). */
const EN_NUMBER_EXTRAS = ['triple', 'double', 'niner'];

export function collectGrammarWords() {
  const words = new Set();
  const wordsZh = new Set();

  // ── EN ────────────────────────────────────────────────────────────────
  for (const p of EN_PATTERNS) for (const w of p.words) words.add(w);
  for (const w of EN_CFA_HEADS) words.add(w);
  for (const w of EN_APPROACH_TYPES) words.add(w);
  for (const w of EN_CONNECTORS) words.add(w);
  for (const w of EN_FILLER_WORDS) words.add(w);
  for (const w of EN_NUMBER_KEYS) words.add(w);
  for (const w of EN_NUMBER_EXTRAS) words.add(w);
  for (const w of Object.keys(EN_UNIT_WORDS)) words.add(w);
  for (const w of getSpokenNameWords()) words.add(w);
  // cfa connective + approach nouns + runway designator
  for (const w of ['for', 'the', 'approach', 'appr', 'runway']) words.add(w);
  for (const w of EN_RUNWAY_SUFFIX) words.add(w);
  for (const w of EN_PHRASEOLOGY) words.add(w);

  // ── ZH ────────────────────────────────────────────────────────────────
  for (const p of ZH_PATTERNS) wordsZh.add(p.chars);
  for (const w of Object.keys(ZH_DIGIT)) wordsZh.add(w);
  for (const w of Object.keys(ZH_UNIT_WORDS)) wordsZh.add(w);
  for (const w of ['然后', '还有', '请']) wordsZh.add(w);
  for (const w of ZH_SHORT_FORMS) wordsZh.add(w);
  for (const w of ZH_PHRASEOLOGY) wordsZh.add(w);

  return {
    words: [...words].sort(),
    wordsZh: [...wordsZh].sort(),
  };
}

export function grammarJson() {
  return { version: 1, ...collectGrammarWords() };
}

// ── CLI entry ──────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const fresh = grammarJson();
  if (check) {
    if (!existsSync(OUT)) {
      console.error('[grammar] MISSING committed voice-grammar.json — run `node scripts/gen-vosk-grammar.mjs`');
      process.exit(1);
    }
    const committed = JSON.parse(readFileSync(OUT, 'utf8'));
    const drift = JSON.stringify(committed) !== JSON.stringify(fresh);
    console.log(`[grammar] en: ${fresh.words.length} words, zh: ${fresh.wordsZh.length} words`);
    if (drift) {
      console.error('[grammar] DRIFT: parser tables changed — regenerate with `node scripts/gen-vosk-grammar.mjs`');
      process.exit(1);
    }
    console.log('[grammar] OK — committed JSON matches parser tables');
    process.exit(0);
  }
  writeFileSync(OUT, JSON.stringify(fresh, null, 2) + '\n');
  console.log(`[grammar] wrote ${OUT} (en: ${fresh.words.length}, zh: ${fresh.wordsZh.length})`);
}
