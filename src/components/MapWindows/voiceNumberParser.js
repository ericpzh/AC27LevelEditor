/**
 * Spoken-number-to-digits parsers for English and Chinese aviation phraseology.
 *
 * English patterns handled:
 *   - Individual digits: "one two three four" → 1234
 *   - Teens:            "eleven", "thirteen" → 11, 13
 *   - Grouped pairs:    "twelve thirty four" → 1234 (and the 12304 reading)
 *   - Tens + ones:      "thirty four" → 34 (the literal "30"+"4" = 304
 *                       reading is kept as a candidate too — the aircraft
 *                       list disambiguates)
 *   - "hundred":        "one hundred" → 100 (rare in aviation)
 *   - "triple X":       "triple one" → 111
 *   - "o"/"oh" for zero: "o four" → 04 (speech engines render "oh" as "o")
 *
 * Chinese patterns handled:
 *   - Digit-by-digit (yao-series):  "幺幺幺幺" → 1111
 *   - Digit-by-digit (yi-series):   "一一一一" → 1111
 *   - 洞 for 0:                     "洞四" → 04
 *   - 两 for 2:                     "一两三" → 123
 */

import { fuzzyLookupKey, FLIGHT_NUMBER_FUZZY_GUARD } from './voiceFuzzy.js';

// ─── English word → digit(s) ──────────────────────────────────────────

/** Single-digit words (including "o"/"oh" for zero in aviation — speech
 *  engines commonly render "oh" as the bare letter "o"). */
const EN_DIGIT = {
  zero: ['0'], oh: ['0'], o: ['0'],
  one: ['1'], two: ['2'], three: ['3'], four: ['4'], five: ['5'],
  six: ['6'], seven: ['7'], eight: ['8'], nine: ['9'],
};

/** Teen words (11–19). */
const EN_TEEN = {
  ten: ['10'], eleven: ['11'], twelve: ['12'], thirteen: ['13'],
  fourteen: ['14'], fifteen: ['15'], sixteen: ['16'],
  seventeen: ['17'], eighteen: ['18'], nineteen: ['19'],
};

/** Tens words (20, 30, …, 90). */
const EN_TENS = {
  twenty: ['20'], thirty: ['30'], forty: ['40'], fifty: ['50'],
  sixty: ['60'], seventy: ['70'], eighty: ['80'], ninety: ['90'],
};

/** Aviation shorthand multipliers. */
const EN_MULTIPLIER = {
  hundred: 100, thousand: 1000,
};

/** All EN number-word keys, exact-first order (incl. exact-only 'oh'/'o').
 *  Exported for scripts/gen_voice_fuzzy_acceptance.mjs. */
export const EN_NUMBER_KEYS = [
  ...Object.keys(EN_DIGIT),
  ...Object.keys(EN_TEEN),
  ...Object.keys(EN_TENS),
  ...Object.keys(EN_MULTIPLIER),
  'and',
];

/** Number keys eligible for FUZZY matching (len ≥ 3 — 'oh'/'o' are
 *  exact-only synonyms of zero; 'triple'/'double' are handled separately
 *  and stay exact-only). */
export const EN_NUMBER_FUZZY_KEYS = EN_NUMBER_KEYS.filter((w) => w.length >= 3);

// ─── Chinese word → digit(s) ───────────────────────────────────────────

/**
 * Chinese aviation digit mapping.
 * Both "幺" (yao) and "一" (yi) mean 1 — 幺 is preferred in radio comms.
 * "洞" (dong) means 0, "两" (liang) means 2, "拐" (guai) means 7.
 */
const ZH_DIGIT = {
  '零': ['0'], '洞': ['0'],
  '幺': ['1'], '一': ['1'],
  '二': ['2'], '两': ['2'],
  '三': ['3'], '四': ['4'],
  '五': ['5'], '六': ['6'],
  '七': ['7'], '拐': ['7'], '八': ['8'],
  '九': ['9'],
};

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Cartesian product of arrays of strings.
 * product([['1'], ['2','3']]) → ['12', '13']
 */
function product(arrays) {
  if (!arrays.length) return [''];
  const [first, ...rest] = arrays;
  const suffixes = product(rest);
  const result = [];
  for (const a of first) {
    for (const b of suffixes) {
      result.push(a + b);
    }
  }
  return result;
}

