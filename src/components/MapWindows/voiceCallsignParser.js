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
import { fuzzyMatch, NON_FUZZY_WORDS } from './voiceFuzzy.js';

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

    const { remaining } = matchResult;
    const remainingTrimmed = remaining.trim();
    // Pure-punctuation tokens ("CSC6918 : climb") are dropped so the
    // flight-number scan and the remainingText both ignore them; filler
    // words before the number ("delta uh 3401") are stripped too.
    const remainingTokens = stripLeadingFillers(
      remainingTrimmed
        ? remainingTrimmed.split(/\s+/).filter(t => /[a-z0-9一-鿿]/i.test(t))
        : []
    );

    // Parse flight number from remaining tokens
    const numResult = parseEnglishFlightNumber(remainingTokens);

    if (!numResult.candidates.length) {
      diag?.push(`no flight number parsed after "${spoken}"`);
      continue;
    }

    // Build callsign candidates and test against aircraft list
    for (const numStr of numResult.candidates) {
      const callsign = code + numStr;
      const ac = aircraftList.find(a => a.callSign === callsign);
      if (ac) {
        const unconsumedTokens = remainingTokens.slice(numResult.consumed);
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
  }

  if (!sawPrefix) {
    diag?.push('no airline name matched at start');
    // The "fuzzy did not save it" marker — exact AND fuzzy both failed.
    diag?.push('fuzzy: no spoken-name match');
  }
  return null;
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
    if (!remaining) {
      // Just the airline name, no flight number
      // Try matching remaining as empty flight number — unlikely but handle
      continue;
    }

    // remaining is a continuous string like "五八八八可以起飞"
    // Extract digit characters from the beginning
    const chars = [...remaining];
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
        const remainingText = chars.slice(consumed).join('');
        return {
          callsign,
          aircraft: ac,
          remainingText,
          airlineName: spoken,
          flightNumber: numStr,
        };
      }
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
      const chars = [...m.remaining];
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
      const tokens = stripLeadingFillers(
        remainingTrimmed
          ? remainingTrimmed.split(/\s+/).filter(t => /[a-z0-9一-鿿]/i.test(t))
          : []
      );
      const numResult = parseEnglishFlightNumber(tokens);
      for (const numStr of numResult.candidates) out.add(code + numStr);
    }
  }

  return [...out];
}
