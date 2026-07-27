/**
 * v4 Full Roundtrip Test — DFS Comparison of Entire ACL
 *
 * Verifies that the full v4 save pipeline (generateFullAcl) produces
 * correct output by comparing golden vs result across ALL sections:
 * StaticData + RuntimeData + MetaData.
 *
 * Uses DFS (depth-first search) comparison with an allowlist for
 * expected differences. Collects all diffs — does NOT stop at first diff.
 *
 * Usage:
 *   node --require ./tests/integration/preload.cjs tests/integration/test_v4_roundtrip.js --acl <path>
 *   node --require ./tests/integration/preload.cjs tests/integration/test_v4_roundtrip.js --prod-demo
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readAclText, RE_FRAME_SENTINEL } = require('../../src/acl/gatcarc');
const parser = require('../../src/acl/parser');
const { createTokenizer } = require('../../src/acl/tokenizer');
const { buildApproachCache } = require('../../src/acl/approach');

const { loadFlights, generateFullAcl, detectSchemaVersion, _extractConfig } = parser;

// ── CLI ──────────────────────────────────────────────────────────────
const CLI = {
  acl: null,
  root: null,
  prodDemo: false,
  verbose: false,
};

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--acl' && i + 1 < process.argv.length) CLI.acl = path.resolve(process.argv[++i]);
  if (process.argv[i] === '--root' && i + 1 < process.argv.length) CLI.root = path.resolve(process.argv[++i]);
  if (process.argv[i] === '--prod-demo') CLI.prodDemo = true;
  if (process.argv[i] === '--verbose') CLI.verbose = true;
  if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node --require ./tests/integration/preload.cjs tests/integration/test_v4_roundtrip.js [options]');
    console.log('  --acl <path>     Test a specific .acl file');
    console.log('  --prod-demo      Test 8 production + 4 demo .acl files');
    console.log('  --root <path>    Game root directory');
    console.log('  --verbose        Show detailed per-diff output');
    process.exit(0);
  }
}

// ── Path resolution ──────────────────────────────────────────────────
const gameRoot = CLI.root || path.resolve(__dirname, '..', '..', '..', '..');
const dataDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports');
const TEMP_DIR = path.join(__dirname, '_tmp_v4_roundtrip');

// ── Known StaticData entry prefixes (all non-flight-plan are byte-identical) ──
const SD_REBUILT_PREFIXES = new Set(['flight-plan:', 'jetway:']);
const RE_REBUILT_PREFIXES = new Set(['flight-plan:', 'aircraft:', 'aircraft-animator:', 'jetway:']);

/** Check if an entry key matches any prefix in the given set. */
function matchesPrefix(key, prefixSet) {
  if (!key) return false;
  for (const pfx of prefixSet) {
    if (key.startsWith(pfx)) return true;
  }
  return false;
}

// ── 12 prod+demo files ───────────────────────────────────────────────
const PROD_DEMO_FILES = [
  { icao: 'ZSJN', name: 'ZSJN-Morning_120min.acl' },
  { icao: 'ZSJN', name: 'ZSJN_07-10.acl' },
  { icao: 'ZSJN', name: 'ZSJN-Evening_120min.acl' },
  { icao: 'ZSJN', name: 'ZSJN_19-21.acl' },
  { icao: 'KJFK', name: 'KJFK_07-09.acl' },
  { icao: 'KJFK', name: 'KJFK_09-11.acl' },
  { icao: 'KJFK', name: 'KJFK_17-20.acl' },
  { icao: 'KJFK', name: 'KJFK_20-22.acl' },
  { icao: 'ZSJN', name: 'ZSJN-Morning_120min.demo.acl' },
  { icao: 'ZSJN', name: 'ZSJN_07-10.demo.acl' },
  { icao: 'KJFK', name: 'KJFK_09-11.demo.acl' },
  { icao: 'KJFK', name: 'KJFK_20-22.demo.acl' },
];

// ── Discover .acl files ──────────────────────────────────────────────
function discoverFiles() {
  if (CLI.acl) {
    if (!fs.existsSync(CLI.acl)) { console.error('ACL file not found:', CLI.acl); process.exit(1); }
    const d = path.dirname(CLI.acl);
    const icaoMatch = d.match(/[\\/]Airports[\\/]([^\\/]+)/i);
    return [{ icao: icaoMatch ? icaoMatch[1] : '', name: path.basename(CLI.acl), sourcePath: CLI.acl, sourceDir: path.dirname(CLI.acl) }];
  }
  if (CLI.prodDemo) {
    return PROD_DEMO_FILES.map(f => {
      const fp = path.join(dataDir, f.icao, 'Levels', f.name);
      return fs.existsSync(fp) ? { icao: f.icao, name: f.name, sourcePath: fp, sourceDir: path.dirname(fp) } : null;
    }).filter(Boolean);
  }
  // Default: all v4 .acl files (skip .bak, skip Endless)
  const files = [];
  if (!fs.existsSync(dataDir)) { console.error('Airports dir not found:', dataDir); return files; }
  for (const ae of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!ae.isDirectory()) continue;
    const ld = path.join(dataDir, ae.name, 'Levels');
    if (!fs.existsSync(ld)) continue;
    for (const le of fs.readdirSync(ld, { withFileTypes: true })) {
      if (!le.isFile() || !le.name.endsWith('.acl') || le.name.endsWith('.acl.bak')) continue;
      if (le.name.toLowerCase().includes('endless')) continue;
      files.push({ icao: ae.name, name: le.name, sourcePath: path.join(ld, le.name), sourceDir: ld });
    }
  }
  return files;
}

// ═══════════════════════════════════════════════════════════════════════
// PARSING HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse entries from a $rcontent array text (between [ and ]).
 * Returns array of { text, key, prefix } where prefix is the part of key before : or the whole key.
 */