/**
 * Map each token to its possible digit strings, or null if not a number word.
 * Returns array of string arrays, one per token.
 *
 * Tokens are punctuation-normalized first ("6918:" → "6918") so typed
 * input with trailing punctuation (CSC6918:) parses like spoken words.
 * Literal Arabic digits are accepted (speech engines and typed text both
 * emit them).
 */
function tokenizeEnglish(tokens) {
  return tokens.map((t) => {
    const lower = t.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (!lower) return null;
    if (/^\d{1,5}$/.test(lower)) return [lower];   // literal digits ("6918", "9000")
    // Exact number words first (incl. 'oh'/'o'); a multiplier inside a
    // flight number stays unsupported ("delta three hundred" — limitation).
    if (EN_NUMBER_KEYS.includes(lower)) {
      if (lower === 'and' || lower === 'hundred' || lower === 'thousand') return null;
      return EN_DIGIT[lower] || EN_TEEN[lower] || EN_TENS[lower];
    }
    // Command words must not be swallowed as misheard digits ("CSC6918:
    // right heading 120" — 'right' is d1 of 'eight'); guard = pattern words.
    if (FLIGHT_NUMBER_FUZZY_GUARD.has(lower)) return null;
    // Fuzzy fallback (D-L ≤ 1, e.g. "tree" → three, "too" → two).
    const key = fuzzyLookupKey(lower, EN_NUMBER_FUZZY_KEYS, 1);
    if (key && key !== 'and' && key !== 'hundred' && key !== 'thousand') {
      return EN_DIGIT[key] || EN_TEEN[key] || EN_TENS[key];
    }
    if (lower === 'triple') return ['triple'];   // "triple X" shorthand — exact-only
    if (lower === 'double') return ['double'];   // "double X" shorthand — exact-only
    return null; // not a number word
  });
}

function tokenizeChinese(tokens) {
  return tokens.map((t) => {
    // Single CJK character
    if (t.length === 1 && ZH_DIGIT[t]) return ZH_DIGIT[t];
    // Multi-character token — try character-by-character
    const chars = [...t];
    const allDigits = chars.map(c => ZH_DIGIT[c]);
    if (allDigits.every(d => d)) {
      // Each char is a digit, return concatenated possibilities
      return product(allDigits);
    }
    // Try as a grouped number (e.g., "十一" → 11)
    const grouped = parseChineseGrouped(t);
    if (grouped) return [grouped];
    return null;
  });
}

/**
 * Parse Chinese grouped number forms like "十一"→11, "二十一"→21.
 * Limited to 1-99 range — flight numbers beyond that use digit-by-digit.
 */
