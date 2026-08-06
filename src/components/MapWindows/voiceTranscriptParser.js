/**
 * Voice transcript → patch-command chain parser — the shared core of the
 * voice pipeline (useVoiceCommands in-app, scripts/voice_sim.mjs for the
 * audio-free CLI sim).
 *
 * Pipeline: detectLanguage → parseCallsign (aircraft match → selection) →
 * greedy pattern match over the remaining text → sendPatchCommand payloads.
 * Output payloads are byte-identical to what the FlightPatchCommandBar
 * composer's buildPending produces (shared builders in src/utils/patchCommands.js).
 *
 * Pure + DOM-free with explicit .js specifiers so Node can load it directly.
 *
 * Translation rules (human phrase → command):
 *   heading:  fly heading N / heading N / turn to heading N /
 *             turn left|right heading N / left|right heading N        → update_heading (absolute)
 *   altitude: climb|descend and maintain N / climb|descend to N /
 *             fly altitude N / altitude N / level (off) (at) N /
 *             maintain N / flight level N                             → altitude
 *   speed:    reduce (speed) to N / increase speed to N / slow (down) to N /
 *             fly speed N / speed N / maintain N knots                → update_speed
 *   cfa:      clear(ed) (for) (the) [ils|rnav|visual|loc|vor|ndb] approach|appr
 *             → clear_for_appr (supersedes chain); a trailing
 *             "runway N (left|right|center)" designator is consumed and
 *             ignored — the aircraft's assigned runway stays authoritative
 *   direct:   fly direct to X / direct to X / direct X / 直飞(向|至) X
 *             → update_heading toward the waypoint (bearing from the
 *             aircraft's live position to the fix); X = the current
 *             airport's waypoint name, matched exact-first then D-L ≤ 2,
 *             or a spelled letter sequence ("bee ee el tee tee" → BELTT)
 *   bare callsign: selection only (no command)
 *
 * Disambiguation for bare "maintain N": unit word wins (knots→speed,
 * feet→altitude); flight level→altitude ×100; else N ≥ 1000 → altitude,
 * N < 1000 → speed. Altitudes spoken in meters (米 / meters / m) are
 * converted to feet before the payload is built (the wire contract is feet).
 *
 * Anything unmatched becomes a notice ("unsupported: …") — never dropped.
 */

import { detectLanguage, parseCallsign, callsignCandidates, EN_FILLER_WORDS } from './voiceCallsignParser.js';
import { parseSpokenNumberValue, lookupUnitWord, EN_UNIT_WORDS, EN_NUMBER_WORD_KEYS } from './voiceNumberParser.js';
import {
  isFuzzyEligible, maxDistForWord, fuzzyMatch, resolveCuratedPhrase,
  damerauLevenshtein, skeletonMatch, LETTER_WORD_TO_LETTER, TWO_TOKEN_LETTERS,
} from './voiceFuzzy.js';
import {
  buildHeadingPayload, buildAltitudePayload, buildSpeedPayload,
  buildClearApprPayload, pad3, FT_PER_METER, bearingDegrees,
} from '../../utils/patchCommands.js';

// ─── Pattern tables (longest prefix first) ─────────────────────────────
// (exported for scripts/gen_voice_fuzzy_acceptance.mjs — the fuzzy
// acceptance table is generated from the REAL tables, never duplicated)

export const EN_PATTERNS = [
  { type: 'heading', words: ['turn', 'left', 'heading'] },
  { type: 'heading', words: ['turn', 'right', 'heading'] },
  { type: 'heading', words: ['turn', 'to', 'heading'] },
  { type: 'altitude', words: ['climb', 'and', 'maintain'] },
  { type: 'altitude', words: ['descend', 'and', 'maintain'] },
  { type: 'altitude', words: ['level', 'off', 'at'] },
  { type: 'speed', words: ['reduce', 'speed', 'to'] },
  { type: 'speed', words: ['increase', 'speed', 'to'] },
  { type: 'speed', words: ['slow', 'down', 'to'] },
  { type: 'heading', words: ['fly', 'heading'] },
  { type: 'heading', words: ['left', 'heading'] },
  { type: 'heading', words: ['right', 'heading'] },
  { type: 'altitude', words: ['fly', 'altitude'] },
  { type: 'speed', words: ['fly', 'speed'] },
  { type: 'fl', words: ['flight', 'level'] },
  { type: 'altitude', words: ['climb', 'to'] },
  { type: 'altitude', words: ['descend', 'to'] },
  { type: 'speed', words: ['reduce', 'to'] },
  { type: 'speed', words: ['slow', 'to'] },
  { type: 'altitude', words: ['level', 'at'] },
  { type: 'altitude', words: ['level', 'off'] },
  { type: 'heading', words: ['heading'] },
  { type: 'altitude', words: ['altitude'] },
  { type: 'maintain', words: ['maintain'] },
  { type: 'speed', words: ['speed'] },
  { type: 'fl', words: ['fl'] },
  // Direct-to-waypoint (the waypoint name is the value — see matchWaypointValue).
  // 'flight' is the STT's render of 'fly' ("flight direct duffy") — same
  // grammar keys (EN_PATTERN_KEYS unchanged), just more lenient prefixes.
  { type: 'direct', words: ['fly', 'direct', 'to'] },
  { type: 'direct', words: ['flight', 'direct', 'to'] },
  { type: 'direct', words: ['direct', 'to'] },
  { type: 'direct', words: ['flight', 'direct'] },
  { type: 'direct', words: ['direct'] },
];