function parseEntries(arrayText) {
  const entries = [];
  // Skip opening [ if present
  let pos = 0;
  if (arrayText[pos] === '[') pos++;
  const len = arrayText.length;

  while (pos < len) {
    // Skip whitespace and commas
    while (pos < len && ' \t\n\r,'.includes(arrayText[pos])) pos++;
    if (pos >= len || arrayText[pos] === ']') break;

    if (arrayText[pos] !== '{') {
      // Thin entry: $iref:N — consume until , or ]
      const start = pos;
      while (pos < len && arrayText[pos] !== ',' && arrayText[pos] !== ']') pos++;
      const text = arrayText.substring(start, pos).trim();
      if (text) entries.push({ text, key: null, prefix: null });
      continue;
    }

    // Full inline entry { "$k": "...", "$v": ... }
    const entryStart = pos;
    let depth = 1;
    pos++;
    while (pos < len && depth > 0) {
      if (arrayText[pos] === '"') {
        pos++;
        while (pos < len && arrayText[pos] !== '"') {
          if (arrayText[pos] === '\\') pos++; // skip escape
          pos++;
        }
        if (pos < len) pos++; // skip closing "
        continue;
      }
      if (arrayText[pos] === '{') depth++;
      else if (arrayText[pos] === '}') depth--;
      pos++;
    }
    const text = arrayText.substring(entryStart, pos);
    const keyMatch = text.match(/"\$k":\s*"([^"]+)"/);
    const key = keyMatch ? keyMatch[1] : null;
    // Extract prefix including colon (e.g., "flight-plan:", "jetway:", "aircraft:")
    let prefix = null;
    if (key) {
      const colonIdx = key.indexOf(':');
      prefix = colonIdx >= 0 ? key.substring(0, colonIdx + 1) : null;
    }
    entries.push({ text, key, prefix });
  }
  return entries;
}

/**
 * Extract the _flightDirection value from an aircraft entry's $v text.
 * Returns 1 (ARR), 0 (DEP), or null (not found / not an aircraft entry).
 */
