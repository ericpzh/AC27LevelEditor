/**
 * Spoken-number-to-digits parsers for English and Chinese aviation phraseology.
 *
 * English patterns handled:
 *   - Individual digits: "one two three four" → 1234
 *   - Teens:            "eleven", "thirteen" → 11, 13
 *   - Grouped pairs:    "twelve thirty four" → 1234
 *   - "hundred":        "one hundred" → 100 (rare in aviation)
 *   - "triple X":       "triple one" → 111
 *   - "oh" for zero:    "oh four" → 04
 *
 * Chinese patterns handled:
 *   - Digit-by-digit (yao-series):  "幺幺幺幺" → 1111
 *   - Digit-by-digit (yi-series):   "一一一一" → 1111
 *   - 洞 for 0:                     "洞四" → 04
 *   - 两 for 2:                     "一两三" → 123
 */

// ─── English word → digit(s) ──────────────────────────────────────────

/** Single-digit words (including "oh" for zero in aviation). */
const EN_DIGIT = {
  zero: ['0'], oh: ['0'],
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

// ─── Chinese word → digit(s) ───────────────────────────────────────────

/**
 * Chinese aviation digit mapping.
 * Both "幺" (yao) and "一" (yi) mean 1 — 幺 is preferred in radio comms.
 * "洞" (dong) means 0, "两" (liang) means 2.
 */
const ZH_DIGIT = {
  '零': ['0'], '洞': ['0'],
  '幺': ['1'], '一': ['1'],
  '二': ['2'], '两': ['2'],
  '三': ['3'], '四': ['4'],
  '五': ['5'], '六': ['6'],
  '七': ['7'], '八': ['8'],
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
 */
function tokenizeEnglish(tokens) {
  return tokens.map((t) => {
    const lower = t.toLowerCase();
    if (EN_DIGIT[lower]) return EN_DIGIT[lower];
    if (EN_TEEN[lower]) return EN_TEEN[lower];
    if (EN_TENS[lower]) return EN_TENS[lower];
    // "triple X" shorthand
    if (lower === 'triple' || lower === 'triple') return ['triple'];
    // "double X" shorthand (less common but possible)
    if (lower === 'double') return ['double'];
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