export const ZH_PATTERNS = [
  { type: 'altitude', chars: '爬升保持' },
  { type: 'altitude', chars: '下降保持' },
  { type: 'heading', chars: '左转航向' },
  { type: 'heading', chars: '右转航向' },
  { type: 'heading', chars: '转向航向' },
  { type: 'cfa', chars: '可以进近' },
  { type: 'cfa', chars: '允许进近' },
  { type: 'heading', chars: '飞航向' },
  { type: 'altitude', chars: '飞高度' },
  { type: 'fl', chars: '高度层' },
  { type: 'speed', chars: '减速至' },
  { type: 'speed', chars: '加速至' },
  { type: 'speed', chars: '飞速度' },
  { type: 'altitude', chars: '爬升至' },
  { type: 'altitude', chars: '下降至' },
  { type: 'heading', chars: '航向' },
  { type: 'altitude', chars: '高度' },
  { type: 'altitude', chars: '平飞' },
  { type: 'maintain', chars: '保持' },
  { type: 'speed', chars: '速度' },
  { type: 'cfa', chars: '进近' },
  // 2026-08-06: implicit-meters + approach phraseology
  { type: 'altitude', chars: '下降到' },
  { type: 'altitude', chars: '下到' },
  { type: 'speed', chars: '减速到' },
  { type: 'heading', chars: '航向飞' },
  { type: 'cfa', chars: '可以盲降进近' },
  { type: 'cfa', chars: '建立下滑道' },
  { type: 'cfa', chars: '建立下滑到' },   // homophone of 下滑道 as spoken
  { type: 'cfa', chars: '建立' },          // 建立三六右航道 — needs the runway guard in matchSegment
  // Direct-to-waypoint — the waypoint name stays ENGLISH ("直飞 BELTT");
  // the sort below puts 直飞向/直飞至 before 直飞.
  { type: 'direct', chars: '直飞向' },
  { type: 'direct', chars: '直飞至' },
  { type: 'direct', chars: '直飞' },
];

// Sort longest-first so the most specific prefix wins
EN_PATTERNS.sort((a, b) => b.words.length - a.words.length);
ZH_PATTERNS.sort((a, b) => b.chars.length - a.chars.length);

/** Fuzzy-eligible EN pattern words (exact-only: 'fl', 'at' — too short).
 *  Exported for scripts/gen_voice_fuzzy_acceptance.mjs. */
export const EN_PATTERN_KEYS = [...new Set(EN_PATTERNS.flatMap((p) => p.words))]
  .filter((w) => isFuzzyEligible(w));

// Filler words ("uh", "um", …) chain like connectors so "…and uh reduce
// speed to 180" parses; they carry no meaning. 'i' is the STT's stray
// pronoun/digit fragment ("and i clear for the ios approach…") — 1-char,
// exact-only everywhere, and deliberately NOT a filler (the callsign path
// and the non-fuzzy set must not strip it).
export const EN_CONNECTORS = new Set(['and', 'then', 'also', 'please', 'i', ...EN_FILLER_WORDS]);
const ZH_CONNECTORS = ['然后', '还有', '请'];

// Flexible EN clear-for-approach grammar (replaces the fixed table entries):
//   clear|cleared [for] [the] [ils|rnav|visual|loc|vor|ndb] approach|appr
export const EN_CFA_HEADS = new Set(['clear', 'cleared']);
export const EN_APPROACH_TYPES = new Set(['ils', 'rnav', 'visual', 'loc', 'vor', 'ndb']);

/** Fuzzy-eligible approach types (all ≥ 3 chars). Exported for the generator. */
export const EN_APPROACH_TYPE_KEYS = [...EN_APPROACH_TYPES];

// Runway suffix after a cfa phrase — full words (speech) or letters (typed
// "13L"). Plural forms are dictation artifacts ("runway four rights").
export const EN_RUNWAY_SUFFIX = new Set(['left', 'right', 'center', 'lefts', 'rights', 'centers', 'l', 'r', 'c']);

/** Words that must never fuzzy-map to digits in a runway number scan —
 *  'right' is D-L 1 from 'eight' and without this guard "runway three one
 *  right" scans 3,1,8 → 318 → out of range → notice. The flight-number path
 *  has the same protection via FLIGHT_NUMBER_FUZZY_GUARD; only 'right'
 *  actually collides ('left'/'center' are D-L ≥ 3 from every number key,
 *  l/r/c are 1-char exact-only) — all three stay for robustness. */
const EN_RUNWAY_NUMBER_GUARD = new Set(['right', 'left', 'center']);

/** Curated 1-token confusables for the cfa 'for' slot — 'foot' is D-L 2
 *  from 'for' (over the 3-char cap) but already a grammar word (unit slot),
 *  so the recognizer can emit it. Slot-local, never fuzzy (the 2/3-token
 *  CURATED_CONFUSABLES table is spelled-out forms only). */
const EN_CFA_FOR_VARIANTS = new Map([['foot', 'for']]);

// ─── Prefix matching ──────────────────────────────────────────────────