function parseChineseGrouped(token) {
  if (token.length < 2) return null;
  // Patterns: "十X" (10+X), "X十" (X*10), "X十X" (X*10+X)
  const shiIdx = token.indexOf('十');
  if (shiIdx === -1) return null;

  const before = token.slice(0, shiIdx);
  const after = token.slice(shiIdx + 1);

  const tensDigit = before ? (ZH_DIGIT[before] ? parseInt(ZH_DIGIT[before][0], 10) : null) : 1;
  const onesDigit = after ? (ZH_DIGIT[after] ? parseInt(ZH_DIGIT[after][0], 10) : null) : 0;

  if (tensDigit === null || onesDigit === null) return null;
  return String(tensDigit * 10 + onesDigit);
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Parse English-spoken flight number from a sequence of word tokens.
 *
 * Returns ALL plausible digit-candidate strings. The caller should
 * test them against the live aircraft list to disambiguate.
 *
 * @param {string[]} tokens — word tokens after the airline name
 * @returns {{ candidates: string[], consumed: number }}
 *   candidates — plausible digit strings (e.g. ["1111", "11 11"])
 *   consumed — how many tokens were recognized as numbers
 */
export function parseEnglishFlightNumber(tokens) {
  if (!tokens.length) return { candidates: [], consumed: 0 };

  const mapped = tokenizeEnglish(tokens);

  // Process "triple X" and "double X" into repeated digits
  const resolved = [];
  let i = 0;
  while (i < mapped.length) {
    const m = mapped[i];
    if (m === null) break; // no longer a number word — stop consuming

    if (m[0] === 'triple' || m[0] === 'double') {
      const repeat = m[0] === 'triple' ? 3 : 2;
      const next = mapped[i + 1];
      if (next && Array.isArray(next) && next.length === 1 && /^\d$/.test(next[0])) {
        resolved.push([next[0].repeat(repeat)]);
        i += 2;
        continue;
      }
      // "triple" not followed by a single digit — treat as literal
      break;
    }

    // Tens word followed by a single digit 1–9 composes both readings:
    // "thirty four" → "34" (thirty-four) and "304" (30 + 4) — the caller
    // tests both against the aircraft list. NOT composed with zero, so
    // "thirty oh" keeps its natural "300" reading.
    const isTens = m.length === 1 && /^[2-9]0$/.test(m[0]);
    if (isTens) {
      const next = mapped[i + 1];
      if (next && Array.isArray(next) && next.length === 1 && /^[1-9]$/.test(next[0])) {
        const tensInt = parseInt(m[0], 10);
        const onesInt = parseInt(next[0], 10);
        resolved.push([String(tensInt + onesInt), m[0] + next[0]]);
        i += 2;
        continue;
      }
    }

    resolved.push(m);
    i++;
  }

  if (!resolved.length) return { candidates: [], consumed: 0 };

  // Generate all combinations
  const candidates = product(resolved);

  // Filter out unreasonable results (>6 digits for a flight number)
  const filtered = candidates.filter(c => c.length <= 6);

  return { candidates: filtered, consumed: i };
}

/**
 * Parse Chinese-spoken flight number from a sequence of tokens.
 *
 * Chinese aviation almost always uses digit-by-digit pronunciation
 * (e.g., "幺幺幺幺" for 1111). Grouped forms ("十一" for 11) are
 * handled as a fallback.
 *
 * @param {string[]} tokens — word tokens (or character array) after the airline name
 * @returns {{ candidates: string[], consumed: number }}
 */
export function parseChineseFlightNumber(tokens) {
  if (!tokens.length) return { candidates: [], consumed: 0 };

  // Chinese is typically spoken as continuous strings of characters.
  // The SpeechRecognition API may return individual characters or grouped tokens.
  // Strategy: join tokens into one string, split into characters, map each char.

  const joined = tokens.join('');
  const chars = [...joined];
  const mapped = [];

  for (const ch of chars) {
    if (ZH_DIGIT[ch]) {
      mapped.push(ZH_DIGIT[ch]);
    } else if (/^\d$/.test(ch)) {
      mapped.push([ch]);   // literal ASCII digit (typed input / speech engines)
    } else {
      break; // not a digit char — stop consuming
    }
  }

  if (!mapped.length) return { candidates: [], consumed: 0 };

  const candidates = product(mapped);
  const filtered = candidates.filter(c => c.length <= 6);

  // consumed in terms of original tokens: count how many characters matched
  let charCount = 0;
  let consumedTokens = 0;
  for (const tok of tokens) {
    const tokChars = [...tok];
    if (charCount + tokChars.length <= mapped.length) {
      charCount += tokChars.length;
      consumedTokens++;
    } else {
      break;
    }
  }

  return { candidates: filtered, consumed: consumedTokens || 1 };
}

/**
 * Generate callsign candidates from an airline code + number candidates.
 *
 * @param {string} airlineCode — 3-letter ICAO code (e.g., "UAL")
 * @param {string[]} numberCandidates — digit strings (e.g., ["1111"])
 * @returns {string[]} callsign strings (e.g., ["UAL1111"])
 */
export function generateCallsignCandidates(airlineCode, numberCandidates) {
  return numberCandidates.map(n => airlineCode + n);
}

// ─── Spoken VALUE parsing (command values — heading/altitude/speed) ─────

/**
 * EN unit words → command kind. 'unitless' = tolerated but ignored
 * ("fly heading 120 degrees").
 */
export const EN_UNIT_WORDS = {
  knots: 'speed', knot: 'speed', kts: 'speed',
  feet: 'altitude', foot: 'altitude', ft: 'altitude',
  meters: 'altitude-m', meter: 'altitude-m', m: 'altitude-m',
  degrees: 'unitless', degree: 'unitless',
};

/** Unit keys eligible for FUZZY matching (len ≥ 3 — 'm'/'ft' exact-only). */
export const EN_UNIT_FUZZY_KEYS = Object.keys(EN_UNIT_WORDS).filter((w) => w.length >= 3);

/** ZH unit words (string keys, 1-2 chars, no spaces in speech). ZH
 *  detection itself is inline in voiceTranscriptParser.parseCommandValueZh;
 *  this table documents the vocabulary. 'altitude-m' = meters → the caller
 *  converts to feet before building the payload. */
export const ZH_UNIT_WORDS = { '节': 'speed', '英尺': 'altitude', '米': 'altitude-m' };

/** Strip leading/trailing punctuation from a token ("180." → "180"). */
function normalizeToken(t) {
  return t.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/**
 * Resolve an EN number-word token to its table key, or null.
 * Exact-first over ALL keys (incl. 'oh'/'o'), then D-L ≤ 1 over the
 * fuzzy-eligible keys. Fillers (uh/um/…) never resolve — the caller treats
 * null as "not a number word" (breaking the scan exactly as before), so
 * "three uh four" still fails (limitation row in the deviation matrix).
 *
 * @param {string} token — normalized lowercase token
 * @returns {string|null} e.g. 'tree' → 'three', 'to' → 'two', 'oh' → 'oh'
 */
export function lookupEnNumberToken(token) {
  if (EN_NUMBER_KEYS.includes(token)) return token;
  return fuzzyLookupKey(token, EN_NUMBER_FUZZY_KEYS, 1);
}

/**
 * Resolve a unit word to its table key, or undefined.
 * Exact-first over ALL keys (incl. 'm'/'ft'), then D-L ≤ 1 over the
 * fuzzy-eligible keys with fillers excluded ('um' never becomes 'm').
 *
 * @param {string} token — normalized lowercase token
 * @returns {string|undefined} e.g. 'feat' → 'feet', 'nots' → 'knots'
 */
export function lookupUnitWord(token) {
  if (Object.prototype.hasOwnProperty.call(EN_UNIT_WORDS, token)) return token;
  return fuzzyLookupKey(token, EN_UNIT_FUZZY_KEYS, 1) ?? undefined;
}

/**
 * Scan the leading numeric tokens of a value phrase into units:
 * [{k:'d'|'tens', v}, {k:'hundred'|'thousand'}]. 'and' and punctuation-only
 * tokens are skipped (they're part of magnitude phrases). consumed = number
 * of original tokens scanned (incl. skips).
 */
function scanEnNumeric(tokens) {
  const scanned = [];
  let i = 0;
  while (i < tokens.length) {
    const t = normalizeToken(tokens[i]);
    if (!t) { i++; continue; }
    // Exact first, then fuzzy (D-L ≤ 1 — "thousan" → thousand, "to" → two).
    // Unknown words (incl. fillers) break the scan exactly as before.
    const key = lookupEnNumberToken(t);
    if (!key) break;
    if (key === 'and') { i++; continue; }   // connector inside magnitudes ("one hundred and twenty")
    if (key === 'hundred' || key === 'thousand') { scanned.push({ k: key }); i++; continue; }
    if (EN_TENS[key]) { scanned.push({ k: 'tens', v: parseInt(EN_TENS[key][0], 10) }); i++; continue; }
    scanned.push({ k: 'd', v: parseInt((EN_DIGIT[key] || EN_TEEN[key])[0], 10) });
    i++;
  }
  return { scanned, consumed: i };
}

/**
 * Parse a spoken VALUE (heading degrees / altitude ft / speed knots) from
 * leading tokens. EN input: token array; ZH input: string (no spaces).
 *
 * @returns {{ value: number, consumed: number, kind: string } | null}
 *   consumed = tokens (EN) / chars (ZH) consumed — the caller peeks the
 *   unit word right after.
 */
export function parseSpokenNumberValue(tokens, lang) {
  if (lang === 'zh') return parseZhSpokenValue(tokens);
  return parseEnSpokenValue(tokens);
}

function parseEnSpokenValue(tokens) {
  // 1. Arabic-digit fallback (speech engines and typed input emit digits)
  const first = normalizeToken(tokens[0] || '');
  if (/^\d{1,5}$/.test(first)) return { value: parseInt(first, 10), consumed: 1, kind: 'digits' };

  const { scanned, consumed } = scanEnNumeric(tokens);
  if (!scanned.length) return null;

  // 2. Magnitude path — hundred/thousand present: left-to-right groups,
  //    "two thousand"→2000, "nine thousand five hundred"→9500,
  //    "one hundred eighty"→180, "twelve hundred"→1200, "one hundred twenty five"→125
  if (scanned.some(s => s.k === 'hundred' || s.k === 'thousand')) {
    let total = 0, group = 0;
    for (let i = 0; i < scanned.length; i++) {
      const s = scanned[i];
      if (s.k === 'd') group = s.v;
      else if (s.k === 'tens') {
        let v = s.v;
        if (scanned[i + 1] && scanned[i + 1].k === 'd' && scanned[i + 1].v <= 9) { v += scanned[i + 1].v; i++; }
        group = v;
      }
      else if (s.k === 'hundred' || s.k === 'thousand') {
        group = (group || 1) * (s.k === 'hundred' ? 100 : 1000);
        total += group;
        group = 0;
      }
    }
    total += group;
    return { value: total, consumed, kind: 'magnitude' };
  }

  // 3. Digit-by-digit — every token a single digit word ("one two zero"→120,
  //    "nine zero zero zero"→9000)
  if (scanned.every(s => s.k === 'd' && s.v <= 9)) {
    return { value: parseInt(scanned.map(s => s.v).join(''), 10), consumed, kind: 'digits' };
  }

  // 4. Slot path — digit before tens = hundreds ("one twenty"→120,
  //    "one twenty five"→125, "five twenty"→520), tens + digit
  //    ("twenty five"→25), lone teen ("twelve"→12)
  let value = 0;
  let sawTens = false;
  for (const s of scanned) {
    if (s.k === 'tens') { value = value ? value * 100 + s.v : s.v; sawTens = true; }
    else value = sawTens ? value + s.v : value * 10 + s.v;
  }
  return { value, consumed, kind: 'slots' };
}

function parseZhSpokenValue(str) {
  const chars = [...str];
  if (!chars.length) return null;

  // 1. Arabic-digit fallback (typed input / speech engines)
  let d = 0;
  while (d < chars.length && /^\d$/.test(chars[d])) d++;
  if (d > 0) return { value: parseInt(chars.slice(0, d).join(''), 10), consumed: d, kind: 'digits' };

  // 2. Positional magnitude — 十/百/千 present: digit×unit accumulation
  //    ("九千"→9000, "两千"→2000, "一百八十"→180, "五千两百"→5200,
  //    "十一"→11, "一百零五"→105). Prefers this over digit-concat so
  //    九千 is 9000, never 9-0-0.
  const hasUnit = chars.some(ch => ch === '十' || ch === '百' || ch === '千');
  if (hasUnit) {
    const rankOf = (ch) => (ch === '千' ? 3 : ch === '百' ? 2 : ch === '十' ? 1 : 0);
    let value = 0, i = 0, prevRank = 99, lastUnitRank = 0;
    while (i < chars.length) {
      const ch = chars[i];
      if (ch === '零') { i++; lastUnitRank = 1; continue; }   // 零 resets to strict ×1 ("一百零五"→105)
      const dig = ZH_DIGIT[ch];
      if (dig) {
        const n = parseInt(dig[0], 10);
        const nx = chars[i + 1] || '';
        const rank = rankOf(nx);
        if (rank && rank < prevRank) {
          value += n * (rank === 3 ? 1000 : rank === 2 ? 100 : 10);
          prevRank = rank; lastUnitRank = rank; i += 2;
        } else {
          // Trailing digit: ×1 after 十 ("十一"→11), colloquial ×10 after 百
          // ("一百八"→180, not 108), ×100 after 千 ("一千五"→1500)
          value += n * (lastUnitRank ? 10 ** (lastUnitRank - 1) : 1);
          i++;
        }
      } else if (ch === '十' && prevRank > 1) { value += 10; prevRank = 1; lastUnitRank = 1; i++; }   // bare "十" opener
      else break;
    }
    if (i > 0) return { value, consumed: i, kind: 'magnitude' };
    return null;
  }

  // 3. Pure digit-by-digit ("幺二洞"→120, "两洞洞"→200)
  const digitChars = [];
  let k = 0;
  for (; k < chars.length; k++) {
    const dig = ZH_DIGIT[chars[k]];
    if (!dig) break;
    digitChars.push(dig[0]);
  }
  if (digitChars.length) return { value: parseInt(digitChars.join(''), 10), consumed: k, kind: 'digits' };
  return null;
}
