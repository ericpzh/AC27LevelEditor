/**
 * Unity JSON pre-processor and serializer.
 *
 * PRE-PROCESSOR: Transforms Unity's non-standard JSON into valid JSON
 * that can be parsed by JSON.parse. Handles:
 *   1. Trailing commas (string-aware)
 *   2. NaN, Infinity
 *   3. Typed-value objects: {"$type": 3, 638781534000000000}
 *      → {"$type": 3, "__v": ["638781534000000000"]}
 *
 * SERIALIZER: Produces Unity-format JSON from JS objects.
 *   - Objects with __v sentinel → bare-value output
 *   - $type and $id ordered first in objects
 *   - First element in arrays gets full $type, rest get short-form
 *   - Int64 values stored as strings in __v → output unquoted
 */

const aclJson = {};

// ─── Pre-processor ─────────────────────────────────────────────────

/**
 * Transform Unity JSON text into valid JSON parseable by JSON.parse.
 *
 * Three passes:
 *   1. Fix trailing commas (string-aware)
 *   2. Fix NaN / Infinity
 *   3. Transform typed-value objects → __v sentinel
 *
 * @param {string} text - Raw Unity JSON text
 * @returns {string} Valid JSON text
 */
function preprocessUnityJson(text) {
  let result = text;

  // Pass 1: Fix trailing commas (before } and ])
  result = _fixTrailingCommas(result);

  // Pass 1.5: Insert missing commas between properties
  // Unity JSON may omit commas after nested object values
  result = _fixMissingCommas(result);

  // Pass 2: Fix NaN and Infinity
  result = _fixSpecialFloats(result);

  // Pass 3: Transform typed-value objects
  result = _fixTypedValues(result);

  return result;
}

// ── Pass 1: Trailing commas ───────────────────────────────────────

function _fixTrailingCommas(text) {
  const out = [];
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString;
      out.push(ch);
      continue;
    }

    if (inString) {
      out.push(ch);
      continue;
    }

    // Look for comma followed by only whitespace then } or ]
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
      if (j < text.length && (text[j] === '}' || text[j] === ']')) {
        // Trailing comma — skip it (consume whitespace too)
        i = j - 1; // will be incremented by loop
        continue;
      }
    }

    out.push(ch);
  }

  return out.join('');
}

// ── Pass 1.5: Missing commas between properties ───────────────────

/**
 * Unity JSON sometimes omits commas after nested object values
 * before the next property key. Standard JSON requires them.
 *
 * Example:
 *   "Arrival": { ... }
 *   "Departure": null
 *   → insert comma after }
 */
function _fixMissingCommas(text) {
  const out = [];
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString;
      out.push(ch);
      continue;
    }

    if (inString) {
      out.push(ch);
      continue;
    }

    out.push(ch);

    // After a closing brace that ends a nested object value,
    // if the next non-whitespace char is " (a new property key),
    // we need to insert a comma.
    if (ch === '}') {
      let j = i + 1;
      while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
      if (j < text.length && text[j] === '"') {
        // Check it's not the end of the parent object:
        // if text[j] is " then this is a new key — need comma
        out.push(',');
      }
    }
  }

  return out.join('');
}

// ── Pass 2: NaN / Infinity ────────────────────────────────────────

function _fixSpecialFloats(text) {
  // Replace bare NaN/Infinity (outside strings) with safe values.
  // Order matters: replace -Infinity before Infinity so Infinity doesn't
  // consume the "Infinity" part of "-Infinity" first.
  let result = text.replace(/(?<![.\w])NaN(?![.\w])/g, '0');
  result = result.replace(/(?<![.\w])-Infinity(?![.\w])/g, 'null');
  result = result.replace(/(?<![.\w])Infinity(?![.\w])/g, 'null');
  return result;
}

// ── Pass 3: Typed-value objects ───────────────────────────────────