function matchEnPrefix(rest, pattern) {
  const tokens = rest.split(/\s+/);
  if (tokens.length < pattern.words.length) return null;
  // Deviation budget: at most ONE deviation per pattern match — either one
  // connector-skip or one fuzzy/curated word, never both, never twice.
  let k = 0;
  let deviated = false;
  for (let j = 0; j < pattern.words.length; j++) {
    const pw = pattern.words[j];
    const tok = tokens[k] ? tokens[k].toLowerCase() : null;
    if (tok === pw) { k++; continue; }
    if (deviated) return null;   // second deviation anywhere → no match

    // Curated 2-token window ("eff el" → fl)
    const joined2 = tok && tokens[k + 1] ? tok + ' ' + tokens[k + 1].toLowerCase() : null;
    if (joined2 && resolveCuratedPhrase(joined2) === pw) { deviated = true; k += 2; continue; }

    // Connector-skip: one stray connector token swallowed when the NEXT
    // token is the exact pattern word ("climb and THEN maintain 9000",
    // "turn left UH heading 360" — fillers chain via EN_CONNECTORS).
    if (j > 0 && tok && EN_CONNECTORS.has(tok) && tokens[k + 1] && tokens[k + 1].toLowerCase() === pw) {
      deviated = true; k += 2; continue;
    }

    // Single-token fuzzy (per-candidate D-L caps; 'reading' → heading)
    const m = tok ? fuzzyMatch(tok, EN_PATTERN_KEYS) : null;
    if (m && m.candidate === pw) { deviated = true; k++; continue; }
    return null;
  }
  return { type: pattern.type, text: pattern.words.join(' '), rest: tokens.slice(k).join(' ') };
}

function matchZhPrefix(rest, pattern) {
  if (!rest.startsWith(pattern.chars)) return null;
  return { type: pattern.type, text: pattern.chars, rest: rest.slice(pattern.chars.length) };
}

/** Strip leading connectors + punctuation so "and reduce speed…" parses. */
function stripConnector(rest, zh) {
  if (zh) {
    let s = rest;
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of ZH_CONNECTORS) {
        if (s.startsWith(c)) { s = s.slice(c.length); changed = true; }
      }
      const m = s.match(/^[，。；;,\s]+/);
      if (m) { s = s.slice(m[0].length); changed = true; }
    }
    return s;
  }
  const tokens = rest.split(/\s+/);
  let k = 0;
  while (k < tokens.length && (EN_CONNECTORS.has(tokens[k].toLowerCase()) || !/[a-z0-9一-鿿]/i.test(tokens[k]))) k++;
  return tokens.slice(k).join(' ');
}

// ─── Clear-for-approach: flexible EN grammar + consume-only runway ─────

/** EN "clear(ed) (for) (the) [type] approach|appr" — the approach tail is
 *  REQUIRED, so "clear the runway" / "cleared to land" / "cleared for the
 *  ILS" (no tail) deliberately fail → the normal unsupported path notices.
 *
 *  Deviation budget (mirrors matchEnPrefix): between the head and the tail,
 *  free skips of the canonical 'for'/'the' slots, connectors/fillers ('ah')
 *  and number words ('forty' mishears "for the", a stray 'oh' is a digit
 *  word — the slots are optional anyway), plus AT MOST ONE deviant token —
 *  a curated 'foot'→'for' variant or a fuzzy approach type ("rnavv"→rnav).
 *  A second deviation anywhere → null. Exact approach types and curated
 *  spelled windows stay free. */
function matchCfaEn(rest) {
  const tokens = rest.split(/\s+/);
  if (!tokens.length || !EN_CFA_HEADS.has(tokens[0].toLowerCase())) return null;
  let i = 1;
  let deviated = false;
  for (;;) {
    const tok = tokens[i] ? tokens[i].toLowerCase() : null;
    if (!tok) return null;                          // ran out before the tail
    if (tok === 'for' || tok === 'the') { i += 1; continue; }
    if (EN_CONNECTORS.has(tok) || EN_NUMBER_WORD_KEYS.has(tok)) { i += 1; continue; }
    if (!deviated && EN_CFA_FOR_VARIANTS.has(tok)) { deviated = true; i += 1; continue; }
    // Approach type: exact → curated 2-3 token spelled window ("r nav",
    // "eye el ess") → single-token D-L ≤ 1 ("rnavv" → rnav, "nav" → rnav).
    if (EN_APPROACH_TYPES.has(tok)) { i += 1; continue; }
    const w3 = tokens[i + 1] && tokens[i + 2] ? tok + ' ' + tokens[i + 1].toLowerCase() + ' ' + tokens[i + 2].toLowerCase() : null;
    const w2 = tokens[i + 1] ? tok + ' ' + tokens[i + 1].toLowerCase() : null;
    if (w3 && resolveCuratedPhrase(w3)) { i += 3; continue; }
    if (w2 && resolveCuratedPhrase(w2)) { i += 2; continue; }
    // Spelled-letter approach types the curated table doesn't know — "eye
    // oh ess" → i-o-s ≈ ils (D-L 1). Greedy letter run (reuses the waypoint
    // slot's letter tables), joined ≥ 3 letters, closed set; one budget
    // deviation like the single-token fuzzy. Runs before the fuzzy branch
    // so 'oh' (a number word) can't be free-skipped out of "eye oh ess".
    if (!deviated) {
      let letters = '';
      let k2 = i;
      while (k2 < tokens.length && letters.length < 6) {
        const t2 = tokens[k2 + 1] ? tokens[k2].toLowerCase() + ' ' + tokens[k2 + 1].toLowerCase() : null;
        if (t2 && TWO_TOKEN_LETTERS.has(t2)) { letters += TWO_TOKEN_LETTERS.get(t2); k2 += 2; continue; }
        const ch = LETTER_WORD_TO_LETTER.get(tokens[k2].toLowerCase());
        if (!ch) break;
        letters += ch;
        k2 += 1;
      }
      if (letters.length >= 3) {
        const m = fuzzyMatch(letters, EN_APPROACH_TYPE_KEYS, 1);
        if (m) { deviated = true; i = k2; continue; }
      }
    }
    if (!deviated && fuzzyMatch(tok, EN_APPROACH_TYPE_KEYS, 1)) { deviated = true; i += 1; continue; }
    break;                                          // not part of the head — the tail must be next
  }
  const tail = tokens[i] && tokens[i].toLowerCase();
  if (tail !== 'approach' && tail !== 'appr') return null;
  i += 1;
  return { type: 'cfa', text: tokens.slice(0, i).join(' '), rest: tokens.slice(i).join(' ') };
}

