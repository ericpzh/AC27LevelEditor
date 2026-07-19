/**
 * String-aware ACL text scanner.
 *
 * Replaces ALL brace-depth counting in the codebase with correct,
 * string-boundary-aware structural scanning. The core fix: when counting
 * { } or [ ] depth, characters inside string literals are skipped.
 *
 * All methods use in-place state tracking (no pre-processing needed).
 */
const tokenizer = {};

/**
 * Create a string-aware tokenizer for Unity JSON text.
 * Returns an object with methods for finding sections, boundaries, etc.
 */
function createTokenizer(text) {
  // ── Private helpers ──────────────────────────────────────────────

  /** Walk from start to pos, toggling inString on unescaped quotes. */
  function _isInsideString(pos) {
    let inString = false;
    for (let i = 0; i < pos; i++) {
      if (text[i] === '"' && (i === 0 || text[i - 1] !== '\\')) {
        inString = !inString;
      }
    }
    return inString;
  }

  /** Skip past a JSON string, starting at the opening " character.
   *  Returns the index of the closing " or null if unterminated. */
  function _skipString(start) {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '"' && text[i - 1] !== '\\') return i;
    }
    return null;
  }

  /**
   * Walk forward from `start`, tracking { } depth and string state.
   * Returns position AFTER the matching closing } (i.e. endIdx + 1).
   * Returns null if no matching } is found.
   */
  function _findObjectEndRaw(start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === '"' && (i === 0 || text[i - 1] !== '\\')) {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return null;
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Find a named section in the text and return its value range.
   *
   * @param {string} name - Section key name (e.g. "Config", "FlightPlans")
   * @returns {{ keyStart: number, valueStart: number, valueEnd: number } | null}
   *   keyStart   — position of opening " of the key
   *   valueStart — position of first character of the value
   *   valueEnd   — position AFTER the last character of the value
   */
  function findSection(name) {
    const searchStr = '"' + name + '"';
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const pos = text.indexOf(searchStr, searchFrom);
      if (pos < 0) return null;

      // Skip if this occurrence is inside a string value
      if (_isInsideString(pos)) {
        searchFrom = pos + 1;
        continue;
      }

      // Find the colon after the key
      const colonIdx = text.indexOf(':', pos);
      if (colonIdx < 0) return null;

      // Skip whitespace after colon
      let valStart = colonIdx + 1;
      while (valStart < text.length && ' \t\n\r'.includes(text[valStart])) valStart++;
      if (valStart >= text.length) return null;

      // Check for null value
      const peek = text.substring(valStart, valStart + 4);
      if (peek === 'null') {
        return { keyStart: pos, valueStart: valStart, valueEnd: valStart + 4 };
      }

      let valEnd;
      if (text[valStart] === '{') {
        valEnd = _findObjectEndRaw(valStart);
        if (valEnd === null) return null;
      } else if (text[valStart] === '[') {
        valEnd = findArrayEnd(valStart);
        if (valEnd === null) return null;
      } else if (text[valStart] === '"') {
        const strEnd = _skipString(valStart);
        if (strEnd === null) return null;
        valEnd = strEnd + 1;
      } else {
        // Number or boolean — scan to next structural break
        valEnd = valStart;
        while (valEnd < text.length && !',\r\n}'.includes(text[valEnd])) valEnd++;
      }

      return { keyStart: pos, valueStart: valStart, valueEnd: valEnd };
    }
    return null;
  }

  /**
   * Find the end of a JSON array (matching ]) starting from `start`
   * which MUST point at the opening [ character.
   *
   * String-aware: characters inside string literals are ignored
   * for brace/bracket depth counting.
   *
   * Handles the Unity pattern where arrays contain objects:
   *   [ { ... }, { ... } ]
   *
   * @returns {number | null} Position AFTER the matching ], or null
   */
  function findArrayEnd(start) {
    let braceDepth = 0;
    let bracketDepth = 0;
    let inString = false;

    for (let i = start; i < text.length; i++) {
      const c = text[i];

      // Track string state
      if (c === '"' && (i === 0 || text[i - 1] !== '\\')) {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (c === '{') {
        braceDepth++;
      } else if (c === '}') {
        braceDepth--;
        if (braceDepth === 0 && bracketDepth === 0) {
          // An object closed at top level — check if array closes after it
          let j = i + 1;
          while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
          if (j < text.length && text[j] === ']') return j + 1;
        }
      } else if (c === '[') {
        bracketDepth++;
      } else if (c === ']') {
        bracketDepth--;
        if (braceDepth === 0 && bracketDepth === 0) return i + 1;
      }
    }
    return null;
  }

  /**
   * Find the end of a JSON object (matching }) starting from `start`
   * which MUST point at the opening { character.
   *
   * String-aware: characters inside string literals are ignored.
   *
   * @returns {number | null} Position AFTER the matching }, or null
   */
  function findObjectEnd(start) {
    return _findObjectEndRaw(start);
  }

  /**
   * Get the position AFTER a JSON string's closing ".
   * @param {number} start - Position of the opening " character
   * @returns {number | null} Position after closing ", or null
   */
  function skipString(start) {
    const end = _skipString(start);
    return end !== null ? end + 1 : null;
  }

  /**
   * Extract a substring from the underlying text.
   * Convenience wrapper — just does text.substring(start, end).
   */
  function substring(start, end) {
    return text.substring(start, end);
  }

  /**
   * Scan forward from `start` to find the next occurrence of `char`
   * that is NOT inside a string literal.
   * @returns {number} Position of char, or text.length if not found
   */
  function findNextOutsideString(char, start) {
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === '"' && (i === 0 || text[i - 1] !== '\\')) {
        inString = !inString;
        continue;
      }
      if (!inString && c === char) return i;
    }
    return text.length;
  }

  /**
   * Find a specific key at a given depth within an object region and return
   * its value range. Only matches when the key is found at exactly `targetDepth`
   * (depth 1 = direct child of the object at `start`).
   *
   * This replaces both manual depth-counting (extractStringFromV4) and
   * regex-based key extraction (_extractString / _extractInt / _extractFloat)
   * with a single string-aware structural primitive.
   *
   * @param {number} start - Position of the opening { of the object to search
   * @param {number} end - Position after the closing } of the object
   * @param {string} key - The key name to find (without quotes)
   * @param {number} [targetDepth=1] - Depth at which the key must be found
   * @returns {{ valueStart: number, valueEnd: number } | null}
   */
  function findKeyAtDepth(start, end, key, targetDepth) {
    if (targetDepth === undefined) targetDepth = 1;
    const searchStr = '"' + key + '"';
    let depth = 0;
    let inString = false;

    for (let i = start; i < end; i++) {
      const c = text[i];
      if (c === '"' && (i === 0 || text[i - 1] !== '\\')) {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
      } else if (depth === targetDepth && text.substring(i, i + searchStr.length) === searchStr) {
        // Found the key at the correct depth — find its value
        const colonPos = text.indexOf(':', i + searchStr.length);
        if (colonPos < 0 || colonPos >= end) return null;

        let valStart = colonPos + 1;
        while (valStart < end && ' \t\n\r'.includes(text[valStart])) valStart++;
        if (valStart >= end) return null;

        // Determine value type and find its end
        let valEnd;
        if (text[valStart] === '"') {
          const strEnd = _skipString(valStart);
          if (strEnd === null) return null;
          valEnd = strEnd + 1;
        } else if (text[valStart] === '{') {
          const objEnd = _findObjectEndRaw(valStart);
          if (objEnd === null) return null;
          valEnd = objEnd;
        } else if (text[valStart] === '[') {
          const arrEnd = findArrayEnd(valStart);
          if (arrEnd === null) return null;
          valEnd = arrEnd;
        } else if (text.substring(valStart, valStart + 4) === 'null') {
          valEnd = valStart + 4;
        } else {
          // Number or boolean — scan to next structural break
          valEnd = valStart;
          while (valEnd < end && !',\r\n\t }]'.includes(text[valEnd])) valEnd++;
        }

        return { valueStart: valStart, valueEnd: valEnd };
      }
    }
    return null;
  }

  /**
   * Get all top-level key names in an object region.
   * Scans for quoted keys at depth 1 (inside the outermost {}).
   * String-aware.
   * @param {number} objStart - Position of opening {
   * @param {number} objEnd - Position after closing }
   * @returns {string[]} Array of key names in order of appearance
   */
  function getTopLevelKeys(objStart, objEnd) {
    const keys = [];
    let depth = 0;
    let inString = false;

    for (let i = objStart; i < objEnd; i++) {
      const c = text[i];
      if (c === '"' && (i === 0 || text[i - 1] !== '\\')) {
        inString = !inString;
        if (!inString) continue; // just closed a string
        // Starting a string at depth 1 — could be a key
        if (depth === 1) {
          const keyEnd = _skipString(i);
          if (keyEnd !== null) {
            // Check if this string is followed by : (making it a key)
            let j = keyEnd + 1;
            while (j < objEnd && ' \t\n\r'.includes(text[j])) j++;
            if (j < objEnd && text[j] === ':') {
              keys.push(text.substring(i + 1, keyEnd));
            }
            i = keyEnd; // skip past this string
            inString = false; // string ended at keyEnd
          }
        }
        continue;
      }
      if (inString) continue;
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
    }
    return keys;
  }

  // ── Return ───────────────────────────────────────────────────────

  return {
    findSection,
    findArrayEnd,
    findObjectEnd,
    skipString,
    findNextOutsideString,
    findKeyAtDepth,
    getTopLevelKeys,
    substring,
    getText: () => text,
    getLength: () => text.length,
  };
}

module.exports = { createTokenizer };