/**
 * Transform typed-value objects:
 *   {"$type": 3, 638781534000000000}
 *   → {"$type": 3, "__v": ["638781534000000000"]}
 *
 *   {"$type": "16|...", 10.5, 0, 20.3}
 *   → {"$type": "16|...", "__v": [10.5, 0, 20.3]}
 *
 * Only transforms objects whose first non-$id key is "$type"
 * and where bare numeric values follow the $type value.
 */
function _fixTypedValues(text) {
  const out = [];
  let i = 0;
  let inString = false;
  let depth = 0;

  while (i < text.length) {
    const ch = text[i];

    // Track string state
    if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString;
      out.push(ch);
      i++;
      continue;
    }

    if (inString) {
      out.push(ch);
      i++;
      continue;
    }

    // Track depth
    if (ch === '{') {
      depth++;

      // Look ahead to see if this object starts with $id then $type
      const afterBrace = _skipWs(text, i + 1);
      if (afterBrace < text.length && text[afterBrace] === '"') {
        // Read first key
        const firstKeyEnd = _readQuotedString(text, afterBrace);
        if (firstKeyEnd !== null) {
          const firstKey = text.substring(afterBrace + 1, firstKeyEnd);

          // The key we care about: could be $type directly, or $id then $type
          let typeKeyStart = null;
          let typeKeyEnd = null;
          let typeValStart = null;
          let typeValEnd = null;

          if (firstKey === '$type') {
            typeKeyStart = afterBrace;
            typeKeyEnd = firstKeyEnd;
            // Find $type value
            const colon = _findNextOutsideString(text, ':', firstKeyEnd + 1);
            if (colon !== text.length) {
              typeValStart = _skipWs(text, colon + 1);
              typeValEnd = _readValueEnd(text, typeValStart);
            }
          } else if (firstKey === '$id') {
            // Skip $id value
            const colon = _findNextOutsideString(text, ':', firstKeyEnd + 1);
            if (colon !== text.length) {
              let idValStart = _skipWs(text, colon + 1);
              let idValEnd = _readValueEnd(text, idValStart);
              // Skip comma after $id
              let afterId = _skipWs(text, idValEnd);
              if (afterId < text.length && text[afterId] === ',') {
                let afterComma = _skipWs(text, afterId + 1);
                // Check for "$type" key
                if (afterComma < text.length && text[afterComma] === '"' &&
                    text.substring(afterComma, afterComma + 7) === '"$type"') {
                  typeKeyStart = afterComma;
                  typeKeyEnd = _readQuotedString(text, afterComma);
                  if (typeKeyEnd !== null) {
                    const tcolon = _findNextOutsideString(text, ':', typeKeyEnd + 1);
                    if (tcolon !== text.length) {
                      typeValStart = _skipWs(text, tcolon + 1);
                      typeValEnd = _readValueEnd(text, typeValStart);
                    }
                  }
                }
              }
            }
          }

          // If we found $type, check if bare values follow
          if (typeValStart !== null && typeValEnd !== null) {
            let afterType = _skipWs(text, typeValEnd);
            if (afterType < text.length && text[afterType] === ',') {
              let afterComma = _skipWs(text, afterType + 1);
              // If next char is NOT " (not a key), it's a bare value
              if (afterComma < text.length && text[afterComma] !== '"' &&
                  text[afterComma] !== '}' && text[afterComma] !== '{') {
                // This IS a typed-value object
                // Collect the bare values and find the object end
                const { bareValues, objEnd } = _collectBareValues(text, afterComma, i);

                if (objEnd !== null) {
                  // Output transformed object
                  out.push('{');

                  // $id (if present)
                  if (firstKey === '$id') {
                    const idKeyEnd = _readQuotedString(text, afterBrace);
                    const idColon = _findNextOutsideString(text, ':', idKeyEnd + 1);
                    const idValS = _skipWs(text, idColon + 1);
                    const idValE = _readValueEnd(text, idValS);
                    out.push(text.substring(afterBrace, idValE));
                    out.push(', ');
                  }

                  // $type key and value
                  out.push(text.substring(typeKeyStart, typeValEnd));
                  out.push(', ');

                  // __v sentinel with bare values
                  out.push('"__v": [');
                  out.push(bareValues.join(', '));
                  out.push(']');

                  out.push('}');

                  i = objEnd;
                  depth--;
                  continue;
                }
              }
            }
          }
        }
      }

      out.push(ch);
      i++;
      continue;
    }

    if (ch === '}') {
      depth--;
    }

    out.push(ch);
    i++;
  }

  return out.join('');
}

