/**
 * Spoken-callsign parser: extracts airline name → ICAO code + flight number
 * from a voice transcript, then matches against live UDP aircraft.
 *
 * Flow:
 *   1. detectLanguage(transcript) → 'en' | 'zh'
 *   2. parseCallsign(transcript, lang, aircraftList) → ParseResult | null
 */

import { AIRLINE_CODE_MAP, getAirlineCode } from '../../utils/constants/index.js';
import { parseEnglishFlightNumber, parseChineseFlightNumber } from './voiceNumberParser.js';
import { fuzzyMatch, NON_FUZZY_WORDS, isFuzzyEligible, skeletonMatch, damerauLevenshtein } from './voiceFuzzy.js';

// ─── Language detection ────────────────────────────────────────────────

/** CJK Unicode ranges used for Chinese detection. */
const CJK_RANGES = [
  [0x4E00, 0x9FFF], // CJK Unified Ideographs
  [0x3400, 0x4DBF], // CJK Unified Ideographs Extension A
  [0xF900, 0xFAFF], // CJK Compatibility Ideographs
];

function isCJK(ch) {
  const cp = ch.codePointAt(0);
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/**
 * Detect whether a transcript is English or Chinese based on the
 * presence of CJK characters.
 *
 * @param {string} transcript — raw speech recognition result
 * @returns {'en' | 'zh'}
 */
export function detectLanguage(transcript) {
  if (!transcript) return 'en';
  // If any CJK character is present, treat as Chinese
  for (const ch of transcript) {
    if (isCJK(ch)) return 'zh';
  }
  return 'en';
}

// ─── Spoken-name → ICAO map ────────────────────────────────────────────

/**
 * Build a lookup from lowercase spoken airline names to ICAO codes.
 *
 * Includes:
 *   - Full names from AIRLINE_CODE_MAP (e.g., "united airlines" → "UAL")
 *   - Short forms (first word, e.g., "united" → "UAL")
 *   - Multi-word short forms (e.g., "air china" → "CCA", "air france" → "AFR")
 *   - Common spoken variants (e.g., "delta" for "Delta Air Lines")
 *   - 3-letter codes themselves (e.g., "ual" → "UAL")
 *
 * Sorted longest-first so we match the most specific form.
 */
let _spokenToCode = null;

export function getSpokenToCode() {
  if (_spokenToCode) return _spokenToCode;

  const entries = [];

  for (const [name, code] of Object.entries(AIRLINE_CODE_MAP)) {
    const lower = name.toLowerCase();
    // Full name
    entries.push([lower, code]);

    // First word (e.g., "united" from "United Airlines")
    const firstWord = lower.split(/\s+/)[0];
    if (firstWord !== lower) {
      // Don't add duplicate entries for single-word names (KLM, JetBlue, etc.)
      if (!entries.some(([k, v]) => k === firstWord && v === code)) {
        entries.push([firstWord, code]);
      }
    }

    // 3-letter code itself (e.g., "ual" → "UAL")
    entries.push([code.toLowerCase(), code]);
  }

  // Add Chinese short forms not already covered
  const zhShortForms = {
    '东方': 'CES', '东航': 'CES',
    '国航': 'CCA',
    '南航': 'CSN',
    '海航': 'CHH',
    '海南': 'CHH',
    '深航': 'CSZ',
    '川航': 'CSC',
    '厦航': 'CXA',
    '山航': 'CDG',
    '春秋': 'CQH',
    '奥凯': 'CJX',
    '西藏': 'UEA',
  };
  for (const [zh, code] of Object.entries(zhShortForms)) {
    entries.push([zh, code]);
  }

  // Sort longest first for greedy matching
  entries.sort((a, b) => b[0].length - a[0].length);

  _spokenToCode = entries;
  return _spokenToCode;
}

/** English airline NAME words eligible for fuzzy matching (full names +
 *  first words, CJK excluded). 3-letter codes are deliberately absent —
 *  any random 3-letter word is within distance 1 of a code, pure
 *  false-positive noise. Exported for scripts/gen_voice_fuzzy_acceptance.mjs
 *  and used by matchPrefixFuzzy. */
export function getSpokenNameWords() {
  const out = new Set();
  for (const [name] of Object.entries(AIRLINE_CODE_MAP)) {
    const lower = name.toLowerCase();
    if (!/^[a-z]/.test(lower)) continue;   // CJK names are spoken-word only
    out.add(lower);                        // full name
    const first = lower.split(/\s+/)[0];
    if (first !== lower) out.add(first);   // first word
  }
  return [...out];
}

// ─── Spoken filler words ───────────────────────────────────────────────

/**
 * Filler words speakers drop before a callsign ("um Delta 3401…",
 * "okay United 1111…"). Stripped from the front of the transcript and
 * between the airline name and the flight number ("delta uh 3401") before
 * the airline-prefix match. The original text is tried first per prefix,
 * so an airline whose NAME contains a filler ("Okay Airways" → CJX) still
 * matches. Shared with the command matcher's connector strip.
 *
 * Single source of truth: re-exported from voiceFuzzy — fillers must never
 * fuzzy-map in ANY slot ("sir" must not become "air"), while their exact
 * forms keep matching.
 */
export const EN_FILLER_WORDS = new Set(NON_FUZZY_WORDS);

/** Drop leading filler tokens (non-mutating). */
export function stripLeadingFillers(tokens) {
  let i = 0;
  while (i < tokens.length && EN_FILLER_WORDS.has(tokens[i])) i++;
  return tokens.slice(i);
}

/**
 * "Heavy" is an OPTIONAL callsign word ("American 1111 Heavy, climb…").
 * Strips consecutive leading filler/heavy tokens before the flight-number
 * scan and again off the leftover text, so heavy never reaches the command
 * matcher (no `unsupported: "heavy"` notice). Heavy is matched fuzzily
 * (D-L ≤ 1 — misheard "hevy"/"havy" resolve; "heavy" is 5 chars, and no
 * number/command word is within distance 1, so nothing real is ever eaten).
 * Mid-number heavy stays a limitation (like filler-in-number).
 * Subsumes stripLeadingFillers so "heavy uh 1111" and "uh heavy 1111" both
 * reach the number scan.
 */
function stripLeadingCallsignNoise(tokens) {
  let i = 0;
  while (i < tokens.length) {
    if (EN_FILLER_WORDS.has(tokens[i])) { i++; continue; }
    // "heavy:" / "heavy," → heavy (mirrors tokenizeEnglish's normalization)
    const t = tokens[i].replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (t && fuzzyMatch(t, ['heavy'], 1)) { i++; continue; }
    // 'at' is a pure STT insertion before the flight number ("korean air at
    // twenty twenty one"). Never a digit (exact-only), so skipping it can't
    // change number semantics; the same strip on leftover text turns "csc
    // 123 at climb" into "climb" (same unsupported outcome either way).
    if (t === 'at') { i++; continue; }
    break;
  }
  return tokens.slice(i);
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Result of a successful callsign parse.
 *
 * @typedef {Object} ParseResult
 * @property {string} callsign     — matched callsign (e.g., "UAL1111")
 * @property {Object} aircraft     — the UDP aircraft object
 * @property {string} remainingText — everything after the callsign
 * @property {string} airlineName  — spoken airline name that matched
 * @property {string} flightNumber — parsed flight number digits
 */

/**
 * Attempt to parse a callsign from spoken transcript and match against
 * the live aircraft list.
 *
 * @param {string} transcript — raw speech recognition result
 * @param {'en'|'zh'} lang — detected language
 * @param {Object[]} aircraftList — array of UDP aircraft objects (each has .callSign)
 * @param {string[]} [diag] — optional collector for failure diagnostics
 *   (notes about which airline prefixes matched, candidate callsigns not
 *   found, and where the number parse stopped). Only used on failure.
 * @returns {ParseResult | null}
 */
export function parseCallsign(transcript, lang, aircraftList, diag) {
  if (!transcript || !aircraftList.length) return null;

  const lower = transcript.toLowerCase().trim();
  const spokenToCode = getSpokenToCode();

  if (lang === 'zh') {
    return parseCallsignChinese(transcript, spokenToCode, aircraftList, diag);
  }

  // ── English path ──────────────────────────────────────────────────
  // Leading filler words ("um", "okay", …) are stripped, but the original
  // text is still tried first per prefix so an airline whose NAME contains
  // a filler ("okay airways" → CJX) keeps matching.
  const stripped = stripLeadingFillers(lower.split(/\s+/)).join(' ');
  let sawPrefix = false;

  // Try each spoken-name prefix (longest first)
  for (const [spoken, code] of spokenToCode) {
    // Skip Chinese-only entries when in English mode
    if (isCJK(spoken[0])) continue;

    const matchResult = matchSpokenPrefix(lower, stripped, spoken);
    if (!matchResult) continue;
    sawPrefix = true;
    diag?.push(`airline "${spoken}" → ${code}`);

    const result = tryResolveFlightFromRemaining(matchResult.remaining, code, spoken, aircraftList, diag);
    if (result) return result;
  }

  // Phonetic skeleton stage: exact + letter-D-L all failed — try the
  // consonant-skeleton fallback against single-word airline keys
  // ("cafe" → cathay → CPA). The number-parse + aircraft-list tail is
  // identical to the per-entry loop's (same diag strings).
  const skel = matchSpokenSkeleton(lower, stripped);
  if (skel) {
    sawPrefix = true;
    diag?.push(`airline "${skel.spoken}" → ${skel.code}`);
    const result = tryResolveFlightFromRemaining(skel.remaining, skel.code, skel.spoken, aircraftList, diag);
    if (result) return result;
  }

  if (!sawPrefix) {
    diag?.push('no airline name matched at start');
    // The "fuzzy did not save it" marker — exact AND fuzzy both failed.
    diag?.push('fuzzy: no spoken-name match');
  }
  return null;
}

/**
 * Chinese "Heavy" is "重型" (bare '重' also emitted by the recognizer).
 * Strips the maximal leading run of {重型, 重} — 重型 checked first since it
 * starts with 重. Applied before the digit scan AND on the leftover text
 * (mirrors the en strip). Chinese stays exact-only (no zh fuzzy layer). No
 * false positives: no airline, pattern, or connector starts with 重.
 */
function stripZhHeavy(str) {
  let s = str;
  while (s.startsWith('重型') || s.startsWith('重')) {
    s = s.slice(s.startsWith('重型') ? 2 : 1);
  }
  return s;
}

/**
 * Chinese-specific callsign parsing.
 * Chinese has no spaces, so we work character-by-character instead of token-by-token.
 */
function parseCallsignChinese(transcript, spokenToCode, aircraftList, diag) {
  let sawPrefix = false;
  // Try each spoken-name prefix (longest first), Chinese entries only
  for (const [spoken, code] of spokenToCode) {
    const matchResult = matchPrefix(transcript, spoken);
    if (!matchResult) continue;
    sawPrefix = true;
    diag?.push(`airline "${spoken}" → ${code}`);

    const { remaining } = matchResult;
    // optional "重型"/"重" ("东航重型五八八八…") is stripped before the
    // digit scan, like the en heavy strip
    const remainingNoHeavy = stripZhHeavy(remaining);
    if (!remainingNoHeavy) {
      // Just the airline name (possibly + heavy), no flight number
      // Try matching remaining as empty flight number — unlikely but handle
      continue;
    }

    // remaining is a continuous string like "五八八八可以起飞"
    // Extract digit characters from the beginning
    const chars = [...remainingNoHeavy];
    const digitChars = [];
    let consumed = 0;

    for (const ch of chars) {
      const d = ZH_DIGIT_FOR_PARSER[ch];
      if (d) {
        digitChars.push(d);
        consumed++;
      } else if (/^\d$/.test(ch)) {
        digitChars.push([ch]);   // literal ASCII digit (typed input / speech engines)
        consumed++;
      } else {
        break;
      }
    }

    if (!digitChars.length) {
      diag?.push(`no flight number parsed after "${spoken}"`);
      continue;
    }

    // digitChars is an array of string arrays, e.g. [["5"],["8"],["8"],["8"]]
    // Build candidates via Cartesian product
    const candidates = productZh(digitChars).filter(c => c.length <= 6);

    for (const numStr of candidates) {
      const callsign = code + numStr;
      const ac = aircraftList.find(a => a.callSign === callsign);
      if (ac) {
        // trailing "重型"/"重" ("东航五八八八重型…") never reaches the
        // command matcher
        const remainingText = stripZhHeavy(chars.slice(consumed).join(''));
        return {
          callsign,
          aircraft: ac,
          remainingText,
          airlineName: spoken,
          flightNumber: numStr,
        };
      }
    }

    // Proximity fallback — "东方五拐八" → CES578 vs live CES5578 (D-L 1).
    // Approach-seat only, ties fail (mirrors the EN path).
    const prox = proximityMatch(code, candidates, aircraftList);
    if (prox) {
      const remainingText = stripZhHeavy(chars.slice(consumed).join(''));
      return {
        callsign: prox.callsign,
        aircraft: prox.aircraft,
        remainingText,
        airlineName: spoken,
        flightNumber: prox.numStr,
      };
    }

    diag?.push(`candidates ${candidates.map(n => code + n).join(',')} not in list`);
  }

  if (!sawPrefix) diag?.push('no airline name matched at start');
  return null;
}

/** Inline Chinese digit map for the parser (same as ZH_DIGIT in voiceNumberParser). */
const ZH_DIGIT_FOR_PARSER = {
  '零': ['0'], '洞': ['0'],
  '幺': ['1'], '一': ['1'],
  '二': ['2'], '两': ['2'],
  '三': ['3'], '四': ['4'],
  '五': ['5'], '六': ['6'],
  '七': ['7'], '拐': ['7'], '八': ['8'],
  '九': ['9'],
};

/** Cartesian product for Chinese digit arrays. */
function productZh(arrays) {
  if (!arrays.length) return [''];
  const [first, ...rest] = arrays;
  const suffixes = productZh(rest);
  const result = [];
  for (const a of first) {
    for (const b of suffixes) {
      result.push(a + b);
    }
  }
  return result;
}

/**
 * Try to match `spoken` as a prefix of `transcript` at word boundaries.
 * Returns the remaining text after the match, or null.
 *
 * Examples:
 *   matchPrefix("united eleven eleven cleared", "united") → { remaining: "eleven eleven cleared" }
 *   matchPrefix("air china one two three", "air china") → { remaining: "one two three" }
 *   matchPrefix("united airlines 123", "united airlines") → { remaining: "123" }
 *   matchPrefix("british airways 456", "british airways") → { remaining: "456" }
 *   matchPrefix("delta 123", "delta airlines") → null (full name doesn't match)
 *   matchPrefix("delta 123", "delta") → { remaining: "123" } (short form matches)
 */
export function matchPrefix(transcript, spoken) {
  // Transcript must start with the spoken prefix
  if (!transcript.startsWith(spoken)) return null;

  const after = transcript.slice(spoken.length);

  // If spoken prefix consumed everything, that's fine (e.g., just callsign, no command)
  if (after === '') return { remaining: '' };

  // Space after prefix — always valid (English word boundary)
  if (after[0] === ' ') return { remaining: after };

  // Next char is a digit (ASCII or CJK numeral) — allow ("klm631", "东方五八八八")
  if (/^\d/.test(after) || isCJK(after[0])) return { remaining: after };

  // Otherwise, not a valid match (e.g., "unitedX" where X is a letter)
  return null;
}

/**
 * Fuzzy variant of matchPrefix (EN name words only): word-by-word exact
 * first, then D-L ≤ 1 per word, at most ONE fuzzy word per name ("hainann
 * one two three four" → hainan, "untied 1111" → united, "fair france" →
 * air france). Mirrors matchPrefix's boundary guard on the consumed span.
 * 3-letter codes are never fuzzy targets (the caller's spoken forms include
 * them, but fuzzyMatch is only reached for name words ≥ 3 chars — and the
 * caller gates name words via getSpokenNameWords where needed).
 *
 * @param {string} transcript — LOWERCASE transcript
 * @param {string} spoken — lowercase spoken name (one or more words)
 * @returns {{remaining: string} | null}
 */
/** 3-letter ICAO codes — exact-only fuzzy targets (any random 3-letter
 *  word is within distance 1 of a code: 'deal' → dal). Name words like
 *  'eva'/'klm' stay fuzzy-eligible — they are not in this set. */
const CODE_WORDS = new Set(Object.values(AIRLINE_CODE_MAP).map((c) => c.toLowerCase()));

export function matchPrefixFuzzy(transcript, spoken) {
  const spokenWords = spoken.split(/\s+/);
  const tokens = transcript.split(/\s+/);
  if (tokens.length < spokenWords.length) return null;
  let k = 0;
  let deviated = false;
  for (const sw of spokenWords) {
    const tok = tokens[k] ? tokens[k].toLowerCase() : null;
    if (tok === sw) { k++; continue; }
    if (deviated) return null;                 // ≤ 1 fuzzy word per name
    if (tok && !CODE_WORDS.has(sw) && fuzzyMatch(tok, [sw], 1)) { deviated = true; k++; continue; }
    return null;
  }
  const consumed = tokens.slice(0, k).join(' ');
  const after = transcript.slice(consumed.length);
  if (after === '') return { remaining: '' };
  if (after[0] === ' ') return { remaining: after };
  if (/^\d/.test(after) || isCJK(after[0])) return { remaining: after };
  return null;
}

/** Exact prefix (original + filler-stripped), then the fuzzy fallback. */
function matchSpokenPrefix(lower, stripped, spoken) {
  return (
    matchPrefix(lower, spoken) ||
    (stripped !== lower ? matchPrefix(stripped, spoken) : null) ||
    matchPrefixFuzzy(lower, spoken) ||
    (stripped !== lower ? matchPrefixFuzzy(stripped, spoken) : null)
  );
}

// ─── Phonetic skeleton stage (2026-08-06) ──────────────────────────────

/** Single-word spoken airline keys (full-name/first-word entries without
 *  spaces) for the phonetic skeleton stage — memoized. 3-letter codes are
 *  excluded (codes are exact-only fuzzy targets everywhere; 'cpa'→'cp' is
 *  one skeleton edit from 'cf' and would tie with 'cathay'). Entry order
 *  mirrors getSpokenToCode for code resolution. */
let _spokenSingleWordKeys = null;
function getSpokenSingleWordKeys() {
  if (!_spokenSingleWordKeys) {
    _spokenSingleWordKeys = getSpokenToCode()
      .filter(([spoken]) => !/\s/.test(spoken) && !CODE_WORDS.has(spoken))
      .map(([spoken]) => spoken);
  }
  return _spokenSingleWordKeys;
}

/**
 * Phonetic skeleton stage for the airline slot: final fallback after
 * exact + letter-D-L all failed — "cafe" → cathay (cf/cθ are one skeleton
 * edit apart). Takes the first token of the filler-stripped text; blocked
 * when it fuzzy-matches 'heavy' (a bare "heavy …" must stay a failure) or
 * is fuzzy-ineligible; matches against the single-word spoken keys via
 * skeletonMatch (closed set, unique best wins, ties fail).
 *
 * @param {string} lower — LOWERCASE transcript (original text)
 * @param {string} stripped — leading-fillers-removed transcript
 * @returns {{code: string, spoken: string, remaining: string} | null}
 */
function matchSpokenSkeleton(lower, stripped) {
  const first = stripped ? stripped.split(/\s+/)[0].toLowerCase() : null;
  if (!first) return null;
  if (fuzzyMatch(first, ['heavy'], 1)) return null;   // "heavy …" must stay a failure
  if (!isFuzzyEligible(first)) return null;
  // Codes are exact-only everywhere — a token within D-L 1 of a code
  // ("deal" → dal) must not reach the phonetic stage either, or the code
  // guard is bypassed through the name word ('deal' → delta → DAL).
  for (const code of CODE_WORDS) {
    if (Math.abs(code.length - first.length) <= 1 && damerauLevenshtein(first, code) === 1) return null;
  }
  const best = skeletonMatch(first, getSpokenSingleWordKeys());
  if (!best) return null;
  const entry = getSpokenToCode().find(([spoken]) => spoken === best);
  if (!entry) return null;
  const [spoken, code] = entry;
  // Consumed span: leading fillers + the first token, measured on the
  // ORIGINAL text — mirrors the fuzzy prefix boundary guard.
  const tokens = lower.split(/\s+/);
  let k = 0;
  while (k < tokens.length && EN_FILLER_WORDS.has(tokens[k])) k++;
  const consumed = tokens.slice(0, k + 1).join(' ');
  const after = lower.slice(consumed.length);
  if (after === '') return { code, spoken, remaining: '' };
  if (after[0] === ' ') return { code, spoken, remaining: after };
  if (/^\d/.test(after) || isCJK(after[0])) return { code, spoken, remaining: after };
  return null;
}

// ─── Proximity fallback (2026-08-06) ───────────────────────────────────

/** D-L ≤ 1 proximity fallback against the LIVE aircraft list, fired only
 *  when candidates exist but none matched exactly. Approach-seat only
 *  (controlSeat 5 = approach channel; a numeric non-5 seat is skipped —
 *  unknown/absent seat fields stay eligible — user: "all live APPR
 *  aircraft"). Unique best wins, ties fail (two aircraft one edit away
 *  must never resolve to one). Cap 1 plus the airline-code prefix make
 *  the digit suffix the only editable region ("CES578" → "CES5578").
 *
 * @param {string} code — ICAO code ("CES")
 * @param {string[]} numStrs — digit candidates ("578")
 * @param {Object[]} aircraftList — live aircraft (each has .callSign)
 * @returns {{callsign: string, aircraft: Object, numStr: string} | null}
 */
function proximityMatch(code, numStrs, aircraftList) {
  let best = null;             // { callsign, aircraft, numStr }
  const matched = new Set();   // callsigns with a d1 hit
  for (const ac of aircraftList) {
    if (typeof ac.controlSeat === 'number' && ac.controlSeat !== 5) continue;
    const target = String(ac.callSign).toLowerCase();
    for (const numStr of numStrs) {
      const cs = (code + numStr).toLowerCase();
      if (cs === target) continue;                    // exact already failed
      if (damerauLevenshtein(cs, target) === 1) {
        if (!matched.has(ac.callSign)) best = { callsign: ac.callSign, aircraft: ac, numStr };
        matched.add(ac.callSign);
      }
    }
  }
  return matched.size === 1 ? best : null;
}

/** Shared tail of a successful airline-prefix match: parse the flight
 *  number, match the candidates against the live aircraft list (exact),
 *  then the D-L ≤ 1 proximity fallback, and return the ParseResult — or
 *  null with the standard diagnostics. Used by the per-entry loop and the
 *  phonetic skeleton stage so both produce identical diag strings. */
function tryResolveFlightFromRemaining(remaining, code, spoken, aircraftList, diag) {
  const remainingTrimmed = remaining.trim();
  // Pure-punctuation tokens ("CSC6918 : climb") are dropped so the
  // flight-number scan and the remainingText both ignore them; filler
  // words before the number ("delta uh 3401") and the optional "heavy"
  // keyword ("american heavy 1111") are stripped too.
  const remainingTokens = stripLeadingCallsignNoise(
    remainingTrimmed
      ? remainingTrimmed.split(/\s+/).filter(t => /[a-z0-9一-鿿]/i.test(t))
      : []
  );

  // Parse flight number from remaining tokens
  const numResult = parseEnglishFlightNumber(remainingTokens);
  if (!numResult.candidates.length) {
    diag?.push(`no flight number parsed after "${spoken}"`);
    return null;
  }

  // Build callsign candidates and test against aircraft list
  for (const numStr of numResult.candidates) {
    const callsign = code + numStr;
    const ac = aircraftList.find(a => a.callSign === callsign);
    if (ac) {
      // trailing "heavy" ("american 1111 heavy climb…") never reaches
      // the command matcher
      const unconsumedTokens = stripLeadingCallsignNoise(remainingTokens.slice(numResult.consumed));
      return {
        callsign,
        aircraft: ac,
        remainingText: unconsumedTokens.join(' '),
        airlineName: spoken,
        flightNumber: numStr,
      };
    }
  }

  // None of the candidate callsigns exists in the live aircraft list —
  // name the candidates and where the number scan stopped.
  const brk = remainingTokens[numResult.consumed];
  diag?.push(
    `candidates ${numResult.candidates.map(n => code + n).join(',')} not in list` +
    (brk ? ` (first unparsed token: "${brk}")` : '')
  );

  // Proximity fallback: no exact aircraft — a misheard digit is one edit
  // away ("五拐八" → CES5578). Approach-seat only, ties fail.
  const prox = proximityMatch(code, numResult.candidates, aircraftList);
  if (prox) {
    const unconsumedTokens = stripLeadingCallsignNoise(remainingTokens.slice(numResult.consumed));
    return {
      callsign: prox.callsign,
      aircraft: prox.aircraft,
      remainingText: unconsumedTokens.join(' '),
      airlineName: spoken,
      flightNumber: prox.numStr,
    };
  }
  return null;
}

/**
 * All plausible callsign strings (ICAO code + flight number) derivable from
 * a transcript — the same prefix → flight-number extraction parseCallsign
 * performs, WITHOUT the aircraft-list filter. Used by the CLI's
 * buildSyntheticAircraftList so a typed transcript ("CSC6918: climb …")
 * resolves its own callsign with no live aircraft data.
 *
 * @param {string} transcript — raw speech/typed transcript
 * @param {'en'|'zh'} lang — detected language
 * @returns {string[]} callsign strings (e.g., ["CSC6918"])
 */
export function callsignCandidates(transcript, lang) {
  const out = new Set();
  if (!transcript) return [];
  const lower = transcript.toLowerCase().trim();
  const spokenToCode = getSpokenToCode();

  if (lang === 'zh') {
    for (const [spoken, code] of spokenToCode) {
      if (!isCJK(spoken[0])) continue;   // English entries don't prefix-match Chinese text
      const m = matchPrefix(transcript, spoken);
      if (!m) continue;
      const chars = [...stripZhHeavy(m.remaining)];   // mirror parseCallsignChinese
      const digitChars = [];
      let consumed = 0;
      for (const ch of chars) {
        const d = ZH_DIGIT_FOR_PARSER[ch];
        if (d) { digitChars.push(d); consumed++; }
        else if (/^\d$/.test(ch)) { digitChars.push([ch]); consumed++; }
        else break;
      }
      if (!digitChars.length) continue;
      for (const numStr of productZh(digitChars).filter(c => c.length <= 6)) out.add(code + numStr);
    }
  } else {
    // Same filler handling as parseCallsign (the CLI sim's synthetic list
    // must resolve exactly what the app's parse would).
    const stripped = stripLeadingFillers(lower.split(/\s+/)).join(' ');
    for (const [spoken, code] of spokenToCode) {
      if (isCJK(spoken[0])) continue;   // Chinese short forms are spoken-word only
      // Same prefix path as parseCallsign (the CLI sim's synthetic list must
      // resolve exactly what the app's parse would — incl. fuzzy).
      const m = matchSpokenPrefix(lower, stripped, spoken);
      if (!m) continue;
      const remainingTrimmed = m.remaining.trim();
      const tokens = stripLeadingCallsignNoise(   // mirror parseCallsign
        remainingTrimmed
          ? remainingTrimmed.split(/\s+/).filter(t => /[a-z0-9一-鿿]/i.test(t))
          : []
      );
      const numResult = parseEnglishFlightNumber(tokens);
      for (const numStr of numResult.candidates) out.add(code + numStr);
    }
    // Phonetic skeleton mirror — buildSyntheticAircraftList must resolve
    // exactly what the live parse would ("cafe …" → cathay → CPA7522).
    const skel = matchSpokenSkeleton(lower, stripped);
    if (skel) {
      const remainingTrimmed = skel.remaining.trim();
      const tokens = stripLeadingCallsignNoise(
        remainingTrimmed
          ? remainingTrimmed.split(/\s+/).filter(t => /[a-z0-9一-鿿]/i.test(t))
          : []
      );
      const numResult = parseEnglishFlightNumber(tokens);
      for (const numStr of numResult.candidates) out.add(skel.code + numStr);
    }
  }

  return [...out];
}
