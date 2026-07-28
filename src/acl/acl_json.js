/**
 * Unity JSON pre-processor and serializer.
 *
 * PRE-PROCESSOR: Transforms Unity's non-standard JSON into valid JSON
 * that can be parsed by JSON.parse. Handles:
 *   0. Odin reference values: $iref:N → {"__iref":N},
 *      $fstrref:"k" → {"__fstrref":"k"}, $eref:N → {"__eref":N},
 *      $guidref:G → {"__guidref":"G"} (string-aware)
 *   1. Trailing commas (string-aware)
 *   2. NaN, Infinity
 *   3. Typed-value objects: {"$type": 3, 638781534000000000}
 *      → {"$type": 3, "__v": ["638781534000000000"]}
 *
 * SERIALIZER: Produces Unity-format JSON from JS objects.
 *   - Objects with __v sentinel → bare-value output
 *   - Objects with __iref/__fstrref/__eref/__guidref sentinel → bare $iref:$fstrref/etc. tokens
 *   - $type and $id ordered first in objects
 *   - First element in arrays gets full $type, rest get short-form
 *   - Int64 values stored as strings in __v → output unquoted
 */

const aclJson = {};
const { SPECIAL_KEYS } = require('./constants');

// ─── Pre-processor ─────────────────────────────────────────────────

/**
 * Transform Unity JSON text into valid JSON parseable by JSON.parse.
 *
 * Four passes:
 *   0. Transform Odin reference values → sentinel objects (string-aware)
 *   1. Fix trailing commas (string-aware)
 *   1.5. Insert missing commas between properties
 *   2. Fix NaN / Infinity
 *   3. Transform typed-value objects → __v sentinel
 *
 * @param {string} text - Raw Unity JSON text
 * @returns {string} Valid JSON text
 */