/** Spoken forms of runway numbers 1–36 for the phonetic fallback —
 *  digit-by-digit ("three one"), teens ("thirteen"), tens+ones
 *  ("thirty one"). Memoized. */
let _runwayForms = null;
function runwaySpokenForms() {
  if (_runwayForms) return _runwayForms;
  const digits = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const teens = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['twenty', 'thirty'];
  const forms = new Map();   // joined form → number
  for (let n = 1; n <= 36; n++) {
    const d1 = Math.floor(n / 10);
    const d0 = n % 10;
    forms.set(n < 10 ? digits[d0] : `${digits[d1]} ${digits[d0]}`, n);   // digit-by-digit
    if (n >= 10 && n <= 19) forms.set(teens[n - 10], n);                 // teens
    if (n >= 20) forms.set(d0 ? `${tens[d1 - 2]} ${digits[d0]}` : tens[d1 - 2], n);   // tens + ones
  }
  _runwayForms = forms;
  return forms;
}

/** Curated 1-token confusables for the runway slot — 'through'/'three' are
 *  a θr skeleton D-L-0 pair that the raw D-L (2) and the skeleton stage
 *  (needs exactly 1) both miss; 'urine' is pure dictation noise. Slot-local,
 *  like EN_CFA_FOR_VARIANTS — the substituted window must still be a real
 *  spoken form, so closed-set safety holds ("runway through urine right" →
 *  "three one" → 31). */
const EN_RUNWAY_CONFUSABLES = new Map([['through', 'three'], ['urine', 'one']]);

/** Phonetic skeleton fallback for the runway slot — tried only when the
 *  number scan fails ("runway ethiopian right" → 'ethiopian' ≈ 'three one'
 *  → 31). 2-token window first, then 1 (a fully-substituted form like
 *  "through urine" → "three one" must win over the 1-token misfire).
 *  Suffix words and 'runway'/'rwy' never enter a window. Substituted
 *  windows are checked as EXACT spoken forms first (sidesteps the skeleton
 *  D-L-exactly-1 rule), then skeletonMatch. Unique best wins, ties fail. */
function runwaySkeletonMatch(tokens, i) {
  const candidates = [...runwaySpokenForms().keys()];
  for (let len = 2; len >= 1; len--) {
    const win = tokens.slice(i, i + len).map(t => t.toLowerCase()).join(' ');
    if (!win) break;
    if (len === 1 && (EN_RUNWAY_SUFFIX.has(win) || win === 'runway' || win === 'rwy')) return null;
    const sub = tokens.slice(i, i + len)
      .map(t => EN_RUNWAY_CONFUSABLES.get(t.toLowerCase()) ?? t.toLowerCase())
      .join(' ');
    if (runwaySpokenForms().has(sub)) return { value: runwaySpokenForms().get(sub), consumed: len };
    const m = skeletonMatch(sub, candidates);
    if (m) return { value: runwaySpokenForms().get(m), consumed: len };
  }
  return null;
}

/** Consume-and-ignore a runway designator after a clear-for-approach phrase
 *  ("runway 13 left", "rwy one three", "runway 13L"). The designator is
 *  parsed and range-checked (1–36) but NEVER becomes a command or notice —
 *  the aircraft's assigned runway stays authoritative (user decision
 *  2026-08-05). Returns { rest } on a full match, or null (nothing consumed;
 *  the caller falls through → "runway banana" becomes an unsupported notice). */