/**
 * Collect bare numeric values from inside a typed-value object.
 * Starts at the position of the first bare value.
 * Returns { bareValues: string[], objEnd: number }
 *
 * bareValues are strings — int64 values are JSON-string-quoted,
 * float values are raw numbers. This preserves precision.
 */
function _collectBareValues(text, firstValPos, objStart) {
  const bareValues = [];
  let pos = firstValPos;
  let depth = 1; // We're inside the object (depth relative to objStart)
  let inString = false;

  while (pos < text.length) {
    const ch = text[pos];

    if (ch === '"' && (pos === 0 || text[pos - 1] !== '\\')) {
      inString = !inString;
      pos++;
      continue;
    }

    if (inString) {
      pos++;
      continue;
    }

    if (ch === '{') {
      // Nested object — skip it
      const nestedEnd = _findObjectEnd(text, pos);
      if (nestedEnd === null) return { bareValues: [], objEnd: null };
      // Collect anything between last value and this nested object as bare values
      // (but this shouldn't happen in practice)
      pos = nestedEnd;
      continue;
    }

    if (ch === '}') {
      depth--;
      if (depth === 0) {
        // End of the typed-value object
        return { bareValues, objEnd: pos + 1 };
      }
      pos++;
      continue;
    }

    // Skip whitespace
    if (' \t\n\r'.includes(ch)) {
      pos++;
      continue;
    }

    // If we hit a quoted string, this is a key — stop collecting bare values
    if (ch === '"') {
      // This means bare values ended and a new property started
      // Find the end of this object
      const objEnd = _findObjectEndFromDepth(text, pos, depth);
      return { bareValues, objEnd };
    }

    // Comma between bare values
    if (ch === ',') {
      pos++;
      continue;
    }

    // Must be a number (bare value)
    if (ch === '-' || ch === '+' || (ch >= '0' && ch <= '9') || ch === '.') {
      const start = pos;
      // Scan the number (could be huge int64, float, or scientific notation)
      while (pos < text.length && /[-\d.eE+]/.test(text[pos])) pos++;

      const numStr = text.substring(start, pos);

      // Determine if this is a huge integer that needs string preservation
      // .NET DateTime ticks are 18+ digit integers
      if (/^-?\d{16,}$/.test(numStr)) {
        // Store as quoted string to preserve precision through JSON.parse
        bareValues.push('"' + numStr + '"');
      } else {
        bareValues.push(numStr);
      }

      continue;
    }

    // Unknown character — shouldn't happen
    pos++;
  }

  return { bareValues: [], objEnd: null };
}

/**
 * Find the end of an object starting from a position inside it.
 * Used when we need to find the closing } after bare values end.
 */
function _findObjectEndFromDepth(text, start, targetDepth) {
  let depth = targetDepth;
  let inString = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return null;
}

// ── Helpers used by pre-processor ──────────────────────────────────

function _skipWs(text, start) {
  let i = start;
  while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  return i;
}

function _readQuotedString(text, quotePos) {
  // quotePos points to the opening "
  for (let i = quotePos + 1; i < text.length; i++) {
    if (text[i] === '"' && text[i - 1] !== '\\') return i;
  }
  return null;
}

function _readValueEnd(text, start) {
  const ch = text[start];
  if (ch === '"') {
    const end = _readQuotedString(text, start);
    return end !== null ? end + 1 : start + 1;
  }
  if (ch === '{') {
    const end = _findObjectEnd(text, start);
    return end !== null ? end : start + 1;
  }
  if (ch === '[') {
    return _findArrayEnd(text, start) || start + 1;
  }
  // Number, boolean, null
  let i = start;
  while (i < text.length && !',\n\r}'.includes(text[i])) i++;
  return i;
}