function preprocessUnityJson(text) {
  let result = text;

  // Pass 0: Transform Odin reference values → sentinel objects
  result = _fixOdinReferences(result);

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

// ── Pass 0: Odin reference values ─────────────────────────────────

/**
 * Transform Odin reference tokens into sentinel objects that JSON.parse can handle.
 *
 * Operates string-aware (tracks in/out of quoted strings) so reference-like patterns
 * inside string values are not touched.
 *
 * Transformations:
 *   $iref:123           → {"__iref":123}
 *   $fstrref:"key"      → {"__fstrref":"key"}
 *   $eref:456           → {"__eref":456}
 *   $guidref:deadbeef-...→ {"__guidref":"deadbeef-..."}
 *
 * @param {string} text
 * @returns {string}
 */
function _fixOdinReferences(text) {
  const out = [];
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Track string boundaries
    if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString;
      out.push(ch);
      continue;
    }

    if (inString) {
      out.push(ch);
      continue;
    }

    // $iref:N
    if (text.startsWith('$iref:', i)) {
      let j = i + 6; // skip '$iref:'
      while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
      const id = text.substring(i + 6, j);
      if (id.length > 0) {
        out.push('{"__iref":' + id + '}');
        i = j - 1;
        continue;
      }
    }

    // $eref:N
    if (text.startsWith('$eref:', i)) {
      let j = i + 6; // skip '$eref:'
      while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
      const id = text.substring(i + 6, j);
      if (id.length > 0) {
        out.push('{"__eref":' + id + '}');
        i = j - 1;
        continue;
      }
    }

    // $fstrref:"..." — the string is a standard JSON string with escapes
    if (text.startsWith('$fstrref:', i)) {
      let j = i + 9; // skip '$fstrref:'
      if (j < text.length && text[j] === '"') {
        const strStart = j;
        j++; // skip opening quote
        while (j < text.length) {
          if (text[j] === '\\') { j += 2; continue; } // skip escape sequence
          if (text[j] === '"') { j++; break; }         // closing quote
          j++;
        }
        const quotedStr = text.substring(strStart, j); // includes surrounding quotes
        out.push('{"__fstrref":' + quotedStr + '}');
        i = j - 1;
        continue;
      }
    }

    // $guidref:GUID — GUID format: 8-4-4-4-12 hex digits
    if (text.startsWith('$guidref:', i)) {
      let j = i + 9; // skip '$guidref:'
      const guidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
      const rest = text.substring(j);
      const match = rest.match(guidRe);
      if (match) {
        j += match[0].length;
        out.push('{"__guidref":"' + match[0] + '"}');
        i = j - 1;
        continue;
      }
    }

    out.push(ch);
  }

  return out.join('');
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
              // If next char is NOT " (not a key start) and NOT } (object end),
              // it's a bare value (number, nested object, array, etc.)
              if (afterComma < text.length && text[afterComma] !== '"' &&
                  text[afterComma] !== '}') {
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
      // Nested object — capture and recursively preprocess to fix
      // any inner typed-value objects (e.g. ModelOffset inside Aircraft)
      const nestedEnd = _findObjectEnd(text, pos);
      if (nestedEnd === null) return { bareValues: [], objEnd: null };
      var nestedText = text.substring(pos, nestedEnd);
      // Recursively fix typed values inside the nested object
      nestedText = _fixTypedValues(nestedText);
      bareValues.push(nestedText);
      pos = nestedEnd;
      continue;
    }

    if (ch === '[') {
      // Nested array — capture and recursively preprocess
      const arrEnd = _findArrayEnd(text, pos);
      if (arrEnd === null) return { bareValues: [], objEnd: null };
      var arrText = text.substring(pos, arrEnd);
      arrText = _fixTypedValues(arrText);
      bareValues.push(arrText);
      pos = arrEnd;
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

    // Handle null/true/false as bare values
    if (text.startsWith('null', pos)) {
      bareValues.push('null');
      pos += 4;
      continue;
    }
    if (text.startsWith('true', pos)) {
      bareValues.push('true');
      pos += 4;
      continue;
    }
    if (text.startsWith('false', pos)) {
      bareValues.push('false');
      pos += 5;
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
    // Odin reference sentinels — output as bare tokens
    if ('__iref' in value) return '$iref:' + value.__iref;
    if ('__fstrref' in value) return '$fstrref:' + JSON.stringify(value.__fstrref);
    if ('__eref' in value) return '$eref:' + value.__eref;
    if ('__guidref' in value) return '$guidref:' + value.__guidref;
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

  // 5. Regular keys (SPECIAL_KEYS imported from ./constants)

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
  if (typeof val === 'boolean') {
    return String(val);
  }
  if (val === null || val === undefined) {
    return 'null';
  }
  if (typeof val === 'object') {
    // Odin reference sentinels
    if ('__iref' in val) return '$iref:' + val.__iref;
    if ('__fstrref' in val) return '$fstrref:' + JSON.stringify(val.__fstrref);
    if ('__eref' in val) return '$eref:' + val.__eref;
    if ('__guidref' in val) return '$guidref:' + val.__guidref;
    // Other objects (typed-value objects, etc.) — recursively serialize
    // without adding extra indentation for inline use
    return serializeUnityJson(val, { indent: 0, indentSize: 4 });
  }
  return String(val);
}

// ─── Odin Parser ───────────────────────────────────────────────────

/**
 * Parse any Odin blobdoc value starting at `start` in `text`.
 * String-aware recursive-descent parser — no regex on the parse path.
 *
 * Produces JS objects with the same sentinel conventions that
 * `serializeUnityJson` expects: `__iref`, `__fstrref`, `__eref`,
 * `__guidref` for Odin references; `__v` for typed-value bare values.
 *
 * @param {string} text   - Full text being parsed
 * @param {number} start  - Position to start parsing from
 * @param {{ inString?: boolean }} [state] - Mutable state bag (caller may pass
 *   { inString: false } to share string-tracking across calls)
 * @returns {{ value: any, end: number, error?: string }}
 */
function parseOdinValue(text, start, state) {
  if (!state) state = { inString: false };
  if (start >= text.length) {
    return { value: undefined, end: start, error: 'Unexpected end of input' };
  }

  // Sync string state from start of text to current position (once per value,
  // not per character — the caller is responsible for calling with positions
  // that are not inside strings, or pre-seeding state.inString correctly).
  var inString = state.inString || _isInsideStringPos(text, 0, start);
  var c = text[start];

  // Skip whitespace
  var i = start;
  while (i < text.length && ' \t\n\r'.includes(text[i])) { i++; }
  if (i >= text.length) return { value: undefined, end: i, error: 'Unexpected end of input' };
  c = text[i];

  // ── String ──────────────────────────────────────────────────
  if (c === '"') {
    return _parseJsonString(text, i);
  }

  // ── Object ──────────────────────────────────────────────────
  if (c === '{') {
    return parseOdinObject(text, i, state);
  }

  // ── Array ───────────────────────────────────────────────────
  if (c === '[') {
    return parseOdinArray(text, i, state);
  }

  // ── Odin reference tokens ───────────────────────────────────
  if (c === '$') {
    return _parseOdinReference(text, i);
  }

  // ── Number ──────────────────────────────────────────────────
  if (c === '-' || (c >= '0' && c <= '9')) {
    return _parseNumber(text, i);
  }

  // ── null / true / false ─────────────────────────────────────
  if (text.substring(i, i + 4) === 'null')  return { value: null, end: i + 4 };
  if (text.substring(i, i + 4) === 'true')  return { value: true, end: i + 4 };
  if (text.substring(i, i + 5) === 'false') return { value: false, end: i + 5 };

  return { value: undefined, end: i, error: 'Unexpected character "' + c + '" at position ' + i };
}

/**
 * Parse a JSON string starting at the opening ".
 * Returns the decoded string value and position after closing ".
 */
function _parseJsonString(text, start) {
  // start points at opening "
  var out = '';
  var i = start + 1;
  while (i < text.length) {
    var c = text[i];
    if (c === '\\') {
      i++;
      if (i >= text.length) return { value: out, end: i, error: 'Unterminated escape in string' };
      var esc = text[i];
      switch (esc) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u':
          // \uXXXX — capture 4 hex digits
          if (i + 4 >= text.length) return { value: out, end: i, error: 'Unterminated \\u escape' };
          var hex = text.substring(i + 1, i + 5);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        default: out += esc; break;
      }
      i++;
    } else if (c === '"') {
      return { value: out, end: i + 1 };
    } else {
      out += c;
      i++;
    }
  }
  return { value: out, end: i, error: 'Unterminated string' };
}