function matchRunwayValue(rest, zh) {
  if (zh) {
    // ZH: [跑道|航道] number [左|右|中] [跑道|航道] — consumed and ignored
    // (三六右航道, 跑道幺八, 幺八左航道; same consume-only contract as EN).
    const str = stripConnector(rest, true);
    let i = 0;
    const lead = /^(跑道|航道)/.exec(str);
    if (lead) i += lead[0].length;
    const num = parseSpokenNumberValue(str.slice(i), 'zh');
    if (!num || num.value < 1 || num.value > 36) return null;
    i += num.consumed;
    if (str[i] === '左' || str[i] === '右' || str[i] === '中') i += 1;
    const tail = /^(跑道|航道)/.exec(str.slice(i));
    if (tail) i += tail[0].length;
    return { rest: str.slice(i) };
  }
  const tokens = stripConnector(rest, false).split(/\s+/).filter(Boolean);
  if (!tokens.length || !tokens[0]) return null;
  const head = tokens[0].toLowerCase();
  if (head !== 'runway' && head !== 'rwy') return null;
  let i = 1;
  let value = 0;
  const attached = (tokens[i] || '').match(/^(\d{1,2})([lrc])$/i);   // typed "13L" — parseSpokenNumberValue can't see this token
  if (attached) {
    value = parseInt(attached[1], 10);
    i += 1;
  } else {
    // The suffix guard stops 'right' from fuzzy-mapping to 'eight'
    // ("runway three one right" scans 3,1 + suffix — not 318).
    const num = parseSpokenNumberValue(tokens.slice(i), 'en', EN_RUNWAY_NUMBER_GUARD);
    if (!num) {
      // Phonetic fallback — the number scan failed entirely ("runway
      // ethiopian right" → 'ethiopian' ≈ 'three one' → 31).
      const skel = runwaySkeletonMatch(tokens, i);
      if (!skel) return null;
      value = skel.value;
      i += skel.consumed;
    } else {
      value = num.value;
      i += num.consumed;
    }
  }
  if (value < 1 || value > 36) return null;
  if (EN_RUNWAY_SUFFIX.has((tokens[i] || '').toLowerCase())) i += 1;
  return { rest: tokens.slice(i).join(' ') };
}

// ─── Waypoint slot (direct-to phrases) ──────────────────────────────────

const WAYPOINT_FUZZY_CAP = 2;   // flat cap for every name length (locked decision)

/**
 * Waypoint-slot value parser for 'direct' phrases. Deterministic per the
 * locked rules: exact always wins; D-L cap is a FLAT 2 for every name
 * (never maxDistForWord); strictly-lower distance wins, ties first-wins;
 * single token tried first, spelled-letter sequence second.
 *
 * Path 2 (spelled) greedily consumes consecutive letter tokens — letter
 * names / NATO words / bare letters, incl. multi-token forms ("double
 * you") — maps each to a letter, joins, and matches names longest-first
 * (names are 3–5 letters; the sequence is capped at 5).
 *
 * @param {string} rest — remainder after the pattern words ("BELTT" /
 *        "bee ee el tee tee")
 * @param {Array<{name:string, x:number, z:number}>} waypoints — per-airport fixes
 * @returns {{name:string, x:number, z:number, consumed:number} | null}
 */
export function matchWaypointValue(rest, waypoints) {
  const tokens = String(rest || '').split(/\s+/).filter(Boolean);
  if (!tokens.length || !Array.isArray(waypoints) || !waypoints.length) return null;
  const names = waypoints
    .filter((w) => w && typeof w.name === 'string')
    .map((w) => ({ name: w.name, x: w.x, z: w.z, lower: w.name.toLowerCase() }));

  // Path 1 — single token: exact first, then flat D-L ≤ 2. A token that IS
  // a spoken letter form ('bee', 'tee', …) never takes the D-L fuzzy path —
  // it's clearly a spelling ("bee" must not degrade to a 3-letter fix at
  // distance 2); the spelled path below handles it.
  const t0 = tokens[0].toLowerCase();
  const isLetterForm = LETTER_WORD_TO_LETTER.has(t0);
  for (const n of names) if (n.lower === t0) return { name: n.name, x: n.x, z: n.z, consumed: 1 };
  let best = null;
  if (!isLetterForm) {
    for (const n of names) {
      if (Math.abs(n.lower.length - t0.length) > WAYPOINT_FUZZY_CAP) continue;
      const d = damerauLevenshtein(t0, n.lower);
      if (d > 0 && d <= WAYPOINT_FUZZY_CAP && (!best || d < best.d)) {
        best = { name: n.name, x: n.x, z: n.z, consumed: 1, d };
      }
    }
  }
  if (best) return best;

  // Path 2 — spelled sequence of letters. Track tokens-per-letter so
  // consumed (used for rest.slice) counts TOKENS, not letters.
  const letters = [];
  const perLetter = [];
  let k = 0;
  while (k < tokens.length) {
    const two = tokens[k + 1] ? tokens[k].toLowerCase() + ' ' + tokens[k + 1].toLowerCase() : null;
    if (two && TWO_TOKEN_LETTERS.has(two)) { letters.push(TWO_TOKEN_LETTERS.get(two)); perLetter.push(2); k += 2; continue; }
    const ch = LETTER_WORD_TO_LETTER.get(tokens[k].toLowerCase());
    if (!ch) break;
    letters.push(ch);
    perLetter.push(1);
    k += 1;
  }
  if (letters.length >= 3) {
    const maxLen = Math.min(letters.length, 5);   // names are 3–5 letters
    const consumedTokens = (len) => perLetter.slice(0, len).reduce((a, b) => a + b, 0);
    const spellMatch = (exactOnly) => {
      for (let len = maxLen; len >= 3; len--) {
        const joined = letters.slice(0, len).join('');
        for (const n of names) {
          if (n.lower === joined) return { name: n.name, x: n.x, z: n.z, consumed: consumedTokens(len) };
        }
        if (exactOnly) continue;
        let sBest = null;
        for (const n of names) {
          if (Math.abs(n.lower.length - joined.length) > WAYPOINT_FUZZY_CAP) continue;
          const d = damerauLevenshtein(joined, n.lower);
          if (d > 0 && d <= WAYPOINT_FUZZY_CAP && (!sBest || d < sBest.d)) {
            sBest = { name: n.name, x: n.x, z: n.z, consumed: consumedTokens(len), d };
          }
        }
        if (sBest) return sBest;
      }
      return null;
    };
    const exact = spellMatch(true);
    if (exact) return exact;
    const fuzzy = spellMatch(false);
    if (fuzzy) return fuzzy;
  }
  return null;
}