function _findNextOutsideString(text, char, start) {
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }
    if (!inString && ch === char) return i;
  }
  return text.length;
}

function _findObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

function _findArrayEnd(text, start) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') braceDepth++;
    else if (ch === '}') {
      braceDepth--;
      if (braceDepth === 0 && bracketDepth === 0) {
        let j = i + 1;
        while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
        if (j < text.length && text[j] === ']') return j + 1;
      }
    } else if (ch === '[') bracketDepth++;
    else if (ch === ']') {
      bracketDepth--;
      if (braceDepth === 0 && bracketDepth === 0) return i + 1;
    }
  }
  return null;
}

// ─── Serializer ────────────────────────────────────────────────────

/**
 * Serialize a JavaScript value to Unity JSON format.
 *
 * Handles:
 *   - __v sentinel → bare values in output
 *   - $type / $id ordering (always first in objects)
 *   - $rcontent / $rlength array wrappers
 *   - First-in-array gets full $type, rest get short-form number
 *   - String-quoted int64 in __v → bare unquoted number
 *
 * @param {*} value - JS value to serialize
 * @param {object} [options]
 * @param {number} [options.indent=0] - Current indent level
 * @param {number} [options.indentSize=4] - Spaces per indent level
 * @param {Map<number,string>} [options.typeMap] - For expanding short types
 * @param {boolean} [options.isFirstInArray=false] - This object is first in an array
 * @returns {string} Unity JSON string
 */
function serializeUnityJson(value, options = {}) {
  const { indent = 0, indentSize = 4 } = options;
  const pad = ' '.repeat(indent * indentSize);
  const innerPad = ' '.repeat((indent + 1) * indentSize);

  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return _serializeArray(value, options);
  }

  if (typeof value === 'object') {
    return _serializeObject(value, options, pad, innerPad);
  }

  return String(value);
}

/**
 * Serialize a JS object to Unity JSON.
 */
function _serializeObject(obj, options, pad, innerPad) {
  const { indent, indentSize, isFirstInArray } = options;

  // Collect parts in order
  const parts = [];

  // 1. $id (if present)
  if ('$id' in obj) {
    parts.push({ key: '$id', value: obj['$id'] });
  }

  // 2. $type (if present)
  if ('$type' in obj) {
    parts.push({ key: '$type', value: obj['$type'] });
  }

  // 3. $ref (if present)
  if ('$ref' in obj) {
    parts.push({ key: '$ref', value: obj['$ref'] });
  }

  // 4. Bare values (from __v sentinel)
  let bareVals = [];
  if ('__v' in obj) {
    const v = obj['__v'];
    if (Array.isArray(v)) {
      bareVals = v;
    } else {
      bareVals = [v];
    }
  }

  // 5. Regular keys
  const SPECIAL_KEYS = new Set([
    '$id', '$type', '$ref',
    '$rcontent', '$rlength', '$values',
    '__v',
  ]);

  for (const key of Object.keys(obj)) {
    if (SPECIAL_KEYS.has(key)) continue;
    parts.push({ key, value: obj[key] });
  }

  // 6. $rlength (before $rcontent)
  const hasRcontent = '$rcontent' in obj;
  // Move $rcontent to the end, and insert $rlength before it
  if (hasRcontent) {
    // Remove any rcontent/rlength from parts (they might be in regular keys)
    const rlIdx = parts.findIndex(p => p.key === '$rlength');
    const rcIdx = parts.findIndex(p => p.key === '$rcontent');
    if (rcIdx >= 0) parts.splice(rcIdx, 1);
    if (rlIdx >= 0) parts.splice(rlIdx < rcIdx ? rlIdx : rlIdx - 1, 1);

    const rlength = obj['$rlength'];
    const rcontent = obj['$rcontent'];

    parts.push({ key: '$rlength', value: rlength !== undefined ? rlength : rcontent.length });
    parts.push({ key: '$rcontent', value: rcontent, _isArrayContent: true });
  }

  // 7. $values (if present)
  if ('$values' in obj && !hasRcontent) {
    parts.push({ key: '$values', value: obj['$values'] });
  }

  // Build output lines in correct order:
  // $id → $type → $ref → bare values (from __v) → regular keys → $rlength → $rcontent
  const lines = [];
  let bareValuesOutput = false;

  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];

    // Output this part
    const valStr = part._isArrayContent
      ? _serializeRcontent(part.value, { ...options, indent: indent + 1 })
      : _serializePartValue(part.value, { ...options, indent: indent + 1 });

    const keyStr = JSON.stringify(part.key);
    lines.push(innerPad + keyStr + ': ' + valStr);

    // After outputting $type (or $ref if no $type), output bare values
    if (!bareValuesOutput && bareVals.length > 0 &&
        (part.key === '$type' || part.key === '$ref')) {
      for (const bv of bareVals) {
        lines.push(innerPad + _formatBareValue(bv));
      }
      bareValuesOutput = true;
    }
  }

  // If bare values haven't been output yet (no $type/$ref in parts), output them now
  if (!bareValuesOutput && bareVals.length > 0) {
    // Insert after the first part (usually $id)
    // Actually, output at the beginning
    lines.unshift(...bareVals.map(bv => innerPad + _formatBareValue(bv)));
    bareValuesOutput = true;
  }

  if (lines.length === 0) return '{}';

  // Add commas between all elements
  const withCommas = lines.map((line, idx) => {
    return idx < lines.length - 1 ? line + ',' : line;
  });

  return '{\n' + withCommas.join('\n') + '\n' + pad + '}';
}