/**
 * Parse an Odin reference token: $iref:N, $eref:N, $fstrref:"...", $guidref:GUID
 */
function _parseOdinReference(text, start) {
  // Check each reference type
  if (text.startsWith('$iref:', start)) {
    var i = start + 6;
    var digits = '';
    while (i < text.length && text[i] >= '0' && text[i] <= '9') {
      digits += text[i]; i++;
    }
    if (digits.length > 0) {
      return { value: { __iref: parseInt(digits, 10) }, end: i };
    }
  }

  if (text.startsWith('$eref:', start)) {
    var j = start + 6;
    var edigits = '';
    while (j < text.length && text[j] >= '0' && text[j] <= '9') {
      edigits += text[j]; j++;
    }
    if (edigits.length > 0) {
      return { value: { __eref: parseInt(edigits, 10) }, end: j };
    }
  }

  if (text.startsWith('$fstrref:', start)) {
    var k = start + 9;
    if (k < text.length && text[k] === '"') {
      var strResult = _parseJsonString(text, k);
      if (strResult.error) return strResult;
      return { value: { __fstrref: strResult.value }, end: strResult.end };
    }
  }

  if (text.startsWith('$guidref:', start)) {
    var g = start + 9;
    var guid = '';
    // GUID: 8-4-4-4-12 hex digits
    while (g < text.length && /[0-9a-fA-F\-]/.test(text[g])) {
      guid += text[g]; g++;
    }
    if (guid.length > 0) {
      return { value: { __guidref: guid }, end: g };
    }
  }

  return { value: undefined, end: start, error: 'Unknown Odin reference token at ' + start };
}

