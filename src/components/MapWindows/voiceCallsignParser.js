/**
 * Spoken-callsign parser: extracts airline name → ICAO code + flight number
 * from a voice transcript, then matches against live UDP aircraft.
 *
 * Flow:
 *   1. detectLanguage(transcript) → 'en' | 'zh'
 *   2. parseCallsign(transcript, lang, aircraftList) → ParseResult | null
 */

import { AIRLINE_CODE_MAP, getAirlineCode } from '../../utils/constants';
import { parseEnglishFlightNumber, parseChineseFlightNumber } from './voiceNumberParser';

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

function getSpokenToCode() {
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
 * @returns {ParseResult | null}
 */
export function parseCallsign(transcript, lang, aircraftList) {
  if (!transcript || !aircraftList.length) return null;

  const lower = transcript.toLowerCase().trim();
  const spokenToCode = getSpokenToCode();

  if (lang === 'zh') {
    return parseCallsignChinese(transcript, spokenToCode, aircraftList);
  }

  // ── English path ──────────────────────────────────────────────────
  // Try each spoken-name prefix (longest first)
  for (const [spoken, code] of spokenToCode) {
    // Skip Chinese-only entries when in English mode
    if (isCJK(spoken[0])) continue;

    const matchResult = matchPrefix(lower, spoken);
    if (!matchResult) continue;

    const { remaining } = matchResult;
    const remainingTrimmed = remaining.trim();
    const remainingTokens = remainingTrimmed ? remainingTrimmed.split(/\s+/) : [];

    // Parse flight number from remaining tokens
    const numResult = parseEnglishFlightNumber(remainingTokens);

    if (!numResult.candidates.length) continue;

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
  }

  return null;
}

/**
 * Chinese-specific callsign parsing.
 * Chinese has no spaces, so we work character-by-character instead of token-by-token.
 */
function parseCallsignChinese(transcript, spokenToCode, aircraftList) {
  // Try each spoken-name prefix (longest first), Chinese entries only
  for (const [spoken, code] of spokenToCode) {
    const matchResult = matchPrefix(transcript, spoken);
    if (!matchResult) continue;

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
      } else {
        break;
      }
    }

    if (!digitChars.length) continue;

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
  }

  return null;
}

/** Inline Chinese digit map for the parser (same as ZH_DIGIT in voiceNumberParser). */
const ZH_DIGIT_FOR_PARSER = {
  '零': ['0'], '洞': ['0'],
  '幺': ['1'], '一': ['1'],
  '二': ['2'], '两': ['2'],
  '三': ['3'], '四': ['4'],
  '五': ['5'], '六': ['6'],
  '七': ['7'], '八': ['8'],
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
function matchPrefix(transcript, spoken) {
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