/**
 * Serialize a value that is a property value (not a top-level value).
 * Handles the first-in-array full-type convention.
 */
function _serializePartValue(value, options) {
  return serializeUnityJson(value, options);
}

/**
 * Serialize the $rcontent array with proper type handling.
 * First element gets full type, subsequent get short-form.
 */
function _serializeRcontent(arr, options) {
  if (!Array.isArray(arr)) {
    return serializeUnityJson(arr, options);
  }

  if (arr.length === 0) return '[]';

  const { indent, indentSize } = options;
  const pad = ' '.repeat(indent * indentSize);
  const innerPad = ' '.repeat((indent + 1) * indentSize);

  const elements = arr.map((item, idx) => {
    const isFirst = idx === 0;
    const serialized = serializeUnityJson(item, {
      ...options,
      indent: indent + 1,
      isFirstInArray: isFirst,
    });
    return innerPad + serialized;
  });

  return '[\n' + elements.join(',\n') + '\n' + pad + ']';
}

/**
 * Serialize a JS array to Unity JSON.
 */
function _serializeArray(arr, options) {
  if (arr.length === 0) return '[]';

  const { indent, indentSize } = options;
  const pad = ' '.repeat(indent * indentSize);
  const innerPad = ' '.repeat((indent + 1) * indentSize);

  const elements = arr.map((item, idx) => {
    const serialized = serializeUnityJson(item, {
      ...options,
      indent: indent + 1,
      isFirstInArray: idx === 0,
    });
    return innerPad + serialized;
  });

  return '[\n' + elements.join(',\n') + '\n' + pad + ']';
}

/**
 * Format a bare value for output.
 * Strings that look like integers → output unquoted (int64 preservation).
 * Numbers → output as-is.
 */
function _formatBareValue(val) {
  if (typeof val === 'string') {
    // If it looks like an integer, output unquoted
    if (/^-?\d{1,30}$/.test(val)) {
      return val;
    }
    return JSON.stringify(val);
  }
  if (typeof val === 'number') {
    return String(val);
  }
  return String(val);
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Quick check: is the given text likely parseable Unity JSON?
 * Just checks if it contains the Unity JSON signature patterns.
 */
function isUnityJson(text) {
  return text.includes('"$type"') || text.includes('"$rcontent"');
}

module.exports = {
  preprocessUnityJson,
  serializeUnityJson,
  isUnityJson,
  // Exposed for testing
  _fixTrailingCommas,
  _fixMissingCommas,
  _fixSpecialFloats,
  _fixTypedValues,
};