/**
 * Parse a number (integer or float).
 */
function _parseNumber(text, start) {
  var i = start;
  var numStr = '';
  if (text[i] === '-') { numStr += '-'; i++; }
  while (i < text.length && text[i] >= '0' && text[i] <= '9') {
    numStr += text[i]; i++;
  }
  // Fractional part
  if (i < text.length && text[i] === '.') {
    numStr += '.'; i++;
    while (i < text.length && text[i] >= '0' && text[i] <= '9') {
      numStr += text[i]; i++;
    }
  }
  // Exponent
  if (i < text.length && (text[i] === 'e' || text[i] === 'E')) {
    numStr += text[i]; i++;
    if (i < text.length && (text[i] === '+' || text[i] === '-')) {
      numStr += text[i]; i++;
    }
    while (i < text.length && text[i] >= '0' && text[i] <= '9') {
      numStr += text[i]; i++;
    }
  }

  if (numStr === '-' || numStr === '') {
    return { value: 0, end: i, error: 'Invalid number at ' + start };
  }

  // Use Number(); for int64 values (>2^53) precision may be lost, but those
  // only appear as typed-value DateTime ticks, which __v already captures as
  // strings. Regular numbers in Odin are Float32/Float64/Int32.
  return { value: Number(numStr), end: i };
}

/**
 * Parse an Odin blobdoc object starting at the opening {.
 *
 * Handles:
 *  - Regular key-value objects
 *  - Typed-value objects ($type + bare values)
 *  - $id, $type, $ref as special top-level keys
 *  - Nested objects and arrays (recursively parsed into actual JS objects)
 *
 * @returns {{ value: object, end: number, error?: string }}
 */