// ─── Value parsing (number + optional FL/unit after a prefix) ──────────

function parseCommandValueEn(remainder, forceFl) {
  const tokens = remainder.trim().split(/\s+/);
  if (!tokens.length || !tokens[0]) return null;
  let i = 0;
  let fl = !!forceFl;   // pattern type 'fl' already consumed the FL words
  if (!fl && tokens[0].toLowerCase() === 'flight' && (tokens[1] || '').toLowerCase() === 'level') { fl = true; i = 2; }
  else if (!fl && tokens[0].toLowerCase() === 'fl') { fl = true; i = 1; }
  else if (!fl) {
    // Curated spelled FL ("eff el 90") — the D-L distance can't catch letters
    const joined = tokens[1] ? tokens[0].toLowerCase() + ' ' + tokens[1].toLowerCase() : null;
    if (joined && resolveCuratedPhrase(joined) === 'fl') { fl = true; i = 2; }
  }
  const num = parseSpokenNumberValue(tokens.slice(i), 'en');
  if (!num) return null;
  let unit = null;
  const after = tokens.slice(i + num.consumed);
  const unitKey = after[0] ? lookupUnitWord(after[0].toLowerCase()) : undefined;
  if (unitKey !== undefined) { unit = EN_UNIT_WORDS[unitKey]; i += num.consumed + 1; }
  else i += num.consumed;
  return { value: num.value, fl, unit, text: tokens.slice(0, i).join(' '), rest: tokens.slice(i).join(' ') };
}

function parseCommandValueZh(remainder, forceFl) {
  const str = remainder.trim();
  if (!str) return null;
  let i = 0;
  let fl = !!forceFl;   // pattern type 'fl' already consumed the 高度层 chars
  if (!fl && str.startsWith('高度层')) { fl = true; i = 3; }
  const num = parseSpokenNumberValue(str.slice(i), 'zh');
  if (!num) return null;
  let unit = null;
  if (str.startsWith('英尺', i + num.consumed)) { unit = 'altitude'; i += num.consumed + 2; }
  else if (str.startsWith('米', i + num.consumed)) { unit = 'altitude-m'; i += num.consumed + 1; }
  else if (str[i + num.consumed] === '节') { unit = 'speed'; i += num.consumed + 1; }
  else i += num.consumed;
  return { value: num.value, fl, unit, text: str.slice(0, i), rest: str.slice(i) };
}

// ─── Type resolution, range checks, command building ───────────────────

/** The pattern's type → final payload type (resolves the maintain ambiguity). */
function resolveType(patternType, pv, zh) {
  switch (patternType) {
    case 'heading': return 'update_heading';
    case 'altitude':
    case 'fl': return 'altitude';
    case 'speed': return 'update_speed';
    case 'maintain':
      if (pv.unit === 'speed') return 'update_speed';
      if (pv.unit === 'altitude' || pv.unit === 'altitude-m' || pv.fl) return 'altitude';
      if (zh && !pv.fl && pv.value < 100) return 'altitude';   // zh <100 = ×100 m shorthand (保持15 → 1500 m)
      return pv.value >= 1000 ? 'altitude' : 'update_speed';
    case 'cfa': return 'clear_for_appr';
    default: return null;
  }
}

/** Range check (out of range → the phrase is reported unsupported). */
function rangeCheck(type, value, fl) {
  if (type === 'update_heading') return value >= 1 && value <= 360;
  if (type === 'altitude') {
    if (fl && value > 250) return false;   // flight levels only up to 250
    const ft = fl ? value * 100 : value;
    return ft >= 500 && ft <= 60000;
  }
  if (type === 'update_speed') return value >= 90 && value <= 300;
  return true;
}

function buildCommand(type, callSign, value, fl, ctx) {
  if (type === 'update_heading') {
    return { type, label: 'Fly Heading ' + pad3(value), payload: buildHeadingPayload(callSign, value) };
  }
  if (type === 'altitude') {
    const ft = fl ? value * 100 : value;
    return { type, label: 'Fly Altitude ' + ft, payload: buildAltitudePayload(callSign, ft) };
  }
  if (type === 'update_speed') {
    return { type, label: 'Fly Speed ' + value, payload: buildSpeedPayload(callSign, value) };
  }
  if (type === 'clear_for_appr') {
    return { type, label: 'Clear for Approach', payload: buildClearApprPayload(callSign) };
  }
  if (type === 'direct') {
    // Fly-heading toward the fix: bearing from the aircraft's live position
    // to the waypoint. payload.type stays 'update_heading' — the wire
    // contract in electron/patchFrame.js serializes by payload type.
    const { aircraft, waypoint } = ctx || {};
    if (!aircraft?.position || !waypoint) return null;
    const hdg = bearingDegrees(aircraft.position.x, aircraft.position.z, waypoint.x, waypoint.z);
    return { type, label: 'Fly Direct To ' + waypoint.name, payload: buildHeadingPayload(callSign, hdg) };
  }
  return null;
}

// ─── Segment matching (greedy longest-prefix, leftover → notices) ──────