function extractFlightDirection(vText) {
  const valText = getValueText(vText, '_flightDirection');
  if (!valText) return null;
  if (valText.startsWith('$iref:')) return null; // thin ref, can't determine
  if (!valText.startsWith('{')) return null;
  // Find the inner value (after $id and $type)
  const inner = createTokenizer(valText);
  // The inner value is either $iref:N or { "$type": N, <value> }
  // Walk past $id and $type, the next value is the direction
  const keys = inner.getTopLevelKeys(0, valText.length);
  // Keys are: $id, $type, then the value. We need the value after $type.
  // For a typed wrapper: { "$id": N, "$type": N, <value> }
  let depth = 0, inStr = false, afterType = false;
  for (let i = 1; i < valText.length - 1; i++) {
    const c = valText[i];
    if (c === '"' && valText[i - 1] !== '\\') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    if (depth === 0 && c === ',') {
      // Check if we just passed $type
      if (!afterType) {
        const before = valText.substring(0, i);
        if (before.includes('"$type"')) afterType = true;
      }
      if (afterType) {
        // The next non-whitespace char is the value
        let j = i + 1;
        while (j < valText.length && ' \t\n\r'.includes(valText[j])) j++;
        const v = valText.substring(j).trim();
        if (v.endsWith('}')) {
          const num = parseInt(v.substring(0, v.length - 1).trim(), 10);
          if (!isNaN(num)) return num;
        }
        break;
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// DFS COMPARISON
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check if a field path matches a skip allowlist rule.
 *   S1: **.$id — all $id fields
 *   S2: $rcontent.singleton:event-log.* — entire singleton:event-log entry
 *   S3: aircraft:*._position when isArrival
 *   S4: aircraft:*._direction when isArrival
 *   S5: **._waitingForCommands
 *   S6: **._receivedEvents
 */
function isAllowedSkip(fieldPath, isArrival) {
  const field = fieldPath.split('.').pop();

  // S1: all $id fields
  if (field === '$id') return true;

  // S2: singleton:event-log entries (skip entire entry)
  if (fieldPath.includes('singleton:event-log')) return true;

  // S3-S4: ARR aircraft position/direction
  if (isArrival && (field === '_position' || field === '_direction')) return true;

  // S5-S6
  if (field === '_waitingForCommands' || field === '_receivedEvents') return true;
  if (field === 'Guid' || field === 'Enabled') return true;

  return false;
}

/**
 * Check if a field path matches a time-tolerance rule.
 */
function isTimeField(fieldPath) {
  const field = fieldPath.split('.').pop();
  if (!field) return false;
  // T1-T4: named time fields
  if (field === 'OffBlockTime' || field === 'LandingTime' || field === 'TakeoffTime' || field === 'InBlockTime') return true;
  // T5: any field ending in "Time"
  if (field.endsWith('Time')) return true;
  return false;
}

/**
 * Parse a time value and return seconds since midnight.
 * Handles HH:MM:SS strings and DateTime ticks (100-ns intervals).
 */
function timeToSeconds(valText) {
  if (!valText) return null;
  const s = valText.trim();
  // HH:MM:SS
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) {
    const p = s.split(':');
    return +p[0] * 3600 + +p[1] * 60 + +p[2];
  }
  // HH:MM
  if (/^\d{2}:\d{2}$/.test(s)) {
    const p = s.split(':');
    return +p[0] * 3600 + +p[1] * 60;
  }
  // DateTime ticks (numeric, possibly negative)
  if (/^-?\d+$/.test(s)) {
    return Math.round(parseInt(s, 10) / 10000000);
  }
  return null;
}

/**
 * Compare two time values with ±60 second tolerance.
 * Returns null if they match within tolerance, or a diff message.
 */
function compareTimeValue(gValText, rValText) {
  const gSec = timeToSeconds(gValText);
  const rSec = timeToSeconds(rValText);
  if (gSec === null || rSec === null) {
    // Can't parse — fall back to exact comparison
    if (gValText !== rValText) return `time: "${gValText}" vs "${rValText}"`;
    return null;
  }
  if (Math.abs(gSec - rSec) <= 60) return null;
  return `time diff: ${gValText} (${gSec}s) vs ${rValText} (${rSec}s) — Δ${Math.abs(gSec - rSec)}s`;
}

/**
 * Get the raw value text for a key at depth 1.
 * Uses string-aware scanning (like getTopLevelKeys) that correctly
 * identifies quoted JSON keys followed by ':'.
 */
function getValueText(objText, key) {
  const searchKey = '"' + key + '"';
  let depth = 0, inString = false;
  for (let i = 0; i < objText.length; i++) {
    const c = objText[i];
    if (c === '"' && (i === 0 || objText[i - 1] !== '\\')) {
      inString = !inString;
      if (inString && depth === 1) {
        // Entering a string at depth 1 — could be a key
        if (objText.substring(i, i + searchKey.length) === searchKey) {
          const keyEnd = i + searchKey.length; // position after closing "
          let j = keyEnd;
          while (j < objText.length && ' \t\n\r'.includes(objText[j])) j++;
          if (j < objText.length && objText[j] === ':') {
            // Found key — extract value
            let valStart = j + 1;
            while (valStart < objText.length && ' \t\n\r'.includes(objText[valStart])) valStart++;
            // Determine value end
            let valEnd;
            const vt = objText[valStart];
            if (vt === '{') {
              // Find matching } via brace depth (string-aware)
              let bd = 1, bs = false, p = valStart + 1;
              while (p < objText.length && bd > 0) {
                const pc = objText[p];
                if (pc === '"' && objText[p - 1] !== '\\') bs = !bs;
                else if (!bs) { if (pc === '{') bd++; else if (pc === '}') bd--; }
                p++;
              }
              valEnd = p;
            } else if (vt === '"') {
              let p = valStart + 1;
              while (p < objText.length && objText[p] !== '"') { if (objText[p] === '\\') p++; p++; }
              valEnd = p + 1;
            } else if (vt === '[') {
              let bd = 1, bs = false, p = valStart + 1;
              while (p < objText.length && bd > 0) {
                const pc = objText[p];
                if (pc === '"' && objText[p - 1] !== '\\') bs = !bs;
                else if (!bs) { if (pc === '[') bd++; else if (pc === ']') bd--; }
                p++;
              }
              valEnd = p;
            } else {
              // number, boolean, null, $iref, $fstrref
              valEnd = valStart;
              while (valEnd < objText.length && !',\r\n\t }]'.includes(objText[valEnd])) valEnd++;
            }
            return objText.substring(valStart, valEnd);
          }
        }
      }
      continue;
    }
    if (inString) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return null;
}

/**
 * Check if a value text represents an object (starts with {).
 */
function isObjectValue(valText) {
  return valText.trimStart().startsWith('{');
}

/**
 * Check if a value text represents an array (starts with [).
 */
function isArrayValue(valText) {
  return valText.trimStart().startsWith('[');
}

/**
 * Check if a value text is an $iref reference.
 */
function isIrefValue(valText) {
  return valText.trimStart().startsWith('$iref:');
}

/**
 * Check if a value text is an $fstrref reference.
 */
function isFstrrefValue(valText) {
  return valText.trimStart().startsWith('$fstrref:');
}

/**
 * Recursive DFS comparison of two Odin JSON-like values.
 *
 * @param {string} gText - golden value text
 * @param {string} rText - result value text
 * @param {string} path - current comparison path (e.g. "aircraft:B-1234._position")
 * @param {boolean|null} isArrival - whether the enclosing aircraft is ARR (null if N/A)
 * @returns {string[]} array of diff messages
 */
function dfsCompare(gText, rText, path, isArrival, dfsStats) {
  const diffs = [];

  const gRaw = gText.trim();
  const rRaw = rText.trim();

  // Both are $iref references
  if (isIrefValue(gRaw) && isIrefValue(rRaw)) {
    if (dfsStats) dfsStats.fieldsCompared++;
    return diffs; // both are $iref — ignore the number
  }

  // Both are $fstrref references
  if (isFstrrefValue(gRaw) && isFstrrefValue(rRaw)) {
    if (dfsStats) dfsStats.fieldsCompared++;
    if (gRaw !== rRaw) {
      diffs.push(`${path}: $fstrref mismatch — "${gRaw}" vs "${rRaw}"`);
    }
    return diffs;
  }

  // One is $iref, other is not — allow for rebuilt fields (_flightPlan, DynamicsParams, etc.)
  if (isIrefValue(gRaw) !== isIrefValue(rRaw)) {
    // Allow $iref vs inline for fields that get rebuilt differently
    const field = path.split('.').pop();
    if (field === '_flightPlan' || field === 'DynamicsParams' || field === 'TaxiArrivalToHoldingPointPath') {
      if (dfsStats) dfsStats.fieldsSkipped++;
      return diffs;
    }
    diffs.push(`${path}: type mismatch — ${isIrefValue(gRaw) ? '$iref' : 'inline'} vs ${isIrefValue(rRaw) ? '$iref' : 'inline'}`);
    return diffs;
  }

  // Both are objects — recurse
  if (isObjectValue(gRaw) && isObjectValue(rRaw)) {
    return dfsCompareObject(gText, rText, path, isArrival, dfsStats);
  }

  // Both are arrays — compare element-by-element
  if (isArrayValue(gRaw) && isArrayValue(rRaw)) {
    return dfsCompareArray(gText, rText, path, isArrival, dfsStats);
  }

  // One is object, other is not
  if (isObjectValue(gRaw) !== isObjectValue(rRaw)) {
    diffs.push(`${path}: value type mismatch (object vs non-object)`);
    return diffs;
  }

  // Time field — compare with tolerance
  if (isTimeField(path)) {
    if (dfsStats) dfsStats.fieldsCompared++;
    const timeDiff = compareTimeValue(gRaw, rRaw);
    if (timeDiff) diffs.push(`${path}: ${timeDiff}`);
    return diffs;
  }

  // Primitives — exact comparison
  if (dfsStats) dfsStats.fieldsCompared++;
  // Normalize $type values: bare "N" and qualified "N|TypeName, Assembly" are equivalent
  const gNorm = normalizeTypeValue(gRaw);
  const rNorm = normalizeTypeValue(rRaw);
  if (gNorm !== rNorm) {
    diffs.push(`${path}: "${gRaw}" vs "${rRaw}"`);
  }
  return diffs;
}

/**
 * DFS comparison of two object values.
 */
function dfsCompareObject(gObjText, rObjText, path, isArrival, dfsStats) {
  const diffs = [];
  const gTok = createTokenizer(gObjText);
  const rTok = createTokenizer(rObjText);

  const gKeys = gTok.getTopLevelKeys(0, gObjText.length);
  const rKeys = rTok.getTopLevelKeys(0, rObjText.length);

  const processedRKeys = new Set();

  for (const key of gKeys) {
    const fieldPath = path + '.' + key;

    // Check skip rules
    if (isAllowedSkip(fieldPath, isArrival)) { if (dfsStats) dfsStats.fieldsSkipped++; continue; }

    if (!rKeys.includes(key)) {
      diffs.push(`${fieldPath}: key present in golden but missing in result`);
      continue;
    }
    processedRKeys.add(key);

    // Get values
    const gVal = getValueText(gObjText, key);
    const rVal = getValueText(rObjText, key);

    if (gVal === null || rVal === null) {
      diffs.push(`${fieldPath}: cannot extract value`);
      continue;
    }

    // Check if this key tells us about arrival status
    let childIsArrival = isArrival;
    if (key === '_flightDirection') {
      const fd = extractFlightDirectionValue(gVal);
      if (fd !== null) childIsArrival = (fd === 1);
      // Don't propagate arrival status down — only set for current context
      // Actually, _flightDirection tells us about the aircraft, so propagate
    }

    // Recurse
    const childDiffs = dfsCompare(gVal, rVal, fieldPath, childIsArrival, dfsStats);
    diffs.push(...childDiffs);
  }

  // Check for extra keys in result
  for (const key of rKeys) {
    if (!gKeys.includes(key)) {
      const fieldPath = path + '.' + key;
      if (!isAllowedSkip(fieldPath, isArrival)) {
        diffs.push(`${fieldPath}: extra key in result (not in golden)`);
      }
    }
  }

  return diffs;
}

/**
 * Extract _flightDirection numeric value from a value text.
 */
function extractFlightDirectionValue(valText) {
  const s = valText.trim();
  if (isIrefValue(s)) return null; // thin ref
  if (!isObjectValue(s)) return null;
  // Walk into the object to find the inner value
  const innerT = createTokenizer(s);
  const keys = innerT.getTopLevelKeys(0, s.length);
  // For { "$id": N, "$type": N, <value> }, the last non-$id non-$type entry is the value
  // Or it could be just a bare value without $type wrapper
  // Strategy: find the key that is NOT $id and NOT $type
  // But in a typed wrapper like { "$id": N, "$type": N, 1 }, the "keys" are $id, $type
  // and the value 1 is KEYLESS. We need a different approach.
  // For { "$id": N, "$type": N, <rawValue> }, getTopLevelKeys returns ['$id', '$type']
  // and the raw value is after the second comma.
  // Let's find it by scanning.

  let depth = 0, inStr = false;
  let commaCount = 0;
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== '\\') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    if (depth === 0 && c === ',') commaCount++;
  }
  if (commaCount >= 2) {
    // Find position after 2nd comma
    depth = 0; inStr = false; commaCount = 0;
    for (let i = 1; i < s.length - 1; i++) {
      const c = s[i];
      if (c === '"' && s[i - 1] !== '\\') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      if (depth === 0 && c === ',') {
        commaCount++;
        if (commaCount === 2) {
          let j = i + 1;
          while (j < s.length && ' \t\n\r'.includes(s[j])) j++;
          const innerVal = s.substring(j, s.length - 1).trim();
          const num = parseInt(innerVal, 10);
          if (!isNaN(num)) return num;
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Normalize $type values: bare "N" and qualified "N|TypeName" are equivalent.
 */
function normalizeTypeValue(val) {
  let s = val.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.substring(1, s.length - 1);
  }
  const pipeIdx = s.indexOf("|");
  if (pipeIdx >= 0) s = s.substring(0, pipeIdx);
  return s;
}

/**
 * Simple array comparison — compare element by element recursively.
 */
function dfsCompareArray(gArrText, rArrText, path, isArrival, dfsStats) {
  const diffs = [];
  // Parse array elements
  const gElements = parseArrayElements(gArrText);
  const rElements = parseArrayElements(rArrText);

  const maxLen = Math.max(gElements.length, rElements.length);
  for (let i = 0; i < maxLen; i++) {
    const elemPath = path + '[' + i + ']';
    if (i >= gElements.length) {
      diffs.push(`${elemPath}: extra element in result`);
      continue;
    }
    if (i >= rElements.length) {
      diffs.push(`${elemPath}: missing element in result`);
      continue;
    }
    const childDiffs = dfsCompare(gElements[i], rElements[i], elemPath, isArrival, dfsStats);
    diffs.push(...childDiffs);
  }
  return diffs;
}

/**
 * Parse top-level elements from an array text (string-aware brace matching).
 */
function parseArrayElements(arrText) {
  const elements = [];
  const inner = arrText.trim();
  if (!inner.startsWith('[')) return elements;
  let pos = 1;
  const len = inner.length;
  while (pos < len) {
    while (pos < len && ' \t\n\r,'.includes(inner[pos])) pos++;
    if (pos >= len || inner[pos] === ']') break;
    const start = pos;
    if (inner[pos] === '{') {
      let depth = 1, inStr = false;
      pos++;
      while (pos < len && depth > 0) {
        const c = inner[pos];
        if (c === '"' && inner[pos - 1] !== '\\') { inStr = !inStr; }
        else if (!inStr) {
          if (c === '{') depth++;
          else if (c === '}') depth--;
        }
        pos++;
      }
    } else if (inner[pos] === '"') {
      pos++;
      while (pos < len && inner[pos] !== '"') {
        if (inner[pos] === '\\') pos++;
        pos++;
      }
      if (pos < len) pos++;
    } else if (inner[pos] === '[') {
      let depth = 1, inStr = false;
      pos++;
      while (pos < len && depth > 0) {
        const c = inner[pos];
        if (c === '"' && inner[pos - 1] !== '\\') { inStr = !inStr; }
        else if (!inStr) {
          if (c === '[') depth++;
          else if (c === ']') depth--;
        }
        pos++;
      }
    } else if (inner.startsWith('$iref:', pos) || inner.startsWith('$fstrref:', pos)) {
      while (pos < len && inner[pos] !== ',' && inner[pos] !== ']') pos++;
    } else {
      // number, boolean, null
      while (pos < len && inner[pos] !== ',' && inner[pos] !== ']') pos++;
    }
    elements.push(inner.substring(start, pos).trim());
  }
  return elements;
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION COMPARISON
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find the text of a top-level section in the ACL text.
 */
function findSectionText(fullText, sectionName) {
  const t = createTokenizer(fullText);
  const sec = t.findSection(sectionName);
  if (!sec) return null;
  return fullText.substring(sec.valueStart, sec.valueEnd);
}

/**
 * Compare the entries of a $rcontent array between golden and result.
 *
 * @param {string} gRcText - golden $rcontent array text (including [ ])
 * @param {string} rRcText - result $rcontent array text (including [ ])
 * @param {Set} rebuiltPrefixes - set of entry prefixes that are rebuilt (need DFS)
 * @param {string} contextLabel - for diff messages
 * @param {Map} resultRegs - set of REGs present in the result (for dropped-flight detection)
 * @returns {string[]} diffs
 */
function compareREntries(gRcText, rRcText, rebuiltPrefixes, contextLabel, resultRegs, allGoldenKeys) {
  const diffs = [];
  const stats = { total: 0, rebuiltDFS: 0, rebuiltThin: 0, rebuiltMissing: 0, rebuiltExtra: 0, byteIdentical: 0, byteIdenticalPassed: 0, byteIdenticalFailed: 0, skippedEventLog: 0 };

  const gEntries = parseEntries(gRcText);
  const rEntries = parseEntries(rRcText);

  // Build key-based maps (for entries with keys) and thin-entry lists (for entries without keys)
  const gKeyMap = new Map();  // key → entry
  const rKeyMap = new Map();  // key → entry
  const gThins = [];          // entries with no key (thin $iref)
  const rThins = [];          // entries with no key (thin $iref)

  for (const e of gEntries) {
    if (e.key) gKeyMap.set(e.key, e);
    else gThins.push(e);
  }
  for (const e of rEntries) {
    if (e.key) rKeyMap.set(e.key, e);
    else rThins.push(e);
  }

  if (CLI.verbose) {
    console.log(`  [${contextLabel}] golden: ${gKeyMap.size} keyed + ${gThins.length} thin = ${gEntries.length} entries`);
    console.log(`  [${contextLabel}] result: ${rKeyMap.size} keyed + ${rThins.length} thin = ${rEntries.length} entries`);
  }

  // ── Compare entries with keys (key-based matching) ──────────
  const processedRKeys = new Set();

  for (const [key, gEntry] of gKeyMap) {
    stats.total++;
    // Skip singleton:event-log
    if (key === 'singleton:event-log') { stats.skippedEventLog++; continue; }

    const rEntry = rKeyMap.get(key);
    if (!rEntry) {
      // Allow: rebuilt entries for valid flights that may be redistributed
      const rebuiltRegMatch2 = key.match(/^(?:flight-plan|aircraft|aircraft-animator:aircraft):(.+)$/);
      if (rebuiltRegMatch2 && resultRegs && resultRegs.has(rebuiltRegMatch2[1])) {
        stats.rebuiltMissing++;
        continue;
      }
      diffs.push(`${contextLabel}["${key}"]: key present in golden but missing in result`);
      continue;
    }
    processedRKeys.add(key);

    const isRebuilt = matchesPrefix(key, rebuiltPrefixes);

    if (isRebuilt) {
      const gV = extractVValue(gEntry.text);
      const rV = extractVValue(rEntry.text);

      if (gV && rV) {
        // Both inline — DFS compare
        stats.rebuiltDFS++;
        const keyIsAircraft = key.startsWith('aircraft:') && !key.startsWith('aircraft-animator:');
        let isArrival = null;
        if (keyIsAircraft) {
          const fd = extractFlightDirection(gV);
          if (fd === 1) isArrival = true;
          else if (fd === 0) isArrival = false;
        }
        const dfsStats = { fieldsCompared: 0, fieldsSkipped: 0 };
        const entryPath = `${contextLabel}["${key}"]`;
        const childDiffs = dfsCompare(gV, rV, entryPath, isArrival, dfsStats);
        diffs.push(...childDiffs);
        if (CLI.verbose && childDiffs.length === 0) {
          const arrivalNote = isArrival === true ? ' ARR' : isArrival === false ? ' DEP' : '';
          console.log(`    ${key}: DFS compared ${dfsStats.fieldsCompared} fields, skipped ${dfsStats.fieldsSkipped}${arrivalNote} — OK`);
        }
      } else if (gV && !rV) {
        // golden inline, result thin $iref — DEP moved to jetway
        stats.rebuiltThin++;
        if (CLI.verbose) console.log(`    ${key}: inline→thin $iref (jetway) — OK`);
      } else if (!gV && rV) {
        // golden thin $iref, result inline — new standalone
        stats.rebuiltThin++;
        if (CLI.verbose) console.log(`    ${key}: thin $iref→inline — OK`);
      } else {
        // Both thin $iref
        stats.rebuiltThin++;
      }
    } else {
      // Byte-identical comparison
      stats.byteIdentical++;
      const gVText = extractVValueRaw(gEntry.text);
      const rVText = extractVValueRaw(rEntry.text);
      if (gVText !== rVText) {
        stats.byteIdenticalFailed++;
        diffs.push(`${contextLabel}["${key}"]: non-rebuilt entry $v differs (${gVText.length} vs ${rVText.length} chars)`);
        if (CLI.verbose) {
          diffs.push(`  golden: ${gVText.substring(0, 300)}`);
          diffs.push(`  result: ${rVText.substring(0, 300)}`);
        }
      } else {
        stats.byteIdenticalPassed++;
      }
    }
  }

  // Check for extra keys in result
  for (const [key] of rKeyMap) {
    if (key === 'singleton:event-log') continue;
    if (!gKeyMap.has(key)) {
      if (allGoldenKeys && allGoldenKeys.has(key)) continue;
      const rebuiltRegMatch = key.match(/^(?:flight-plan|aircraft|aircraft-animator:aircraft):(.+)$/);
      if (rebuiltRegMatch && resultRegs && resultRegs.has(rebuiltRegMatch[1])) {
        stats.rebuiltExtra++;
        continue;
      }
      diffs.push(`${contextLabel}["${key}"]: extra key in result (not in golden)`);
    }
  }

  // Thin entries
  if (gThins.length !== rThins.length) {
    diffs.push(`${contextLabel}: thin ($iref) entry count changed: ${gThins.length} → ${rThins.length}`);
  }

  // Log stats
  if (CLI.verbose) {
    const parts = [];
    if (stats.byteIdentical > 0) parts.push(`${stats.byteIdentical} byte-identical (${stats.byteIdenticalPassed}✓ ${stats.byteIdenticalFailed}✗)`);
    if (stats.rebuiltDFS > 0) parts.push(`${stats.rebuiltDFS} rebuilt-DFS`);
    if (stats.rebuiltThin > 0) parts.push(`${stats.rebuiltThin} rebuilt-thin`);
    if (stats.rebuiltMissing > 0) parts.push(`${stats.rebuiltMissing} rebuilt-missing(OK)`);
    if (stats.rebuiltExtra > 0) parts.push(`${stats.rebuiltExtra} rebuilt-extra(OK)`);
    if (stats.skippedEventLog > 0) parts.push(`${stats.skippedEventLog} event-log(skipped)`);
    console.log(`  [${contextLabel}] SUMMARY: ${parts.join(', ')}`);
  }

  return diffs;
}

/**
 * Extract the $v value text from an entry like {"$k": "...", "$v": ...}.
 * Returns the value text (after "$v":) or null.
 */
function extractVValue(entryText) {
  const vText = getValueText(entryText, '$v');
  if (!vText) return null;
  // Check if it's an object (not thin $iref)
  if (vText.trimStart().startsWith('{')) return vText;
  return null; // thin $iref — no DFS needed
}

/**
 * Extract the raw $v value text (including thin $iref).
 */
function extractVValueRaw(entryText) {
  return getValueText(entryText, '$v') || '';
}

// ═══════════════════════════════════════════════════════════════════════
// FILE-LEVEL OPERATIONS
// ═══════════════════════════════════════════════════════════════════════

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf-8').digest('hex');
}

function cleanTemp() {
  if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

function copyLevelFiles(sourceAclPath, sourceDir, destDir, destName) {
  const destAcl = path.join(destDir, destName);
  fs.copyFileSync(sourceAclPath, destAcl);

  const baseName = path.basename(sourceAclPath, '.acl');
  const jsonPatterns = ['weather_timeline.json', 'wind_timeline.json', `runway_timeline_${baseName}.json`];
  for (const p of jsonPatterns) {
    const src = path.join(sourceDir, p);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, p));
  }

  // For .demo.acl, also copy the parent .acl
  if (destName.endsWith('.demo.acl')) {
    const parentName = destName.replace('.demo.acl', '.acl');
    const parentSrc = path.join(sourceDir, parentName);
    if (fs.existsSync(parentSrc)) fs.copyFileSync(parentSrc, path.join(destDir, parentName));
  }

  return destAcl;
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH CACHE
// ═══════════════════════════════════════════════════════════════════════

const approachCacheByIcao = {};

function getApproachCache(icao, sourceDir) {
  if (approachCacheByIcao[icao]) return approachCacheByIcao[icao];
  try {
    if (fs.existsSync(sourceDir)) {
      const cache = buildApproachCache(sourceDir);
      approachCacheByIcao[icao] = cache;
      return cache;
    }
  } catch (_) {}
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

cleanTemp();
fs.mkdirSync(TEMP_DIR, { recursive: true });

const aclFiles = discoverFiles();
console.log(`\nFound ${aclFiles.length} .acl file(s)\n`);

const report = {
  gameRoot,
  startedAt: new Date().toISOString(),
  files: [],
  summary: { total: aclFiles.length, passed: 0, failed: 0, errored: 0, skipped: 0 },
};

for (const file of aclFiles) {
  const label = `${file.icao}/${file.name}`;
  const fileReport = { label, status: 'pending', diffs: [], error: null, metrics: {} };
  const fileTempDir = path.join(TEMP_DIR, file.icao);
  fs.mkdirSync(fileTempDir, { recursive: true });

  try {
    // ── Step 1: Decode golden text ─────────────────────────────────
    const goldenText = readAclText(file.sourcePath);
    const isV4 = detectSchemaVersion(goldenText) === 4;

    if (!isV4) {
      fileReport.status = 'skipped';
      fileReport.skipReason = 'Not a v4 file';
      report.summary.skipped++;
      report.files.push(fileReport);
      console.log(`  ~ ${label} — not v4, skipped`);
      continue;
    }

    // ── Step 2: Load flights ──────────────────────────────────────
    const goldenLoaded = loadFlights(file.sourcePath);
    if (!goldenLoaded || !goldenLoaded.flights.length) {
      fileReport.status = 'skipped';
      fileReport.skipReason = 'No flight data';
      report.summary.skipped++;
      report.files.push(fileReport);
      console.log(`  ~ ${label} — no flights, skipped`);
      continue;
    }

    const goldenFlights = goldenLoaded.flights;
    const approachCache = getApproachCache(file.icao, file.sourceDir);
    const goldenCfg = _extractConfig(goldenText) || {};

    fileReport.metrics = {
      flights: goldenFlights.length,
      approachCacheBuilt: approachCache !== null,
      goldenSize: Buffer.byteLength(goldenText, 'utf-8'),
    };

    // ── Step 3: Copy to temp, run generateFullAcl ─────────────────
    const goldenAcl = copyLevelFiles(file.sourcePath, file.sourceDir, fileTempDir, file.name);

    generateFullAcl(
      goldenAcl,
      goldenFlights,
      '', '', [],
      goldenLoaded.worldStateData,
      goldenLoaded.sceneryMaps,
      goldenLoaded._fromWorldState,
      goldenLoaded._fromFlightPlans,
      approachCache,
      goldenCfg.startTime || null,
      null,
      isV4
    );

    // ── Step 4: Read result ───────────────────────────────────────
    const resultText = readAclText(goldenAcl);
    const resultLoaded = loadFlights(goldenAcl);
    const resultFlights = resultLoaded ? resultLoaded.flights : [];

    fileReport.metrics.resultSize = Buffer.byteLength(resultText, 'utf-8');
    fileReport.metrics.sizeDelta = fileReport.metrics.resultSize - fileReport.metrics.goldenSize;

    // Build result REGs set (for dropped-flight detection)
    const resultRegs = new Set();
    for (const f of resultFlights) {
      const reg = f._Registration || f.Registration || '';
      if (reg) resultRegs.add(reg);
    }

    // ── Step 5: MD5 assertion ────────────────────────────────────
    const goldenMD5 = md5(goldenText);
    const resultMD5 = md5(resultText);
    fileReport.metrics.goldenMD5 = goldenMD5;
    fileReport.metrics.resultMD5 = resultMD5;

    if (goldenMD5 === resultMD5) {
      fileReport.diffs.push('MD5: golden === result — file was NOT regenerated!');
    }

    // ── Step 6: Collect all golden keys (cross-frame reference set) ──
    const allGoldenKeys = new Set();
    {
      // From StaticData
      const gSD = createTokenizer(goldenText).findSection('StaticData');
      if (gSD) {
        const gSDText = goldenText.substring(gSD.valueStart, gSD.valueEnd);
        const gBD = createTokenizer(gSDText).findSection('$blobdoc');
        if (gBD) {
          const gBDText = gSDText.substring(gBD.valueStart, gBD.valueEnd);
          const gSI = createTokenizer(gBDText).findSection('StaticItems');
          if (gSI) {
            const gSIText = gBDText.substring(gSI.valueStart, gSI.valueEnd);
            const gRC = createTokenizer(gSIText).findSection('$rcontent');
            if (gRC) {
              const gRcText = gSIText.substring(gRC.valueStart, gRC.valueEnd);
              for (const e of parseEntries(gRcText)) {
                if (e.key) allGoldenKeys.add(e.key);
              }
            }
          }
        }
      }
      // From RuntimeData frames
      const gFrames = goldenText.split(RE_FRAME_SENTINEL);
      for (let fi = 0; fi < gFrames.length; fi++) {
        const gRT = findRuntimeEntities(gFrames[fi]);
        if (!gRT) continue;
        const gRC = createTokenizer(gRT).findSection('$rcontent');
        if (!gRC) continue;
        const gRcText = gRT.substring(gRC.valueStart, gRC.valueEnd);
        for (const e of parseEntries(gRcText)) {
          if (e.key) allGoldenKeys.add(e.key);
        }
      }
    }

    // ── Step 7: Compare StaticData entries ────────────────────────
    const staticDiffs = compareStaticData(goldenText, resultText, resultRegs, allGoldenKeys);
    fileReport.diffs.push(...staticDiffs);

    // ── Step 8: Compare RuntimeData frame entries ─────────────────
    const runtimeDiffs = compareRuntimeData(goldenText, resultText, resultRegs, allGoldenKeys);
    fileReport.diffs.push(...runtimeDiffs);

    // ── Step 9: Compare all other top-level sections ──────────────
    const sectionDiffs = compareOtherSections(goldenText, resultText);
    fileReport.diffs.push(...sectionDiffs);

    // ── Report ────────────────────────────────────────────────────
    if (fileReport.diffs.length === 0) {
      fileReport.status = 'passed';
      report.summary.passed++;
      const md5Note = goldenMD5 !== resultMD5 ? ' (regenerated)' : '';
      console.log(`  ✓ ${label} — 0 diffs${md5Note}`);
    } else {
      fileReport.status = 'failed';
      report.summary.failed++;
      console.log(`  ✗ ${label} — ${fileReport.diffs.length} diffs`);
      fileReport.diffs.slice(0, 30).forEach(d => console.log(`      ${d}`));
      if (fileReport.diffs.length > 30) console.log(`      ... and ${fileReport.diffs.length - 30} more`);
    }

  } catch (e) {
    fileReport.status = 'errored';
    fileReport.error = e.message;
    report.summary.errored++;
    console.log(`  💥 ${label} — ERROR: ${e.message}`);
    if (CLI.verbose) console.error(e.stack);
  }

  report.files.push(fileReport);

  // Clean up per-file temp dir
  try { fs.rmSync(fileTempDir, { recursive: true, force: true }); } catch (_) {}
}

// ── Cleanup ───────────────────────────────────────────────────────────
cleanTemp();

// ── Write JSON report ─────────────────────────────────────────────────
const REPORT_DIR = path.join(__dirname, '..', '_reports_');
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
report.completedAt = new Date().toISOString();
const reportName = `v4-roundtrip-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const reportPath = path.join(REPORT_DIR, reportName);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`  Total:   ${report.summary.total}`);
console.log(`  Passed:  ${report.summary.passed}`);
console.log(`  Failed:  ${report.summary.failed}`);
console.log(`  Errored: ${report.summary.errored}`);
console.log(`  Skipped: ${report.summary.skipped}`);
console.log(`  Report:  ${reportPath}`);
console.log(`${'═'.repeat(60)}\n`);

// ═══════════════════════════════════════════════════════════════════════
// SECTION COMPARISON FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compare StaticData entries between golden and result.
 */
function compareStaticData(goldenText, resultText, resultRegs, allGoldenKeys) {
  const diffs = [];

  // Navigate to StaticData.$blobdoc.StaticItems.$rcontent
  const gSD = createTokenizer(goldenText).findSection('StaticData');
  const rSD = createTokenizer(resultText).findSection('StaticData');
  if (!gSD || !rSD) {
    if (gSD || rSD) diffs.push('StaticData: missing in one side');
    return diffs;
  }

  const gSDText = goldenText.substring(gSD.valueStart, gSD.valueEnd);
  const rSDText = resultText.substring(rSD.valueStart, rSD.valueEnd);

  const gBD = createTokenizer(gSDText).findSection('$blobdoc');
  const rBD = createTokenizer(rSDText).findSection('$blobdoc');
  if (!gBD || !rBD) {
    if (gBD || rBD) diffs.push('StaticData.$blobdoc: missing in one side');
    return diffs;
  }

  const gBDText = gSDText.substring(gBD.valueStart, gBD.valueEnd);
  const rBDText = rSDText.substring(rBD.valueStart, rBD.valueEnd);

  const gSI = createTokenizer(gBDText).findSection('StaticItems');
  const rSI = createTokenizer(rBDText).findSection('StaticItems');
  if (!gSI || !rSI) {
    if (gSI || rSI) diffs.push('StaticData.$blobdoc.StaticItems: missing in one side');
    return diffs;
  }

  const gSIText = gBDText.substring(gSI.valueStart, gSI.valueEnd);
  const rSIText = rBDText.substring(rSI.valueStart, rSI.valueEnd);

  const gRC = createTokenizer(gSIText).findSection('$rcontent');
  const rRC = createTokenizer(rSIText).findSection('$rcontent');
  if (!gRC || !rRC) {
    if (gRC || rRC) diffs.push('StaticData.$blobdoc.StaticItems.$rcontent: missing in one side');
    return diffs;
  }

  const gRcText = gSIText.substring(gRC.valueStart, gRC.valueEnd);
  const rRcText = rSIText.substring(rRC.valueStart, rRC.valueEnd);

  diffs.push(...compareREntries(gRcText, rRcText, SD_REBUILT_PREFIXES, 'StaticData', resultRegs, allGoldenKeys));

  return diffs;
}

/**
 * Compare RuntimeData frame entries between golden and result.
 */
function compareRuntimeData(goldenText, resultText, resultRegs, allGoldenKeys) {
  const diffs = [];

  const gFrames = goldenText.split(RE_FRAME_SENTINEL);
  const rFrames = resultText.split(RE_FRAME_SENTINEL);

  if (gFrames.length !== rFrames.length) {
    diffs.push(`RuntimeData: frame count ${gFrames.length} → ${rFrames.length}`);
    return diffs;
  }

  for (let fi = 0; fi < gFrames.length; fi++) {
    const frameDiffs = compareFrameRuntimeEntities(gFrames[fi], rFrames[fi], fi, resultRegs, allGoldenKeys);
    diffs.push(...frameDiffs);
  }

  return diffs;
}

/**
 * Compare RuntimeEntities from a single frame segment.
 */
function compareFrameRuntimeEntities(gSeg, rSeg, fi, resultRegs, allGoldenKeys) {
  const diffs = [];

  // Navigate to RuntimeData.$blobdoc[fi].RuntimeEntities.$rcontent
  // The frame segment may have RuntimeData wrapping or be the blobdoc value directly
  const gRT = findRuntimeEntities(gSeg);
  const rRT = findRuntimeEntities(rSeg);

  if (!gRT && !rRT) return diffs; // no RuntimeEntities in this segment
  if (!gRT || !rRT) {
    diffs.push(`Frame ${fi}: RuntimeEntities missing in one side`);
    return diffs;
  }

  // Find $rcontent
  const gRC = createTokenizer(gRT).findSection('$rcontent');
  const rRC = createTokenizer(rRT).findSection('$rcontent');
  if (!gRC || !rRC) {
    if (gRC || rRC) diffs.push(`Frame ${fi}: RuntimeEntities.$rcontent missing in one side`);
    return diffs;
  }

  const gRcText = gRT.substring(gRC.valueStart, gRC.valueEnd);
  const rRcText = rRT.substring(rRC.valueStart, rRC.valueEnd);

  diffs.push(...compareREntries(gRcText, rRcText, RE_REBUILT_PREFIXES, `Frame${fi}`, resultRegs, allGoldenKeys));

  return diffs;
}

/**
 * Find the RuntimeEntities value text within a frame segment.
 * Handles both the case where RuntimeEntities is directly in the segment
 * or nested inside RuntimeData.$blobdoc.
 */
function findRuntimeEntities(segmentText) {
  // Try direct: RuntimeEntities section in the segment
  const t = createTokenizer(segmentText);
  const re = t.findSection('RuntimeEntities');
  if (re) {
    return segmentText.substring(re.valueStart, re.valueEnd);
  }

  // Try nested: RuntimeData → $blobdoc → RuntimeEntities
  const rd = t.findSection('RuntimeData');
  if (!rd) return null;
  const rdText = segmentText.substring(rd.valueStart, rd.valueEnd);

  // $blobdoc inside RuntimeData — it might be an array of blobdocs
  const rdt = createTokenizer(rdText);
  const bd = rdt.findSection('$blobdoc');
  if (!bd) return null;

  // $blobdoc could be an array — look for the first one
  let bdText = rdText.substring(bd.valueStart, bd.valueEnd);
  if (bdText.trimStart().startsWith('[')) {
    // Array of blobdocs — take the first one (or the only one matching RuntimeEntities)
    const arrElements = parseArrayElements(bdText);
    for (const elem of arrElements) {
      if (elem.includes('"RuntimeEntities"')) {
        bdText = elem;
        break;
      }
    }
  }

  const bdt = createTokenizer(bdText);
  const reNested = bdt.findSection('RuntimeEntities');
  if (reNested) {
    return bdText.substring(reNested.valueStart, reNested.valueEnd);
  }

  return null;
}

/**
 * Compare all other top-level sections between golden and result
 * that are NOT StaticData or RuntimeData.
 */
function compareOtherSections(goldenText, resultText) {
  const diffs = [];

  const gTok = createTokenizer(goldenText);
  const gTopKeys = gTok.getTopLevelKeys(0, goldenText.length);

  const sectionsToSkip = new Set(['StaticData', 'RuntimeData', 'Snapshot', 'ReplayJournalDeltaData']);

  for (const key of gTopKeys) {
    if (sectionsToSkip.has(key)) continue;

    const gSec = gTok.findSection(key);
    const gVal = gSec ? goldenText.substring(gSec.valueStart, gSec.valueEnd) : null;

    const rTok = createTokenizer(resultText);
    const rSec = rTok.findSection(key);
    const rVal = rSec ? resultText.substring(rSec.valueStart, rSec.valueEnd) : null;

    if (gVal === null && rVal === null) continue;
    if (gVal === null || rVal === null) {
      diffs.push(`Section "${key}": missing in one side`);
      continue;
    }

    if (gVal !== rVal) {
      diffs.push(`Section "${key}": text differs (${gVal.length} vs ${rVal.length} chars)`);
      if (CLI.verbose && gVal.length < 500) {
        diffs.push(`  golden: ${gVal.substring(0, 300)}`);
        diffs.push(`  result: ${rVal.substring(0, 300)}`);
      }
    }
  }

  // Check for sections in result not in golden
  const rTopKeys = createTokenizer(resultText).getTopLevelKeys(0, resultText.length);
  for (const key of rTopKeys) {
    if (sectionsToSkip.has(key)) continue;
    if (!gTopKeys.includes(key)) {
      diffs.push(`Section "${key}": extra section in result`);
    }
  }

  return diffs;
}