function parseOdinObject(text, start, state) {
  if (!state) state = { inString: false };
  // start must point to '{'
  var obj = {};
  var i = start + 1; // skip '{'
  var hadBareValues = false;

  while (i < text.length) {
    // Skip whitespace (but first sync string state at this position)
    while (i < text.length && ' \t\n\r'.includes(text[i])) { i++; }
    if (i >= text.length) {
      return { value: obj, end: i, error: 'Unterminated object' };
    }

    // End of object
    if (text[i] === '}') {
      return { value: obj, end: i + 1 };
    }

    // Comma — skip and continue
    if (text[i] === ',') {
      i++;
      continue;
    }

    // If we're in bare-value mode (after $type in a typed-value object),
    // the next token is a bare value, not a key.
    if (hadBareValues) {
      // Quoted string in bare-value position: peek ahead to see if it's
      // a bare string value (followed by , or }) or a new key (followed by :).
      if (text[i] === '"') {
        var strRes = _parseJsonString(text, i);
        if (strRes.error) return { value: obj, end: i, error: strRes.error };
        var afterStr = strRes.end;
        while (afterStr < text.length && ' \t\n\r'.includes(text[afterStr])) { afterStr++; }
        if (afterStr < text.length && text[afterStr] === ':') {
          // It's a key — typed-value bare section has ended
          hadBareValues = false;
          continue; // reprocess as key-value
        }
        // Bare string value
        if (!obj.__v) obj.__v = [];
        obj.__v.push(strRes.value);
        i = strRes.end;
        continue;
      }

      // Non-string bare value: number, nested object/array, reference token, etc.
      var bareResult = parseOdinValue(text, i, state);
      if (bareResult.error) {
        if (text[i] === '}') {
          return { value: obj, end: i + 1 };
        }
        return bareResult;
      }
      if (!obj.__v) obj.__v = [];
      obj.__v.push(bareResult.value);
      i = bareResult.end;
      continue;
    }

    // ── Key-value mode ──────────────────────────────────────────
    // Expect a quoted string key
    if (text[i] !== '"') {
      // Could be a bare value we missed, or end of object
      if (text[i] === '}') return { value: obj, end: i + 1 };
      return { value: obj, end: i, error: 'Expected key (quoted string) at position ' + i + ', got "' + text[i] + '"' };
    }

    // Check if we're inside a string — if the opening " closes an existing
    // string, this is NOT a key. For robustness, just parse the string.
    var keyResult = _parseJsonString(text, i);
    if (keyResult.error) return { value: obj, end: i, error: keyResult.error };
    var key = keyResult.value;
    i = keyResult.end;

    // Skip whitespace and ':'
    while (i < text.length && ' \t\n\r'.includes(text[i])) { i++; }
    if (i >= text.length || text[i] !== ':') {
      return { value: obj, end: i, error: 'Expected ":" after key "' + key + '" at position ' + i };
    }
    i++; // skip ':'
    while (i < text.length && ' \t\n\r'.includes(text[i])) { i++; }

    // Parse value
    var valResult = parseOdinValue(text, i, state);
    if (valResult.error) return { value: obj, end: i, error: valResult.error };

    // Store the key-value pair
    obj[key] = valResult.value;
    i = valResult.end;

    // Check for typed-value pattern: if this key was $type (possibly after $id),
    // look ahead to see if bare values follow.
    if (key === '$type') {
      // Skip whitespace after the value
      var peek = i;
      while (peek < text.length && ' \t\n\r'.includes(text[peek])) { peek++; }

      if (peek < text.length && text[peek] === ',') {
        peek++; // skip comma
        while (peek < text.length && ' \t\n\r'.includes(text[peek])) { peek++; }

        if (peek < text.length) {
          var nextC = text[peek];
          // If next char is " (quoted string), check if it's a key (followed by :)
          // or a bare string value (followed by , or })
          if (nextC === '"') {
            var strRes = _parseJsonString(text, peek);
            if (!strRes.error) {
              var afterStr = strRes.end;
              while (afterStr < text.length && ' \t\n\r'.includes(text[afterStr])) { afterStr++; }
              if (afterStr < text.length && text[afterStr] === ':') {
                // It's a key — this is a regular object, not typed-value
                continue;
              }
              // It's a bare string value
              hadBareValues = true;
              if (!obj.__v) obj.__v = [];
              obj.__v.push(strRes.value);
              i = strRes.end;
              continue;
            }
          } else if (nextC !== '}' && nextC !== '"') {
            // Bare value: number, nested object, array, reference token, etc.
            hadBareValues = true;
            continue; // next iteration will parse as bare value
          }
        }
      }
    }
  }

  return { value: obj, error: 'Unterminated object' };
}

/**
 * Parse an Odin blobdoc array starting at the opening [.
 */
function parseOdinArray(text, start, state) {
  if (!state) state = { inString: false };
  var arr = [];
  var i = start + 1; // skip '['

  while (i < text.length) {
    while (i < text.length && ' \t\n\r'.includes(text[i])) { i++; }
    if (i >= text.length) {
      return { value: arr, end: i, error: 'Unterminated array' };
    }

    if (text[i] === ']') {
      return { value: arr, end: i + 1 };
    }

    if (text[i] === ',') {
      i++;
      continue;
    }

    var valResult = parseOdinValue(text, i, state);
    if (valResult.error) return { value: arr, end: i, error: valResult.error };
    arr.push(valResult.value);
    i = valResult.end;
  }

  return { value: arr, error: 'Unterminated array' };
}

/**
 * Check if position `pos` in `text` is inside a JSON string,
 * scanning from `scanFrom` to `pos`. Used by parseOdinValue to
 * determine initial string state.
 * @private
 */
function _isInsideStringPos(text, scanFrom, pos) {
  var inStr = false;
  for (var i = scanFrom; i < pos && i < text.length; i++) {
    if (text[i] === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inStr = !inStr;
    }
  }
  return inStr;
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
  parseOdinValue,
  parseOdinObject,
  parseOdinArray,
  // Exposed for testing
  _fixOdinReferences,
  _fixTrailingCommas,
  _fixMissingCommas,
  _fixSpecialFloats,
  _fixTypedValues,
};