function matchSegment(segs, lang, callSign, aircraft, waypoints, commands, notices) {
  const zh = lang === 'zh';
  let i = 0;
  let rest = segs[0] || '';
  let unsupportedBuf = '';
  const flush = () => {
    if (unsupportedBuf) {
      notices.push('unsupported: "' + unsupportedBuf.trim() + '"');
      unsupportedBuf = '';
    }
  };

  while (rest || i < segs.length - 1) {
    if (!rest) {
      // Advance to the next segment — flush first so the unsupported buffer
      // never spans segments (same grouping as the old per-segment calls).
      flush();
      i += 1;
      rest = segs[i];
      continue;
    }
    rest = stripConnector(rest, zh);
    if (!rest) continue;

    let hit = null;
    if (!zh) {
      // Flexible clear-for-approach grammar, tried before the table at every
      // loop position so "…then clear for approach" still hits.
      const first = rest.split(/\s+/)[0].toLowerCase();
      if (first === 'clear' || first === 'cleared') hit = matchCfaEn(rest);
    }
    if (!hit) {
      const patterns = zh ? ZH_PATTERNS : EN_PATTERNS;
      for (const p of patterns) {
        const m = zh ? matchZhPrefix(rest, p) : matchEnPrefix(rest, p);
        if (m) { hit = m; break; }
      }
    }

    if (!hit) {
      // Nothing matched — consume one token as an unsupported chunk
      if (zh) {
        unsupportedBuf += rest[0];
        rest = rest.slice(1);
      } else {
        const sp = rest.search(/\s/);
        const word = sp === -1 ? rest : rest.slice(0, sp);
        unsupportedBuf += (unsupportedBuf ? ' ' : '') + word;
        rest = sp === -1 ? '' : rest.slice(sp + 1);
      }
      continue;
    }

    // Clear for Approach takes no value — an optional trailing runway
    // designator ("runway 13 left", comma-separated or not) is consumed
    // and ignored, never noticed.
    if (hit.type === 'cfa') {
      flush();
      // Bare 建立 must be followed by a runway designator to be an approach
      // clearance ("建立航线" — establish route — is NOT; 建立下滑道/到 and the
      // longer patterns are unaffected). Probe before committing the CFA.
      if (zh && hit.text === '建立') {
        const probe = hit.rest || (i + 1 < segs.length ? segs[i + 1] : '');
        const rw = probe ? matchRunwayValue(probe, zh) : null;
        if (!rw) {
          unsupportedBuf += hit.text + ' ';
          rest = hit.rest;
          continue;
        }
      }
      commands.push(buildCommand('clear_for_appr', callSign));
      rest = hit.rest;
      if (rest) {
        const rw = matchRunwayValue(rest, zh);
        if (rw) { rest = rw.rest; continue; }
      } else if (i + 1 < segs.length) {
        const rw = matchRunwayValue(segs[i + 1], zh);
        if (rw) { i += 1; rest = rw.rest; continue; }
      }
      continue;
    }

    // Direct-to-waypoint — the value is a fix NAME, not a number; consume
    // the whole rest on failure so a bad waypoint can't re-loop forever.
    if (hit.type === 'direct') {
      flush();
      const spoken = (hit.text + ' ' + (hit.rest || '')).trim();
      if (!waypoints || !waypoints.length) {
        notices.push('unsupported: "' + spoken + '" (no waypoint data)');
        rest = '';
        continue;
      }
      const pos = aircraft && aircraft.position;
      if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') {
        notices.push('unsupported: "' + spoken + '" (aircraft position unavailable)');
        rest = '';
        continue;
      }
      const m = matchWaypointValue(hit.rest, waypoints);
      if (!m) {
        notices.push('unsupported: "' + spoken + '" (unknown waypoint)');
        rest = '';
        continue;
      }
      const cmd = buildCommand('direct', callSign, null, false, { aircraft, waypoint: m });
      if (cmd) commands.push(cmd);
      rest = (hit.rest || '').split(/\s+/).slice(m.consumed).join(' ');
      continue;
    }

    const pv = zh ? parseCommandValueZh(hit.rest, hit.type === 'fl') : parseCommandValueEn(hit.rest, hit.type === 'fl');
    if (!pv) {
      // Prefix matched but no value ("heading" alone) — report unsupported
      unsupportedBuf += hit.text + ' ';
      rest = hit.rest;
      continue;
    }

    const type = resolveType(hit.type, pv, zh);
    // Spoken meters ("米" / "meters" / "m") → feet before the range gate and
    // payload build (wire contract is feet). ZH altitude numbers are ALWAYS
    // meters (implicit, no 米 word): a value < 100 is the two-digit shorthand
    // meaning ×100 m (幺八 → 1800 m, 保持15 → 1500 m), anything else is meters
    // as-is (两千四 → 2400 m). FL phrases are always feet, so both meter
    // paths are skipped under FL (nonsense phrase — FL+米 isn't real).
    let value;
    if (pv.unit === 'altitude-m' && !pv.fl) {
      value = Math.round(pv.value * FT_PER_METER);
    } else if (zh && type === 'altitude' && !pv.fl && pv.unit === null) {
      const m = pv.value < 100 ? pv.value * 100 : pv.value;
      value = Math.round(m * FT_PER_METER);
    } else {
      value = pv.value;   // 英尺 / FL / speed / heading unchanged
    }
    if (!rangeCheck(type, value, pv.fl)) {
      notices.push('unsupported: "' + (hit.text + ' ' + pv.text).trim() + '" (out of range)');
      rest = pv.rest;
      continue;
    }

    flush();
    const cmd = buildCommand(type, callSign, value, pv.fl);
    if (cmd) commands.push(cmd);
    rest = pv.rest;
  }

  flush();
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Parse a voice/typed transcript into a callsign (selection) + a command
 * chain of sendPatchCommand payloads.
 *
 * @param {string} transcript — raw transcript ("CSC6918: climb and maintain 9000, reduce speed to 180 knots")
 * @param {Object[]} aircraftList — live UDP aircraft (each has .callSign) for callsign resolution
 * @param {Object[]} [waypoints] — per-airport fixes [{name, x, z}] (from
 *   collectValues._airwayNodes); only needed for 'direct' phrases
 * @returns {{
 *   ok: boolean, callsign: string|null, aircraft: object|null, lang: 'en'|'zh',
 *   remainingText: string, commands: Array<{type, label, payload}>, notices: string[],
 *   renderedLine: string, reason?: string,
 * }} — commands empty = selection only; renderedLine mirrors the command
 *   window's line format ("CSC6918: Fly Altitude 9000, Fly Speed 180");
 *   reason (non-empty on ok:false) names the stage that stopped the parse.
 */
export function parseVoiceTranscript(transcript, aircraftList, waypoints = []) {
  const text = String(transcript || '').trim();
  if (!text) {
    return { ok: false, callsign: null, aircraft: null, lang: 'en', remainingText: '', commands: [], notices: [], renderedLine: '', reason: 'empty transcript' };
  }

  const lang = detectLanguage(text);
  const list = aircraftList && aircraftList.length ? aircraftList : null;
  const diag = [];
  const parsed = list ? parseCallsign(text, lang, list, diag) : null;

  if (!parsed) {
    return {
      ok: false, callsign: null, aircraft: null, lang,
      remainingText: text, commands: [], notices: [],
      renderedLine: '',
      reason: !list ? 'no aircraft data' : (diag.length ? diag.join('; ') : 'callsign parse failed'),
    };
  }

  const commands = [];
  const notices = [];
  if (parsed.remainingText && parsed.remainingText.trim()) {
    const segments = parsed.remainingText.split(/[,，;；.。]+/).map(s => s.trim()).filter(Boolean);
    if (segments.length) matchSegment(segments, lang, parsed.callsign, parsed.aircraft, waypoints, commands, notices);
  }

  // Clear for Approach supersedes a composed chain (mirrors the composer);
  // then dedupe by type, last wins (the composer allows one command of each type per line).
  let final = commands;
  if (final.some(c => c.type === 'clear_for_appr')) final = final.filter(c => c.type === 'clear_for_appr');
  const byType = new Map();
  for (const c of final) byType.set(c.type, c);
  final = [...byType.values()];

  return {
    ok: true,
    callsign: parsed.callsign,
    aircraft: parsed.aircraft,
    lang,
    remainingText: parsed.remainingText,
    commands: final,
    notices,
    renderedLine: renderLine(parsed.callsign, final),
  };
}

/**
 * Try candidate transcripts in order against the full voice pipeline —
 * the primary result first, then the worker's alternate hypotheses (if any,
 * already confidence-ordered). First candidate
 * whose parse yields commands wins; a selection-only candidate (ok, 0
 * commands) never wins over a failing primary — a misheard bare callsign
 * in an alternate must not trigger a selection. No winner → the primary's
 * parse result is returned unchanged (notices/reason preserved).
 * Purely additive: with a single text it returns exactly
 * parseVoiceTranscript's result plus matchedText/candidateIndex.
 *
 * @param {string[]} texts — primary transcript first, then alternates
 * @param {Object[]} aircraftList
 * @param {Object[]} [waypoints] — per-airport fixes (see parseVoiceTranscript)
 * @returns {{ result: object, matchedText: string, candidateIndex: number }}
 */
export function parseVoiceCandidates(texts, aircraftList, waypoints = []) {
  const candidates = [];
  const seen = new Set();
  for (const t of texts) {
    const s = String(t || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;   // case-insensitive dedupe, primary stays first
    seen.add(key);
    candidates.push(s);
  }
  if (!candidates.length) {
    return { result: parseVoiceTranscript('', aircraftList, waypoints), matchedText: '', candidateIndex: 0 };
  }
  let primary = null;
  for (let i = 0; i < candidates.length; i++) {
    const result = parseVoiceTranscript(candidates[i], aircraftList, waypoints);
    if (i === 0) primary = result;
    if (result.ok && result.commands.length > 0) {
      return { result, matchedText: candidates[i], candidateIndex: i };
    }
  }
  return { result: primary, matchedText: candidates[0], candidateIndex: 0 };
}

function renderLine(callsign, commands) {
  if (!commands.length) return callsign + ':';
  return callsign + ': ' + commands.map(c => c.label).join(', ');
}

/**
 * Synthetic aircraft list for the CLI sim: every plausible callsign the
 * transcript itself mentions (spoken words or literal digits, e.g. "CSC6918"
 * or "CSC six nine one eight"), each with controlSeat 5 (approach) so
 * parsed commands pass the seat gate. Feed it to parseVoiceTranscript as
 * aircraftList when no live telemetry is available.
 */
export function buildSyntheticAircraftList(transcript, lang) {
  return callsignCandidates(transcript, lang).map(cs => ({
    callSign: cs,
    controlSeat: 5,
    position: { x: 0, y: 0, z: 0 },
    noseDirection: { x: 0, y: 0, z: 1 },
    airSpeedKnot: 200,
  }));
}
