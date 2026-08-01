/**
 * Approach AircraftState constructor — builds State=30 (Flying/Approach) entries.
 *
 * Implements verified findings from 8 production .acl file audit (ZSJN + KJFK):
 *   - Specification is fixed per Designator (extractable from any .acl)
 *   - AppPointList = f(Route, Runway) — fixed mapping, confirmed on 34 aircraft
 *   - FlyApproachPathPointList = AirwayNode Positions via STAR GUID chain
 *   - ProgressRatio = 1 − (LandingTime − saveTime) / totalApproachTime(Route)
 *   - Position = interpolated along FlyApproach + App combined path
 *   - Direction = path tangent at current position
 */

const { createTokenizer } = require('./tokenizer');
const { preprocessUnityJson } = require('./acl_json');
const { readAclText } = require('./gatcarc');
const {
  DEFAULT_RUNWAY_TAKEOFF_LENGTH,
  DEFAULT_MODEL_OFFSET,
  DEFAULT_AERODROME_CODE,
  DEFAULT_WAKE_CATEGORY,
  DEFAULT_RUNWAY_VR_SPEED,
} = require('../utils/constants/acl-format');
const { APPROACH_EFFECTIVE_SPEED, APPROACH_SPEED_MS, DEFAULT_AIRPORT_SCALE, APPROACH_CEILING_M, TAN_3_DEG, DEFAULT_TAT, EPSILON_NORMALIZE, EPSILON_PR, EPSILON_IAF_JOIN } = require('./constants');

// ─── GUID generator (inlined to avoid ESM import chain issues in tests) ──

let _cryptoRandomUUID;
try { _cryptoRandomUUID = require('crypto').randomUUID; } catch (_) {}

function _generateGuid() {
  if (_cryptoRandomUUID) return _cryptoRandomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── Vector math helpers ──────────────────────────────────────────

function _vec3Sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function _vec3Add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function _vec3Scale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function _vec3Length(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function _vec3Normalize(v) {
  const len = _vec3Length(v);
  if (len < EPSILON_NORMALIZE) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function _vec3Dist(a, b) {
  return _vec3Length(_vec3Sub(a, b));
}

// ─── Runway name normalization ──────────────────────────────────

/**
 * Normalize a runway name by stripping leading zeros from the numeric portion.
 * "01" → "1", "01L" → "1L", "19" → "19", "19R" → "19R"
 * Returns the original string if it doesn't match the runway format.
 * Idempotent — normalizing an already-normalized name is a no-op.
 */
function _normalizeRunway(name) {
  if (!name) return name;
  const match = name.match(/^0*(\d+)([LCR]?)$/);
  if (match) {
    return match[1] + (match[2] || '');
  }
  return name;
}

// ─── ACL text parsing helpers ─────────────────────────────────────

// ═══ Shared ACL text parsing helpers ══════════════════════════════
// These were previously duplicated across approach.js and flight_plans.js.
// They now delegate to the string-aware tokenizer to avoid the
// "brace-in-string" fragility.

function _findArrayEnd(text, startPos) {
  const t = createTokenizer(text);
  return t.findArrayEnd(startPos);
}

function _extractValueBlock(block) {
  const t = createTokenizer(block);
  const vSec = t.findSection('$v');
  if (!vSec) return null;
  return t.substring(vSec.valueStart, vSec.valueEnd);
}

/**
 * Extract the `$k` (GUID key) from a dictionary entry block.
 * Replaces the regex pattern /"\$k"\s*:\s*"([^"]+)"/ across the codebase.
 */
function _extractK(block) {
  const t = createTokenizer(block);
  const kSec = t.findSection('$k');
  if (!kSec || block[kSec.valueStart] !== '"') return null;
  const strEnd = t.skipString(kSec.valueStart);
  if (strEnd === null) return null;
  return block.substring(kSec.valueStart + 1, strEnd - 1);
}

function _extractNestedObject(text, key) {
  const t = createTokenizer(text);
  const sec = t.findSection(key);
  if (!sec) return null;
  return t.substring(sec.valueStart, sec.valueEnd);
}

function _extractFloat(text, key) {
  const t = createTokenizer(text);
  const sec = t.findSection(key);
  if (!sec) return null;
  const valText = text.substring(sec.valueStart, sec.valueEnd);
  return parseFloat(valText);
}

function _extractInt(text, key) {
  const t = createTokenizer(text);
  const sec = t.findSection(key);
  if (!sec) return null;
  const valText = text.substring(sec.valueStart, sec.valueEnd);
  const direct = parseInt(valText, 10);
  if (!isNaN(direct)) return direct;
  // DateTime object: {"$type":3, ticks}
  if (text[sec.valueStart] === '{') {
    const dtT = createTokenizer(valText);
    const typeSec = dtT.findSection('$type');
    if (typeSec) {
      let afterType = typeSec.valueEnd;
      while (afterType < valText.length && ' \t\n\r,'.includes(valText[afterType])) afterType++;
      if (afterType < valText.length) {
        return parseInt(valText.substring(afterType), 10);
      }
    }
  }
  return null;
}

function _extractString(text, key) {
  const t = createTokenizer(text);
  const sec = t.findSection(key);
  if (!sec || text[sec.valueStart] !== '"') return null;
  const strEnd = t.skipString(sec.valueStart);
  if (strEnd === null) return null;
  return text.substring(sec.valueStart + 1, strEnd - 1);
}

function _extractVector3(objText) {
  const t = createTokenizer(objText);
  // Try "x":, "y":, "z": format (float3 type 35)
  const xSec = t.findSection('x');
  const ySec = t.findSection('y');
  const zSec = t.findSection('z');
  if (xSec && ySec && zSec) {
    return {
      x: parseFloat(objText.substring(xSec.valueStart, xSec.valueEnd)),
      y: parseFloat(objText.substring(ySec.valueStart, ySec.valueEnd)),
      z: parseFloat(objText.substring(zSec.valueStart, zSec.valueEnd)),
    };
  }
  // Try $type:16 bare-value format: { "$type": 16, x, y, z }
  const typeSec = t.findSection('$type');
  if (typeSec) {
    let after = typeSec.valueEnd;
    while (after < objText.length && ' \t\n\r,'.includes(objText[after])) after++;
    const bareVals = _parseBareNumbers(objText, after, 3);
    if (bareVals && bareVals.length >= 3) {
      return { x: bareVals[0], y: bareVals[1], z: bareVals[2] };
    }
  }
  return null;
}

/**
 * Parse N bare comma-separated numbers from a position inside an object.
 * Stops at } or end of text.
 */
function _parseBareNumbers(text, start, count) {
  const nums = [];
  let pos = start;
  while (pos < text.length && nums.length < count) {
    while (pos < text.length && ' \t\n\r'.includes(text[pos])) pos++;
    if (pos >= text.length || text[pos] === '}') break;
    if (text[pos] === ',') { pos++; continue; }
    // Number
    let numStart = pos;
    if (text[pos] === '-') pos++;
    while (pos < text.length && '0123456789.eE+-'.includes(text[pos])) pos++;
    const numStr = text.substring(numStart, pos);
    const num = parseFloat(numStr);
    if (!isNaN(num)) nums.push(num);
    else { pos++; } // skip unrecognized char to prevent infinite loop on "$type": etc.
  }
  return nums;
}

function _extractVector3Array(text, key) {
  // v4: structural tokenizer-based array traversal
  const t = createTokenizer(text);
  const keySec = t.findSection(key);
  if (!keySec) return null;

  const valText = text.substring(keySec.valueStart, keySec.valueEnd);
  const valT = createTokenizer(valText);
  const rcSec = valT.findSection('$rcontent');
  if (!rcSec) return null;

  const arrStart = rcSec.valueStart;
  const arrEnd = valT.findArrayEnd(arrStart);
  if (arrEnd === null) return null;

  const arr = valText.substring(arrStart, arrEnd);
  const arrTokenizer = createTokenizer(arr);
  const points = [];
  let pos = 1;
  while (pos < arr.length) {
    while (pos < arr.length && ' \t\n\r'.includes(arr[pos])) pos++;
    if (pos >= arr.length || arr[pos] === ']') break;
    if (arr[pos] === ',') { pos++; continue; }
    if (arr[pos] === '{') {
      const objEnd = arrTokenizer.findObjectEnd(pos);
      if (objEnd === null) break;
      const objText = arr.substring(pos + 1, objEnd - 1);
      const vec = _extractVector3FromBare(objText);
      if (vec) points.push(vec);
      pos = objEnd;
    } else {
      pos++;
    }
  }
  return points.length > 0 ? points : null;
}

/**
 * Extract Vector3 from bare object content (inside the {}).
 * Handles both { "$type": 16, x, y, z } and unnamed { x, y, z }.
 */
function _extractVector3FromBare(objInner) {
  // Skip $type prefix if present: "$type": N, x, y, z
  let startPos = 0;
  if (objInner.startsWith('"$type"')) {
    const commaIdx = objInner.indexOf(',', objInner.indexOf(':', 1));
    if (commaIdx >= 0) startPos = commaIdx + 1;
  }
  const nums = _parseBareNumbers(objInner, startPos, 3);
  if (nums && nums.length >= 3) {
    return { x: nums[0], y: nums[1], z: nums[2] };
  }
  return null;
}

// ─── 1. Specification DB ──────────────────────────────────────────

/**
 * Require a spec field to carry a real value — never silently fall back.
 *
 * Both data intake (extractSpecificationDB / _extractFallbackSpec) and the
 * emission builders resolve AircraftSpecification fields.  When a field is
 * absent (spec missing entirely, or the spec object lacking the field), the
 * old code quietly substituted DEFAULT_* constants — writing plausible-but-
 * wrong data into saves (e.g. AerodromeCode 67 for a widebody).  This turns
 * that into a hard assert whose message names the exact failure chain:
 * builder, aircraft, designator, which lookups were tried, and the refused
 * default.  The DEFAULT_* constants are message content only — they are
 * never emitted values.
 *
 * @param {Function|null} log    optional logger (defaults to console.error)
 * @param {object} ctx           { builder, reg?, acType?, designator?, lookupTrace?, file?, rawBlock? }
 * @param {string} field         spec field name
 * @param {*} value              already-resolved field value (may be null/undefined/NaN)
 * @param {object|null} spec     spec object, only used for the message context
 * @param {*} fallback           the default that was refused (message content only)
 * @returns {*} value            when present
 */
function requireSpecField(log, ctx, field, value, spec, fallback) {
  if (value === undefined || value === null || (typeof value === 'number' && Number.isNaN(value))) {
    const parts = ['[ACL-ASSERT]', ctx.builder + ':'];
    if (fallback !== undefined) parts.push('refusing fallback ' + JSON.stringify(fallback));
    parts.push('spec field "' + field + '" has no value');
    if (ctx.file) parts.push('source=' + ctx.file);
    if (ctx.reg) parts.push('registration=' + ctx.reg);
    if (ctx.acType) parts.push('AircraftType=' + JSON.stringify(ctx.acType));
    if (ctx.designator) parts.push('designator=' + JSON.stringify(ctx.designator));
    if (ctx.lookupTrace) parts.push('lookup: ' + ctx.lookupTrace);
    if (ctx.rawBlock) parts.push('raw=' + ctx.rawBlock);
    parts.push(spec && spec.Designator
      ? 'spec found (Designator=' + JSON.stringify(spec.Designator) + ') but the field is missing from it'
      : 'spec is NULL — field cannot be resolved');
    const msg = parts.join(' ');
    (log || console.error)(msg);
    throw new Error(msg);
  }
  return value;
}

/**
 * Extract a complete Designator → AircraftSpecificationState mapping from ACL text.
 * Returns Map<string, object> where keys are Designator codes (e.g., "B738").
 * Every extracted field is REQUIRED — a source entry missing a field asserts
 * via requireSpecField instead of being silently defaulted.
 */
function extractSpecificationDB(aclText, file) {
  const db = new Map();

  // v4: scan the entire decoded text for Specification objects.
  // They appear in jetway DockingAircraft entries and RuntimeData aircraft
  // entries — not in the traditional WorldState.Aircrafts section.
  const t = createTokenizer(aclText);
  const specPattern = /"Specification":\s*\{/g;
  let match;
  while ((match = specPattern.exec(aclText)) !== null) {
    const specStart = match.index + match[0].length - 1; // '{' after "Specification":
    const specEnd = t.findObjectEnd(specStart);
    if (!specEnd) continue;
    const specObj = aclText.slice(specStart, specEnd);

    const des = _extractString(specObj, 'Designator');
    if (!des || db.has(des)) continue;

    const ctx = {
      builder: 'extractSpecificationDB',
      file: file || '(decoded acl)',
      designator: des,
      rawBlock: specObj.length > 300 ? specObj.slice(0, 300) + '…' : specObj,
    };
    const msgSpec = { Designator: des };

    // Extract ModelOffset sub-object before passing to _extractVector3,
    // since the function expects just the float3 object, not the full spec.
    const moObj = _extractNestedObject(specObj, 'ModelOffset');

    const spec = {
      Designator: des,
      AerodromeCode: requireSpecField(null, ctx, 'AerodromeCode', _extractInt(specObj, 'AerodromeCode'), msgSpec, DEFAULT_AERODROME_CODE),
      WakeTurbulenceCategory: requireSpecField(null, ctx, 'WakeTurbulenceCategory', _extractInt(specObj, 'WakeTurbulenceCategory'), msgSpec, DEFAULT_WAKE_CATEGORY),
      WheelBase: requireSpecField(null, ctx, 'WheelBase', _extractFloat(specObj, 'WheelBase'), msgSpec, 0),
      WingSpan: requireSpecField(null, ctx, 'WingSpan', _extractFloat(specObj, 'WingSpan'), msgSpec, 0),
      RunwayVRSpeed: requireSpecField(null, ctx, 'RunwayVRSpeed', _extractInt(specObj, 'RunwayVRSpeed'), msgSpec, DEFAULT_RUNWAY_VR_SPEED),
      RunwayTakeOffLength: requireSpecField(null, ctx, 'RunwayTakeOffLength', _extractInt(specObj, 'RunwayTakeOffLength'), msgSpec, DEFAULT_RUNWAY_TAKEOFF_LENGTH),
      ModelOffset: requireSpecField(null, ctx, 'ModelOffset', moObj ? _extractVector3(moObj) : null, msgSpec, DEFAULT_MODEL_OFFSET),
      DockingPositions: _extractVector4Array(specObj, 'DockingPositions') ?? [],
    };
    db.set(des, spec);
  }
  return db;
}

/**
 * Extract a single Specification from an arbitrary text block (v4 tokenizer path).
 * Used as a fallback when the approachCache specDB/designatorMap don't have
 * the needed designator (e.g., v4 files where buildDesignatorMapping returns empty).
 * Returns null if no Specification is found.
 * Every extracted field is REQUIRED — same assert policy as extractSpecificationDB.
 */
function _extractFallbackSpec(text, log, ctxBase) {
  const specObj = _extractNestedObject(text, 'Specification');
  if (!specObj) return null;

  const des = _extractString(specObj, 'Designator');
  if (!des) return null;

  const ctx = Object.assign({
    builder: '_extractFallbackSpec',
    designator: des,
    rawBlock: specObj.length > 300 ? specObj.slice(0, 300) + '…' : specObj,
  }, ctxBase || {});
  const msgSpec = { Designator: des };

  const moObj = _extractNestedObject(specObj, 'ModelOffset');

  return {
    Designator: des,
    AerodromeCode: requireSpecField(log, ctx, 'AerodromeCode', _extractInt(specObj, 'AerodromeCode'), msgSpec, DEFAULT_AERODROME_CODE),
    WakeTurbulenceCategory: requireSpecField(log, ctx, 'WakeTurbulenceCategory', _extractInt(specObj, 'WakeTurbulenceCategory'), msgSpec, DEFAULT_WAKE_CATEGORY),
    WheelBase: requireSpecField(log, ctx, 'WheelBase', _extractFloat(specObj, 'WheelBase'), msgSpec, 0),
    WingSpan: requireSpecField(log, ctx, 'WingSpan', _extractFloat(specObj, 'WingSpan'), msgSpec, 0),
    RunwayVRSpeed: requireSpecField(log, ctx, 'RunwayVRSpeed', _extractInt(specObj, 'RunwayVRSpeed'), msgSpec, DEFAULT_RUNWAY_VR_SPEED),
    RunwayTakeOffLength: requireSpecField(log, ctx, 'RunwayTakeOffLength', _extractInt(specObj, 'RunwayTakeOffLength'), msgSpec, DEFAULT_RUNWAY_TAKEOFF_LENGTH),
    ModelOffset: requireSpecField(log, ctx, 'ModelOffset', moObj ? _extractVector3(moObj) : null, msgSpec, DEFAULT_MODEL_OFFSET),
    DockingPositions: _extractVector4Array(specObj, 'DockingPositions') ?? [],
  };
}

function _extractVector4Array(text, key) {
  const t = createTokenizer(text);
  const keySec = t.findSection(key);
  if (!keySec) return null;

  const valText = text.substring(keySec.valueStart, keySec.valueEnd);
  const valT = createTokenizer(valText);
  const rcSec = valT.findSection('$rcontent');
  if (!rcSec) return null;

  const arrStart = rcSec.valueStart;
  const arrEnd = valT.findArrayEnd(arrStart);
  if (arrEnd === null) return null;

  const arr = valText.substring(arrStart, arrEnd);
  if (key === 'DockingPositions') {
    console.log(
      '[EXTRACT-VEC4ARR v4] key=' + key +
      ' arrLen=' + (arrEnd - arrStart) +
      ' preview=' + arr.substring(0, Math.min(400, arr.length)).replace(/\r\n/g, '\\n').replace(/\n/g, '\\n')
    );
  }
  const arrTokenizer = createTokenizer(arr);
  const results = [];
  let pos = 1;
  while (pos < arr.length) {
    while (pos < arr.length && ' \t\n\r'.includes(arr[pos])) pos++;
    if (pos >= arr.length || arr[pos] === ']') break;
    if (arr[pos] === ',') { pos++; continue; }
    if (arr[pos] === '{') {
      const objEnd = arrTokenizer.findObjectEnd(pos);
      if (objEnd === null) break;
      // Use preprocessUnityJson → JSON.parse to decode the typed-value
      // Vector4 object. _fixTypedValues correctly handles both bare-number
      // ("$type": 11) and full-form ("$type": "11|UnityEngine.Vector4, ...")
      // type strings, producing a valid-JSON object with __v sentinel.
      const objText = arr.substring(pos, objEnd);
      const validJson = preprocessUnityJson(objText);
      const parsed = JSON.parse(validJson);
      if (key === 'DockingPositions') {
        console.log(
          '[EXTRACT-VEC4ARR v4] key=' + key +
          ' objText=' + objText.substring(0, Math.min(200, objText.length)).replace(/\r\n/g, '\\n') +
          ' parsed.__v=' + JSON.stringify(parsed.__v)
        );
      }
      if (parsed.__v && parsed.__v.length >= 4) {
        const entry = {
          x: Number(parsed.__v[0]),
          y: Number(parsed.__v[1]),
          z: Number(parsed.__v[2]),
          w: Number(parsed.__v[3]),
        };
        if (key === 'DockingPositions') {
          console.log('[EXTRACT-VEC4ARR v4] key=' + key + ' PUSHED=' + JSON.stringify(entry));
        }
        results.push(entry);
      }
      pos = objEnd;
    } else {
      pos++;
    }
  }
  if (key === 'DockingPositions') {
    console.log('[EXTRACT-VEC4ARR v4] key=' + key + ' TOTAL=' + results.length + ' results=' + JSON.stringify(results));
  }
  return results;
}

// ─── 2. Approach Data Extraction ─────────────────────────────────

/**
 * Extract all State=30 approach aircraft data from ACL text.
 * Returns array of { guid, route, runway, flightPlanGuid, progressRatio, landingTimeTicks,
 *                     flyApproachPoints, appPoints, designator, callsign, direction, position }
 */
function extractApproachData(aclText) {
  const results = [];

  // v4: no pre-spawned aircraft — the game computes state from flight plans at runtime
  return results;
}

// ─── 2b. State=5 Data Extraction ────────────────────────────────

/**
 * Extract all State=5 (Sub-type A: in-air, on Tower frequency) aircraft data from ACL text.
 * Only returns entries that have ApproachDynamicsParams (DynamicsParams present, no
 * TaxiArrivalToHoldingPointPath) — these are aircraft still in the air after handoff.
 *
 * Returns array of { route, runway, touchDownPosition, approachDirection,
 *                     initialPosition, pathPointList }
 */
function extractState5Data(aclText) {
  // v4: no pre-spawned aircraft — approach procedures are resolved from SceneryData
  return [];
}

/**
 * Build Map<(route, runway), State5Params> from extracted State=5 data.
 * Stores entries under BOTH keys:
 *   1. "<approach-route>|<runway>" — the State=5 Route field (e.g. "RNAV ILS Z Rwy 19|19")
 *   2. "<runway>" — runway-only key, for lookup during save when we only have the runway
 * First occurrence wins for each key.
 */
function buildState5ParamsMap(state5Entries) {
  const map = new Map();
  for (const entry of state5Entries) {
    if (!entry.runway) continue;
    const runwayKey = entry.runway; // Each runway maps to exactly one approach procedure
    const params = {
      touchDownPosition: entry.touchDownPosition,
      approachDirection: entry.approachDirection,
      initialPosition: entry.initialPosition,
      pathPointList: entry.pathPointList,
    };
    // Always store by runway (primary lookup during save since STAR ≠ approach route name)
    if (!map.has(runwayKey)) {
      map.set(runwayKey, params);
    }
    // Also store by route|runway if route is non-empty (for completeness)
    if (entry.route) {
      const routeKey = entry.route + '|' + entry.runway;
      if (!map.has(routeKey)) {
        map.set(routeKey, params);
      }
    }
  }
  return map;
}

// ─── 3. Build (Route, Runway) → AppPointList Map ─────────────────

/**
 * Build Map<(route, runway), AppPointList> from extracted approach data.
 * Uses first occurrence for each (route, runway) — verified consistent across all 34 aircraft.
 */
function buildAppPointMap(approachEntries) {
  const map = new Map();
  for (const entry of approachEntries) {
    if (!entry.route || !entry.runway || !entry.appPoints || entry.appPoints.length === 0) continue;
    const key = entry.route + '|' + entry.runway;
    if (!map.has(key)) {
      map.set(key, entry.appPoints);
    }
  }
  return map;
}

// ─── 4. Compute totalApproachTime per Route ──────────────────────

/**
 * Compute totalApproachTime for each Route using dTime/dPR.
 * Groups entries by (groupId, route) to ensure pairs share the same save context.
 * totalApproachTime = median of (LT_B − LT_A) / (PR_B − PR_A) across all within-group pairs.
 *
 * @param {Array} approachEntries - from extractApproachData
 * @param {Function} [getGroupId] - optional grouping function, default uses no grouping
 * @returns {Map<string, number>} Route name → totalApproachTime (seconds)
 */
function computeTotalApproachTimes(approachEntries, getGroupId) {
  // Group by Route first, then within each Route by groupId
  const routeGroups = new Map();
  for (const entry of approachEntries) {
    if (!entry.route) continue;
    if (!routeGroups.has(entry.route)) routeGroups.set(entry.route, []);
    routeGroups.get(entry.route).push(entry);
  }

  const result = new Map();
  for (const [route, entries] of routeGroups) {
    // Further group by groupId if provided
    let subGroups;
    if (getGroupId) {
      subGroups = new Map();
      for (const e of entries) {
        const gid = getGroupId(e);
        if (!subGroups.has(gid)) subGroups.set(gid, []);
        subGroups.get(gid).push(e);
      }
    } else {
      subGroups = new Map([['all', entries]]);
    }

    const ratios = [];
    for (const [gid, groupEntries] of subGroups) {
      if (groupEntries.length < 2) continue;
      for (let i = 0; i < groupEntries.length; i++) {
        for (let j = i + 1; j < groupEntries.length; j++) {
          const dPR = Math.abs(groupEntries[i].progressRatio - groupEntries[j].progressRatio);
          const dLT = Math.abs(groupEntries[i].landingTimeTicks - groupEntries[j].landingTimeTicks);
          if (dPR > EPSILON_PR && dLT > 0) {
            const dSeconds = dLT / 10000000;
            ratios.push(dSeconds / dPR);
          }
        }
      }
    }

    if (ratios.length > 0) {
      ratios.sort((a, b) => a - b);
      const median = ratios[Math.floor(ratios.length / 2)];
      result.set(route, Math.round(median));
    } else {
      result.set(route, DEFAULT_TAT); // default ~26-27 min
    }
  }

  return result;
}

/**
 * Compute totalApproachTimes from SceneryData path lengths.
 *
 * For STARs that already have an aircraft-derived TAT in refTatMap, that value is
 * preserved (it's the most accurate). For STARs without, estimates TAT using the
 * path-length ratio from a reference STAR on the same runway:
 *
 *   estTAT = refTAT × (totalPathLen / refPathLen)
 *
 * where refTAT is the aircraft-derived TAT for the reference STAR, and path lengths
 * are computed from SceneryData (FlyApproach + AppPointList).
 *
 * Falls back to defaultTAT (1600s) when no reference STAR exists for a runway.
 */
function computeApproachTimesFromScenery(aclText, starMappings, appPointMap, refTatMap, defaultTAT, airportScale) {
  const result = new Map();
  const fallbackTAT = defaultTAT || DEFAULT_TAT;

  if (!aclText || !starMappings || !starMappings.starRunwayMap) return result;

  // First, copy aircraft-derived TATs (most accurate)
  if (refTatMap) {
    for (const [star, tat] of refTatMap) {
      result.set(star, tat);
    }
  }

  // Then fill missing STARs using path-length ratios from reference STARs on the same runway
  for (const [starName, runways] of Object.entries(starMappings.starRunwayMap)) {
    if (result.has(starName)) continue; // already have aircraft-derived TAT

    let bestTAT = 0;
    for (const runway of runways) {
      // Compute full terminal path (FlyApproach + procedure + touchdown distance)
      const pathInfo = computeFullTerminalPath(aclText, starName, runway);
      const totalLen = pathInfo.total;
      if (totalLen <= 0) continue;

      // Find a reference STAR on this runway with a known TAT
      const runwayStars = starMappings.runwayStarMap
        ? (starMappings.runwayStarMap[runway] || [])
        : [];
      let refTAT = 0;
      let refLen = 0;
      for (const refStar of runwayStars) {
        if (refStar === starName) continue;
        const refTat = result.get(refStar);
        if (!refTat || refTat <= 0) continue;

        const refPathInfo = computeFullTerminalPath(aclText, refStar, runway);
        refLen = refPathInfo.total;
        if (refLen > 0) {
          refTAT = refTat;
          break;
        }
      }

      let estTAT = 0;
      let tatSource = 'none';
      if (refTAT > 0 && refLen > 0) {
        // Estimate TAT from path-length ratio using aircraft-derived reference
        estTAT = Math.round(refTAT * (totalLen / refLen));
        tatSource = 'ratio(ref=' + refTAT + '@' + refLen.toFixed(1) + ')';
      } else if (airportScale && airportScale > 0) {
        // Physics-based: scale game path to real meters, divide by 240 kts
        estTAT = Math.round(totalLen * airportScale / APPROACH_SPEED_MS);
        tatSource = 'physics(len=' + totalLen.toFixed(1) + ' scale=' + airportScale + ')';
      } else {
        // Fallback: old effective-speed method (deprecated)
        estTAT = Math.round(totalLen / APPROACH_EFFECTIVE_SPEED);
        tatSource = 'fallback(len=' + totalLen.toFixed(1) + ')';
      }
      if (estTAT > bestTAT) {
        bestTAT = estTAT;
      }
    }

    if (bestTAT > 0) {
      result.set(starName, bestTAT);
    } else {
      result.set(starName, fallbackTAT);
    }
  }

  return result;
}

// ─── 5. Resolve FlyApproachPathPointList from SceneryData ────────

/**
 * Resolve FlyApproachPathPointList from SceneryData AirwayNodes.
 * Traces: Runways[runway].Routes[route].AirwayNodeGuids → AirwayNodes[guid].Position
 * Returns Vector3[] or empty array if not found.
 */
function resolveFlyApproachPoints(aclText, route, runway) {
  if (!route || !runway) return [];

  // v4: navigate runway → Routes → find route by Name → resolve AirwayNodes $iref → positions
  const { buildPkIndex, getPkEntriesByType, resolveIref, extractStringFromV4, extractVector3FromV4, extractIrefArray } = require('./v4_pk_index');
  const pkIndex = buildPkIndex(aclText);

  // Find runway entry
  const runwayPk = _findRunwayGuid(aclText, runway);
  if (!runwayPk) return [];

  const rwTypeMap = pkIndex.byType.get('runway');
  const rwEntry = rwTypeMap ? rwTypeMap.get(runwayPk) : null;
  if (!rwEntry) return [];

  // Navigate Routes.$rcontent to find route by Name
  const routesBlock = _extractNestedObject(rwEntry.block, 'Routes');
  if (!routesBlock) return [];

  const routesT = createTokenizer(routesBlock);
  const routesRc = routesT.findSection('$rcontent');
  if (!routesRc) return [];

  let routeEntryIrefs = null;
  let rp = routesRc.valueStart + 1;
  while (rp < routesBlock.length) {
    while (rp < routesBlock.length && ' \t\n\r'.includes(routesBlock[rp])) rp++;
    if (rp >= routesBlock.length || routesBlock[rp] === ']') break;
    if (routesBlock[rp] === ',') { rp++; continue; }
    if (routesBlock[rp] === '{') {
      const reEnd = routesT.findObjectEnd(rp);
      if (reEnd === null) break;
      const candidate = routesBlock.substring(rp, reEnd);
      const name = _extractString(candidate, 'Name');
      const routeType = _extractInt(candidate, 'RouteType');
      if (name === route && routeType === 0) {
        routeEntryIrefs = extractIrefArray(candidate, 'AirwayNodes');
        break;
      }
      rp = reEnd;
    } else { rp++; }
  }

  if (!routeEntryIrefs || routeEntryIrefs.length === 0) {
    return [];
  }

  // Resolve each $iref to a position
  const points = [];
  for (const iref of routeEntryIrefs) {
    const resolved = resolveIref(pkIndex, iref);
    if (resolved) {
      const pos = extractVector3FromV4(resolved.block);
      if (pos) points.push(pos);
    }
  }
  return points;
}

function _findRunwayGuid(text, runwayName) {
  // v4: search PKStaticEntities for runway:* entries by Name/PhysicalName
  const { buildPkIndex, getPkEntriesByType, extractStringFromV4 } = require('./v4_pk_index');
  const pkIndex = buildPkIndex(text);
  const runways = getPkEntriesByType(pkIndex, 'runway');
  const normTarget = _normalizeRunway(runwayName);
  let physFallback = null;
  for (const rw of runways) {
    const name = extractStringFromV4(rw.block, 'Name');
    if (name && _normalizeRunway(name) === normTarget) return rw.pk;
    // PhysicalName fallback (e.g., "15/33")
    if (!physFallback) {
      const physName = extractStringFromV4(rw.block, 'PhysicalName');
      if (physName) {
        const ends = physName.split('/');
        for (const end of ends) {
          if (_normalizeRunway(end.trim()) === normTarget) {
            physFallback = rw.pk;
            break;
          }
        }
      }
    }
  }
  return physFallback || null;
}

// ─── 5c. Parse Runway Thresholds from SceneryData ──────────────

/**
 * Extract runway threshold positions from SceneryData.Runways.
 * Each runway entry has "ThresholdPointGuids" (2 GUIDs) referencing
 * AirwayNodes — these are the exact runway endpoints.
 *
 * @param {string} aclText - raw ACL text
 * @returns {{[name: string]: {thresholds: Array<{x: number, z: number}>}}}
 */
function _parseRunwayThresholds(aclText) {
  const result = {};

  // v4: resolve ThresholdPoints $iref → taxiway-node positions via pkIndex.
  // Each runway entry has "ThresholdPoints": { "$rcontent": [$iref:A, $iref:B] }
  // where both resolve to taxiway-node entities with ReactivePosition.
  const { buildPkIndex, resolveIref, extractVector3FromV4, extractStringFromV4, extractIrefArray } = require('./v4_pk_index');
  const pkIndex = buildPkIndex(aclText);
  const rwMap = pkIndex.byType.get('runway');
  if (!rwMap) return result;

  for (const [, rwEntry] of rwMap) {
    const physName = extractStringFromV4(rwEntry.block, 'PhysicalName');
    if (!physName || !physName.includes('/')) continue;
    if (result[physName]) continue; // deduplicate by physical name

    const tpIrefs = extractIrefArray(rwEntry.block, 'ThresholdPoints');
    if (tpIrefs && tpIrefs.length >= 2) {
      const thresholds = [];
      for (const iref of tpIrefs) {
        const resolved = resolveIref(pkIndex, iref);
        if (resolved) {
          const pos = extractVector3FromV4(resolved.block);
          if (pos) thresholds.push({ x: pos.x, z: pos.z });
        }
      }
      if (thresholds.length === 2) {
        result[physName] = { thresholds };
      }
    }
  }
  return result;
}

/**
 * Returns the uniform coordinate scale factor (m/game-unit).
 *
 * All axes (XYZ) use a fixed 100 m/unit scale — confirmed by original game
 * files using Y=15.24 (= 5000ft) at every airport regardless of runway geometry.
 *
 * @returns {number} DEFAULT_AIRPORT_SCALE (100)
 */
function computeAirportScale(aclText) {
  // All axes use a uniform 100 m/unit scale. The per-airport runway-length
  // ratio was a mistaken assumption — the game's coordinate system is fixed.
  return DEFAULT_AIRPORT_SCALE;
}

/**
 * Compute the approach altitude ceiling in game units from the per-airport
 * coordinate scale. Uses a real-world ceiling of 5000ft (1524m) — the standard
 * ILS approach ceiling — and converts to game units via the airport scale.
 *
 *   approachCap = APPROACH_CEILING_M / airportScale
 *
 * At the default scale (100 m/unit): 1524/100 = 15.24 (backward compatible).
 *
 * @param {number} [airportScale] - m/game-unit from computeAirportScale()
 * @returns {number} approach ceiling in game units
 */
function computeApproachCap(airportScale) {
  // All axes use a fixed 100 m/unit scale. Every original game file
  // stores Y=15.24 (= 5000ft) regardless of airport.
  return APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE;  // 15.24
}

/**
 * Compute the full terminal path length for a STAR+runway combination.
 *
 * Combines three segments from SceneryData:
 *   1. FlyApproach points (Type=0 STAR route) via resolveFlyApproachPoints
 *   2. Approach procedure points (Type=1 route) via resolveApproachProcedureData
 *   3. Touchdown distance from last procedure point to runway threshold
 *
 * Returns { flyLen, procLen, tdDist, total } in game units.
 */
function computeFullTerminalPath(aclText, star, runway) {
  let flyLen = 0;
  let procLen = 0;
  let tdDist = 0;

  const flyPoints = resolveFlyApproachPoints(aclText, star, runway);
  if (flyPoints && flyPoints.length >= 2) {
    flyLen = computePathLength(flyPoints);
  }

  // Use the last FlyApproach point (IAF) as hintPosition so the correct
  // approach procedure variant is selected when multiple Type=1 variants
  // exist for the runway. Without this, resolveApproachProcedureData picks
  // the first variant, whose path length may differ, causing TAT
  // misestimation and incorrect State=5 aircraft positions (V4 regression).
  const hintPos = (flyPoints && flyPoints.length > 0)
    ? flyPoints[flyPoints.length - 1]
    : null;
  const procData = resolveApproachProcedureData(aclText, runway, hintPos);
  if (procData && procData.pathPointList && procData.pathPointList.length >= 2) {
    procLen = computePathLength(procData.pathPointList);

    // Touchdown distance: last procedure point → threshold
    if (procData.touchDownPosition) {
      const last = procData.pathPointList[procData.pathPointList.length - 1];
      const td = procData.touchDownPosition;
      tdDist = Math.sqrt((last.x - td.x) ** 2 + (last.z - td.z) ** 2);
    }
  }

  const total = flyLen + procLen + tdDist;
  return { flyLen, procLen, tdDist, total };
}

// ─── 5b. STAR-Runway Mapping from SceneryData ─────

/**
 * Extract ALL valid STAR↔runway combinations directly from SceneryData.Runways.
 *
 * This is the authoritative source: each runway entry has a Routes array where
 * Type=0 entries are STARs (arrival transitions) and Type=2 entries are SIDs
 * (departure transitions). We extract only Type=0 entries.
 *
 * Unlike appPointMap (built from State=30 aircraft at snapshot time), this
 * captures EVERY combo defined in the scenery, regardless of whether any
 * .acl file has an active approach aircraft for it.
 *
 * @param {string} aclText - raw ACL file content
 * @returns {{starRunwayMap: Object<string, string[]>, runwayStarMap: Object<string, string[]>}}
 */
function extractStarRunwayMappings(aclText) {
  const starRunwayMap = {};  // { starName → [runway, ...] }
  const runwayStarMap = {};  // { runway → [starName, ...] }
  if (!aclText) return { starRunwayMap, runwayStarMap };

  // v4: iterate runway:* entries from PKStaticEntities
  const { buildPkIndex, getPkEntriesByType, extractStringFromV4, extractIrefArray } = require('./v4_pk_index');
  const pkIndex = buildPkIndex(aclText);
  const runways = getPkEntriesByType(pkIndex, 'runway');

  for (const rw of runways) {
    const runwayName = extractStringFromV4(rw.block, 'Name');
    const physName = extractStringFromV4(rw.block, 'PhysicalName');
    if (!runwayName || !physName || !physName.includes('/')) continue;

    // Navigate Routes.$rcontent within the runway block
    const routesBlock = _extractNestedObject(rw.block, 'Routes');
    if (!routesBlock) continue;

    const routesT = createTokenizer(routesBlock);
    const routesRc = routesT.findSection('$rcontent');
    if (!routesRc) continue;

    let rp = routesRc.valueStart + 1; // skip opening [
    while (rp < routesBlock.length) {
      while (rp < routesBlock.length && ' \t\n\r'.includes(routesBlock[rp])) rp++;
      if (rp >= routesBlock.length || routesBlock[rp] === ']') break;
      if (routesBlock[rp] === ',') { rp++; continue; }
      if (routesBlock[rp] === '{') {
        const reEnd = routesT.findObjectEnd(rp);
        if (reEnd === null) break;
        const routeEntry = routesBlock.substring(rp, reEnd);
        // RouteType 0 = STAR
        const routeType = _extractInt(routeEntry, 'RouteType');
        if (routeType === 0) {
          const starName = _extractString(routeEntry, 'Name');
          // v4 uses AirwayNodes.$rcontent with $iref values
          const irefs = extractIrefArray(routeEntry, 'AirwayNodes');
          if (starName && irefs.length > 0) {
            if (!starRunwayMap[starName]) starRunwayMap[starName] = [];
            if (!starRunwayMap[starName].includes(runwayName)) starRunwayMap[starName].push(runwayName);
            if (!runwayStarMap[runwayName]) runwayStarMap[runwayName] = [];
            if (!runwayStarMap[runwayName].includes(starName)) runwayStarMap[runwayName].push(starName);
          }
        }
        rp = reEnd;
      } else {
        rp++;
      }
    }
  }
  return { starRunwayMap, runwayStarMap };
}

// ─── 5c. Resolve Approach Procedure Data from SceneryData ─────

/**
 * Resolve State=5 approach procedure data from SceneryData for a given runway.
 * Extracts PathPointList, TouchDownPosition, ApproachDirection, and InitialPosition
 * from the approach procedure route (Type=1) and the runway's TouchDownPointGuid.
 *
 * Unlike extractState5Data() which relies on existing State=5 aircraft entries,
 * this extracts data from SceneryData which has approach procedures for ALL runways
 * regardless of whether any file contains a State=5 aircraft for that runway.
 *
 * When hintPosition is provided and multiple Type=1 variants exist for the runway,
 * picks the variant whose first AirwayNode is closest to hintPosition. This ensures
 * each STAR gets the correct approach procedure variant (e.g. ZSJN runway 01 has
 * three "RNAV ILS Z Rwy 01" variants starting at JN207, DALIM, JN209).
 *
 * @param {string} aclText - raw ACL file content
 * @param {string} runway - runway name, e.g. "22L"
 * @param {{x:number, z:number}} [hintPosition] - optional last FlyApproach point
 *   of the STAR; used to select the correct variant when multiple exist
 * @returns {{pathPointList, touchDownPosition, approachDirection, initialPosition} | null}
 */
function resolveApproachProcedureData(aclText, runway, hintPosition) {
  if (!runway) return null;

  // v4: navigate runway → Routes for RouteType=1 (Approach), resolve AirwayNodes $iref → positions
  const { buildPkIndex, getPkEntriesByType, resolveIref, extractStringFromV4, extractVector3FromV4, extractIrefArray, extractSingleIref } = require('./v4_pk_index');
  const pkIndex = buildPkIndex(aclText);

  // Find runway entry
  const runwayPk = _findRunwayGuid(aclText, runway);
  if (!runwayPk) return null;

  const rwTypeMap = pkIndex.byType.get('runway');
  const rwEntry = rwTypeMap ? rwTypeMap.get(runwayPk) : null;
  if (!rwEntry) return null;

  // Navigate Routes.$rcontent for RouteType=1
  const routesBlock = _extractNestedObject(rwEntry.block, 'Routes');
  if (!routesBlock) return null;

  const routesT = createTokenizer(routesBlock);
  const routesRc = routesT.findSection('$rcontent');
  if (!routesRc) return null;

  // Collect all RouteType=1 variants
  const variants = [];
  let rp = routesRc.valueStart + 1;
  while (rp < routesBlock.length) {
    while (rp < routesBlock.length && ' \t\n\r'.includes(routesBlock[rp])) rp++;
    if (rp >= routesBlock.length || routesBlock[rp] === ']') break;
    if (routesBlock[rp] === ',') { rp++; continue; }
    if (routesBlock[rp] === '{') {
      const entryEnd = routesT.findObjectEnd(rp);
      if (entryEnd === null) break;
      const routeEntry = routesBlock.substring(rp, entryEnd);
      const routeType = _extractInt(routeEntry, 'RouteType');
      if (routeType === 1) {
        const routeName = _extractString(routeEntry, 'Name');
        const irefs = extractIrefArray(routeEntry, 'AirwayNodes');
        if (irefs.length >= 2) {
          const points = [];
          for (const iref of irefs) {
            const resolved = resolveIref(pkIndex, iref);
            if (resolved) {
              const pos = extractVector3FromV4(resolved.block);
              if (pos) points.push(pos);
            }
          }
          if (points.length >= 2) {
            variants.push({ pathPointList: points, firstPoint: points[0], routeName });
          }
        }
      }
      rp = entryEnd;
    } else { rp++; }
  }

  if (variants.length === 0) return null;

  // Pick correct variant
  let pathPointList;
  let routeName;
  if (hintPosition && variants.length > 1) {
    let bestDist = Infinity;
    for (const v of variants) {
      const dx = v.firstPoint.x - hintPosition.x;
      const dz = v.firstPoint.z - hintPosition.z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        pathPointList = v.pathPointList;
        routeName = v.routeName;
      }
    }
  } else {
    pathPointList = variants[0].pathPointList;
    routeName = variants[0].routeName;
  }

  // v4: resolve touchdown from the runway entry's dedicated TouchDownPoint $iref.
  // TouchDownPoint $iref → taxiway-node position.
  // The $iref points to a taxiway-node entity at the landing threshold.
  const lastPt = pathPointList[pathPointList.length - 1];
  const prevPt = pathPointList[pathPointList.length - 2];
  const approachDirection = _vec3Normalize(_vec3Sub(lastPt, prevPt));

  const tdIref = extractSingleIref(rwEntry.block, 'TouchDownPoint');
  if (tdIref == null) {
    throw new Error(
      '[resolveApproachProcedureData] v4 runway "' + runway +
      '" has no TouchDownPoint $iref. Cannot determine TouchDownPosition.'
    );
  }
  const tdEntity = resolveIref(pkIndex, tdIref);
  if (!tdEntity) {
    throw new Error(
      '[resolveApproachProcedureData] v4 runway "' + runway +
      '" TouchDownPoint $iref:' + tdIref + ' could not be resolved to an entity.'
    );
  }
  const tdPosV4 = extractVector3FromV4(tdEntity.block);
  if (!tdPosV4) {
    throw new Error(
      '[resolveApproachProcedureData] v4 runway "' + runway +
      '" TouchDownPoint $iref:' + tdIref + ' resolved but has no Position vector.'
    );
  }
  const tdPos = { x: tdPosV4.x, y: 0, z: tdPosV4.z };

  return {
    pathPointList,
    touchDownPosition: tdPos,
    approachDirection,
    initialPosition: { ...pathPointList[0] },
    routeName,
  };
}

// ─── 6. ProgressRatio Computation ────────────────────────────────

/**
 * Compute ProgressRatio for an approach aircraft.
 * Formula: 1 − (landingTimeTicks − saveTimeTicks) / (totalApproachTime × 10^7)
 * Clamped to [0.0, 1.0].
 */
function computeProgressRatio(landingTimeTicks, saveTimeTicks, totalApproachTimeSeconds) {
  if (totalApproachTimeSeconds <= 0) return 0;
  const timeToLandingTicks = landingTimeTicks - saveTimeTicks;
  const totalApproachTicks = totalApproachTimeSeconds * 10000000;
  const ratio = 1.0 - (timeToLandingTicks / totalApproachTicks);
  return Math.max(0, Math.min(1, ratio));
}

// ─── 7. Path Interpolation ───────────────────────────────────────

/**
 * Combine FlyApproach + App points into one full path.
 */
function buildFullPath(flyApproachPoints, appPoints, touchDownPosition) {
  const all = [...(flyApproachPoints || []), ...(appPoints || [])];
  if (touchDownPosition) {
    // Avoid zero-length tail segment which would cause div-by-zero in
    // _interpolateAlongPath / _tangentAlongPath.
    const last = all.length > 0 ? all[all.length - 1] : null;
    if (!last || _vec3Dist(last, touchDownPosition) > EPSILON_PR) {
      all.push(touchDownPosition);
    }
  }
  return all;
}

/**
 * Deduplicate the IAF join between STAR FlyApproach and procedure PathPointList.
 * Both segments meet at the Initial Approach Fix — if the last flyPoint and first
 * ppList point are the same (within 0.1m), trim the duplicate from flyPoints to
 * avoid a zero-length segment that would cause NaN in _interpolateAlongPath.
 */
function _dedupeIafJoin(flyPoints, ppList) {
  if (!flyPoints || flyPoints.length === 0 || !ppList || ppList.length === 0) {
    return flyPoints || [];
  }
  const lastFly = flyPoints[flyPoints.length - 1];
  const firstPP = ppList[0];
  if (_vec3Dist(lastFly, firstPP) < EPSILON_IAF_JOIN) {
    return flyPoints.slice(0, -1);
  }
  return flyPoints;
}

/**
 * Compute total path length (sum of segment distances).
 */
function computePathLength(points) {
  if (!points || points.length < 2) return 0;
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += _vec3Dist(points[i - 1], points[i]);
  }
  return len;
}

/**
 * Interpolate position along a path given a distance from start.
 */
function _interpolateAlongPath(points, targetDist) {
  if (!points || points.length === 0) return { x: 0, y: APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE, z: 0 };
  if (points.length === 1) return { ...points[0] };

  let traveled = 0;
  for (let i = 1; i < points.length; i++) {
    const segLen = _vec3Dist(points[i - 1], points[i]);
    if (traveled + segLen >= targetDist) {
      const t = (targetDist - traveled) / segLen;
      return _vec3Add(points[i - 1], _vec3Scale(_vec3Sub(points[i], points[i - 1]), t));
    }
    traveled += segLen;
  }
  return { ...points[points.length - 1] };
}

/**
 * Compute tangent direction at a given distance along the path.
 */
function _tangentAlongPath(points, targetDist) {
  if (!points || points.length < 2) return { x: 0, y: 0, z: 1 };

  let traveled = 0;
  for (let i = 1; i < points.length; i++) {
    const segLen = _vec3Dist(points[i - 1], points[i]);
    if (traveled + segLen >= targetDist || i === points.length - 1) {
      return _vec3Normalize(_vec3Sub(points[i], points[i - 1]));
    }
    traveled += segLen;
  }
  return _vec3Normalize(_vec3Sub(points[points.length - 1], points[points.length - 2]));
}

/**
 * Compute Position from ProgressRatio along combined FlyApproach + App + TouchDown path.
 * Touchdown IS included in the interpolation path so the XZ position is accurate
 * all the way to the runway threshold. It also drives the 3° ILS glideslope Y.
 */
function computePosition(flyApproachPoints, appPoints, progressRatio, touchDownPosition, approachCap) {
  const fullPath = buildFullPath(flyApproachPoints, appPoints, touchDownPosition);
  const totalLen = computePathLength(fullPath);
  const targetDist = totalLen * progressRatio;
  const pos = _interpolateAlongPath(fullPath, targetDist);
  // Y from 3° ILS glideslope using REMAINING PATH DISTANCE (not straight-line).
  // Path distance follows the approach route through turns — correct for
  // curved approaches like KJFK SIE.CAMRM5. Capped at the runway's approach
  // ceiling (cached per runway, NOT hardcoded).
  if (touchDownPosition && approachCap != null) {
    // Remaining distance: path left from current position to touchdown
    // (touchdown is now the last point in fullPath).
    const remainingPathDist = totalLen - targetDist;
    const glideY = remainingPathDist * TAN_3_DEG;
    pos.y = Math.min(approachCap, glideY);
  } else {
    pos.y = APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE; // fallback for callers without runway data (tests, legacy)
  }
  return pos;
}

/**
 * Compute Direction (normalized XZ tangent) from ProgressRatio along combined path.
 * @param {Vector3[]} flyApproachPoints
 * @param {Vector3[]} appPoints
 * @param {number} progressRatio - 0..1
 * @param {Vector3} [touchDownPosition] - optional runway threshold, included in path
 *   so heading points toward the runway when near the end of the approach
 */
function computeDirection(flyApproachPoints, appPoints, progressRatio, touchDownPosition) {
  const fullPath = buildFullPath(flyApproachPoints, appPoints, touchDownPosition || null);
  const totalLen = computePathLength(fullPath);
  const targetDist = totalLen * progressRatio;
  const dir = _tangentAlongPath(fullPath, targetDist);
  dir.y = 0; // level flight
  return _vec3Normalize(dir);
}

// ─── 8. AircraftState Assembly ───────────────────────────────────

/**
 * Build a complete AircraftState $k/$v block for a State=30 approach aircraft.
 *
 * @param {Object} opts
 * @param {string} opts.flightPlanGuid - links to FlightPlans dictionary
 * @param {string} opts.route - STAR/approach route name
 * @param {Object[]} opts.flyPoints - FlyApproachPathPointList positions
 * @param {Object[]} opts.appPoints - AppPointList positions
 * @param {number} opts.progressRatio - [0.0, 1.0]
 * @param {Object} opts.spec - Specification from specDB
 * @param {string} [opts.radioChannelGuid] - radio channel GUID
 * @param {number} [opts.nextId] - starting $id counter (default 5001)
 * @param {number} [opts.acTypeNum] - AircraftState $type number: 33 (ZSJN) or 35 (KJFK). Default 33.
 * @returns {{guid: string, block: string, nextId: number}} entry text for $rcontent
 */
function buildApproachAircraftBlock(opts) {
  const {
    flightPlanGuid,
    route,
    flyPoints,
    appPoints,
    progressRatio,
    spec,
    radioChannelGuid = '',
    touchDownPosition = null,
    approachCap = null,
    nextId = 5001,
  } = opts;

  const guid = _generateGuid();
  let id = nextId;

  // Every spec field is REQUIRED — no silent defaults. A spec that lacks a
  // field asserts via requireSpecField instead of emitting undefined/NaN.
  {
    const ctx = { builder: 'buildApproachAircraftBlock', designator: spec && spec.Designator };
    for (const f of ['AerodromeCode', 'WakeTurbulenceCategory', 'WheelBase', 'WingSpan', 'RunwayVRSpeed', 'RunwayTakeOffLength', 'ModelOffset']) {
      requireSpecField(null, ctx, f, spec ? spec[f] : undefined, spec, undefined);
    }
  }

  // Use namespace-qualified $type strings. Every typeNum is REQUIRED — no fallback numbers.
  // The caller (flight_plans.js) resolves all types from the per-file type map.
  const tn = opts.typeNums || {};
  const resolve = (key, fullName, asm = 'GroundATC.Core') => {
    const id = tn[key];
    if (id == null) {
      throw new Error(
        `[APPROACH] buildApproachAircraftBlock: missing typeNum "${key}" = "${fullName}, ${asm}".\n` +
        `  Provided keys: ${Object.keys(tn).join(', ') || '(none)'}`
      );
    }
    return `"${id}|${fullName}, ${asm}"`;
  };
  const T = {
    ac:      resolve('acType',           'ContextCross.States.AircraftState'),
    spec:    resolve('spec',             'ContextCross.States.AircraftSpecificationState'),
    dyn:     resolve('dynInternal',      'ContextCross.Dynamics.DynamicInternalState'),
    dynParams: resolve('dynParams',        'ContextCross.Dynamics.States.FlyApproachDynamicsParams'),
    acRwy:   resolve('acRwy',            'ContextCross.States.AircraftRunwayCoordinateState'),
    float3:  resolve('float3',           'Unity.Mathematics.float3', 'Unity.Mathematics'),
    vec4:    resolve('vec4',             'UnityEngine.Vector4', 'UnityEngine.CoreModule'),
    dockArr: resolve('vec4Arr',          'UnityEngine.Vector4[]', 'UnityEngine.CoreModule'),
    waitCmd: resolve('waitCmd',          'ContextCross.Enums.ECommand[]'),
    recvEvt: resolve('recvEvt',          'ContextCross.Events.AircraftEvent[]'),
  };

  // Format helpers — use namespace-qualified types everywhere.
  // BCL types (Vector3=16, String[]=8) are stable across Unity versions and safe as-is.
  const nsVec3 = '"16|UnityEngine.Vector3, UnityEngine.CoreModule"';
  const nsListVec3 = `"${resolve('listVec3', 'System.Collections.Generic.List\`1[[UnityEngine.Vector3, UnityEngine.CoreModule]]', 'mscorlib')}"`;
  const nsStrArr = '"8|System.String[], mscorlib"';

  const fmtV3 = (v) => `{\n  "$type": ${nsVec3},\n  ${v.x},\n  0,\n  ${v.z}\n}`;
  const fmtFloat3 = (v) => `{\n  "$type": ${T.float3},\n  ${v.x},\n  ${v.y},\n  ${v.z}\n}`;

  // Build FlyApproachPathPointList
  let flyPointsStr = '';
  if (flyPoints && flyPoints.length > 0) {
    const pts = flyPoints.map((p, i) => `${i === 0 ? '' : ',\n'}{"$type": ${nsVec3}, ${p.x}, 0, ${p.z}}`).join('');
    flyPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": ${flyPoints.length},\n"$rcontent": [\n${pts}\n]\n}`;
  } else {
    flyPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": 0,\n"$rcontent": []\n}`;
  }

  // Build AppPointList
  let appPointsStr = '';
  if (appPoints && appPoints.length > 0) {
    const pts = appPoints.map((p, i) => `${i === 0 ? '' : ',\n'}{"$type": ${nsVec3}, ${p.x}, 0, ${p.z}}`).join('');
    appPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": ${appPoints.length},\n"$rcontent": [\n${pts}\n]\n}`;
  } else {
    appPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": 0,\n"$rcontent": []\n}`;
  }

  // Build DockingPositions
  let dockStr = '';
  const dp = spec.DockingPositions || [];
  console.log(
    '[APPROACH State=30] DockingPositions spec=' + spec.Designator +
    ' dpLen=' + dp.length +
    ' T.vec4=' + T.vec4 +
    ' dp=' + JSON.stringify(dp)
  );
  if (dp.length > 0) {
    const dpts = dp.map((d, i) => `${i === 0 ? '' : ',\n'}{"$type": ${T.vec4}, ${d.x}, ${d.y}, ${d.z}, ${d.w}}`).join('');
    dockStr = `{\n"$id": ${id++},\n"$type": ${T.dockArr},\n"$rlength": ${dp.length},\n"$rcontent": [\n${dpts}\n]\n}`;
  } else {
    dockStr = `{\n"$id": ${id++},\n"$type": ${T.dockArr},\n"$rlength": 0,\n"$rcontent": []\n}`;
  }

  // Position and Direction
  const pos = computePosition(flyPoints, appPoints, progressRatio, touchDownPosition, approachCap);
  const dir = computeDirection(flyPoints, appPoints, progressRatio, touchDownPosition);

  const block = `{
    "$id": ${id++},
    "$type": ${T.ac},
    "Guid": "${guid}",
    "Enabled": true,
    "State": 30,
    "Specification": {
      "$id": ${id++},
      "$type": ${T.spec},
      "Guid": null,
      "Enabled": false,
      "Designator": "${spec.Designator}",
      "AerodromeCode": ${spec.AerodromeCode},
      "WakeTurbulenceCategory": ${spec.WakeTurbulenceCategory},
      "WheelBase": ${spec.WheelBase},
      "ModelOffset": ${fmtFloat3(spec.ModelOffset)},
      "WingSpan": ${spec.WingSpan},
      "DockingPositions": ${dockStr},
      "RunwayVRSpeed": ${spec.RunwayVRSpeed},
      "RunwayTakeOffLength": ${spec.RunwayTakeOffLength}
    },
    "Direction": ${fmtV3(dir, T)},
    "DynamicInternalState": {
      "$type": ${T.dyn},
      "DynamicsState": 1,
      "TaxiSpeed": 240,
      "ForwardSpeed": true,
      "TargetTaxiSpeed": 240,
      "PositiveTaxiAcceleration": 1,
      "NegativeTaxiAcceleration": -2,
      "TaxiArrivalToSpotPath": null,
      "TaxiArrivalToHoldingPointPath": null,
      "FrontWheelSteeringAngle": 0,
      "DynamicsParams": {
        "$id": ${id++},
        "$type": ${T.dynParams},
        "ProgressRatio": ${progressRatio},
        "FlyApproachPathPointList": ${flyPointsStr},
        "AppPointList": ${appPointsStr}
      }
    },
    "AircraftRunwayCoordinateState": {
      "$id": ${id++},
      "$type": ${T.acRwy},
      "Guid": null,
      "Enabled": false,
      "TaxiPathUnPassedIntersectionRunwayNames": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "TaxiBlockingRunwayNames": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwayFenceCurrentEnterRunways": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwayGuardCurrentEnterRunways": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "CrossRunwayPermissions": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwaySetterIdx": 0
    },
    "FlightPlanGuid": "${flightPlanGuid}",
    "ActiveFlightDirection": 1,
    "Position": {
      "$type": ${nsVec3},
      ${pos.x},
      ${pos.y},
      ${pos.z}
    },
    "RadioChannelGuid": "${radioChannelGuid}",
    "JurisdictionRadioChannelGuid": "${radioChannelGuid}",
    "TaxiPathStartingPosition": { "$type": ${nsVec3}, 0, 0, 0 },
    "TaxiPath": null,
    "RollingPresetTaxiPathStartingPosition": { "$type": ${nsVec3}, 0, 0, 0 },
    "RollingPresetTaxiPath": null,
    "SelectedRunwayEntryIndex": -1,
    "SelectedRunwayEntryRunwayGuid": null,
    "SelectedRunwayExitIndex": -1,
    "SelectedTaxiPushBackNodeGuid": null,
    "SelectedTowNavigationPointGuid": null,
    "IsFirstTaxi": false,
    "WaitingForCommands": {
      "$id": ${id++},
      "$type": ${T.waitCmd},
      "$rlength": 0,
      "$rcontent": []
    },
    "ReceivedEvents": {
      "$id": ${id++},
      "$type": ${T.recvEvt},
      "$rlength": 0,
      "$rcontent": []
    },
    "Route": "${route}"
  }`;

  return {
    guid,
    block,
    nextId: id,
  };
}

// ─── 8b. State=5 Aircraft Block Builder ────────────────────────────

/**
 * Build a State=5 (Approach/Tower, in-air) aircraft entry JSON block.
 * Uses ApproachDynamicsParams with cached PathPointList instead of
 * FlyApproachDynamicsParams (which State=30 uses).
 *
 * @param {Object} opts
 * @param {string} opts.flightPlanGuid - GUID of the matching FlightPlanState
 * @param {string} opts.route - approach procedure name (e.g., "RNAV ILS Z Rwy 19")
 * @param {number} opts.state5PR - DEPRECATED: hardcoded to 0; game recalculates path-based PR
 * @param {Object} opts.spec - AircraftSpec from specDB
 * @param {string} opts.towerChannelGuid - Tower radio channel GUID
 * @param {Object} opts.state5Params - cached { touchDownPosition, approachDirection, initialPosition, pathPointList }
 * @param {number} [opts.approachCap] - approach altitude ceiling in game units (default: computed from 5000ft / airportScale)
 * @param {number} [opts.nextId=5001] - starting $id counter
 * @param {Object} [opts.typeNums] - per-file type number overrides
 * @param {number} [opts.acTypeNum] - AircraftState $type number
 * @returns {{guid: string, block: string, nextId: number}}
 */
function buildState5AircraftBlock(opts) {
  const {
    flightPlanGuid,
    route,
    spec,
    towerChannelGuid = '',
    state5Params,
    flyPoints = null,
    fullPR = null,
    waitingForCommand = 22,
    selectedRunwayExitIndex = -1,
    approachCap: _explicitCap,
    nextId = 5001,
  } = opts;

  const guid = _generateGuid();
  let id = nextId;

  // Every spec field is REQUIRED — no silent defaults. A spec that lacks a
  // field asserts via requireSpecField instead of emitting undefined/NaN.
  {
    const ctx = { builder: 'buildState5AircraftBlock', designator: spec && spec.Designator };
    for (const f of ['AerodromeCode', 'WakeTurbulenceCategory', 'WheelBase', 'WingSpan', 'RunwayVRSpeed', 'RunwayTakeOffLength', 'ModelOffset']) {
      requireSpecField(null, ctx, f, spec ? spec[f] : undefined, spec, undefined);
    }
  }

  // Use namespace-qualified $type strings. Every typeNum is REQUIRED — no fallback numbers.
  const tn = opts.typeNums || {};
  const resolve = (key, fullName, asm = 'GroundATC.Core') => {
    const id = tn[key];
    if (id == null) {
      throw new Error(
        `[APPROACH] buildState5AircraftBlock: missing typeNum "${key}" = "${fullName}, ${asm}".\n` +
        `  Provided keys: ${Object.keys(tn).join(', ') || '(none)'}`
      );
    }
    return `"${id}|${fullName}, ${asm}"`;
  };
  const T = {
    ac:          resolve('acType',            'ContextCross.States.AircraftState'),
    spec:        resolve('spec',              'ContextCross.States.AircraftSpecificationState'),
    dyn:         resolve('dynInternal',       'ContextCross.Dynamics.DynamicInternalState'),
    approachDyn: resolve('approachDynParams', 'ContextCross.Dynamics.States.ApproachDynamicsParams'),
    acRwy:       resolve('acRwy',             'ContextCross.States.AircraftRunwayCoordinateState'),
    float3:      resolve('float3',            'Unity.Mathematics.float3', 'Unity.Mathematics'),
    vec4:        resolve('vec4',              'UnityEngine.Vector4', 'UnityEngine.CoreModule'),
    dockArr:     resolve('vec4Arr',           'UnityEngine.Vector4[]', 'UnityEngine.CoreModule'),
    waitCmd:     resolve('waitCmd',           'ContextCross.Enums.ECommand[]'),
    recvEvt:     resolve('recvEvt',           'ContextCross.Events.AircraftEvent[]'),
  };

  const nsVec3 = '"16|UnityEngine.Vector3, UnityEngine.CoreModule"';
  const nsListVec3 = `"${resolve('listVec3', 'System.Collections.Generic.List\`1[[UnityEngine.Vector3, UnityEngine.CoreModule]]', 'mscorlib')}"`;
  const nsStrArr = '"8|System.String[], mscorlib"';

  const fmtV3 = (v) => `{\n  "$type": ${nsVec3},\n  ${v.x},\n  0,\n  ${v.z}\n}`;
  const fmtFloat3 = (v) => `{\n  "$type": ${T.float3},\n  ${v.x},\n  ${v.y},\n  ${v.z}\n}`;

  // Standard ILS glideslope — 3 degrees.
  // All AirwayNodes and PathPointList points have y=0 in the ACL
  // (Unity stores positions in the XZ plane). The game computes actual
  // altitude from the glideslope using REMAINING PATH DISTANCE (not
  // straight-line) to follow the approach route through turns.
  // Capped at the runway's approach ceiling (5000ft real-world, converted
  // to game units via per-airport coordinate scale).
  // TAN_3_DEG imported from ./constants
  const tdPos = state5Params.touchDownPosition || { x: 0, y: 0, z: 0 };
  const approachCap = (_explicitCap != null) ? _explicitCap : computeApproachCap();

  // Build PathPointList with glideslope-computed Y (not the stored Y=0).
  // Each point's Y = min(approachCap, pathDistanceToTD × tan(3°)).
  const ppList = state5Params.pathPointList || [];
  let pathPointsStr = '';

  // Pre-compute path distances from each point to touchdown.
  // Walk backwards through the path + tdPos to get cumulative distance.
  const fullPathPoints = ppList.length > 0 ? [...ppList, tdPos] : [tdPos];
  const pointDists = new Array(ppList.length);
  let cumDist = 0;
  for (let i = fullPathPoints.length - 2; i >= 0; i--) {
    cumDist += _vec3Dist(fullPathPoints[i], fullPathPoints[i + 1]);
    pointDists[i] = cumDist;
  }

  if (ppList.length > 0) {
    const pts = ppList.map((p, i) => {
      const pY = Math.min(approachCap, pointDists[i] * TAN_3_DEG);
      // TEMP: hardcode Y=0 — original game files store PathPointList points with Y=0
      // (flat XZ plane). The game computes altitude internally from the glideslope.
      // Non-zero Y values differ from the game's expected format.
      return `${i === 0 ? '' : ',\n'}{"$type": ${nsVec3}, ${p.x}, 0, ${p.z}}`; // TEMP: 0 instead of ${pY}
    }).join('');
    pathPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": ${ppList.length},\n"$rcontent": [\n${pts}\n]\n}`;
  } else {
    pathPointsStr = `{\n"$id": ${id++},\n"$type": ${nsListVec3},\n"$rlength": 0,\n"$rcontent": []\n}`;
  }

  // Build DockingPositions
  let dockStr = '';
  const dp = spec.DockingPositions || [];
  console.log(
    '[APPROACH State=5] DockingPositions spec=' + spec.Designator +
    ' dpLen=' + dp.length +
    ' T.vec4=' + T.vec4 +
    ' dp=' + JSON.stringify(dp)
  );
  if (dp.length > 0) {
    const dpts = dp.map((d, i) => `${i === 0 ? '' : ',\n'}{"$type": ${T.vec4}, ${d.x}, ${d.y}, ${d.z}, ${d.w}}`).join('');
    dockStr = `{\n"$id": ${id++},\n"$type": ${T.dockArr},\n"$rlength": ${dp.length},\n"$rcontent": [\n${dpts}\n]\n}`;
  } else {
    dockStr = `{\n"$id": ${id++},\n"$type": ${T.dockArr},\n"$rlength": 0,\n"$rcontent": []\n}`;
  }

  // Position: interpolate along the full path (STAR FlyApproach → PathPointList → TouchDown).
  // flyPoints = STAR FlyApproach path (ending at IAF)
  // ppList = approach procedure PathPointList (starting at IAF)
  // tdPos = runway touchdown threshold
  //
  // Deduplicate the IAF join: if the last STAR flyPoint is very close to the
  // first PathPointList point, trim the duplicate to avoid a zero-length segment.
  const dedupedFlyPoints = _dedupeIafJoin(flyPoints, ppList);
  const posFullPath = buildFullPath(dedupedFlyPoints, ppList, tdPos);
  const posPR = fullPR != null ? fullPR : 0;
  const totalPathLen = computePathLength(posFullPath);
  const targetDist = totalPathLen * Math.max(0, Math.min(1, posPR));
  const pos = _interpolateAlongPath(posFullPath, targetDist);
  // Y from 3° ILS glideslope using REMAINING PATH DISTANCE to touchdown.
  const remainingPathDist = totalPathLen - targetDist;
  const glideY = remainingPathDist * TAN_3_DEG;
  pos.y = Math.min(approachCap, glideY);


  // Direction: path tangent at current position along the full path.
  // The tangent naturally converges to the runway heading at touchdown but
  // follows the approach path through turns before that (e.g., SIE.CAMRM5→13L).
  const dir = _tangentAlongPath(posFullPath, targetDist);

  const block = `{
    "$id": ${id++},
    "$type": ${T.ac},
    "Guid": "${guid}",
    "Enabled": true,
    "State": 5,
    "Specification": {
      "$id": ${id++},
      "$type": ${T.spec},
      "Guid": null,
      "Enabled": false,
      "Designator": "${spec.Designator}",
      "AerodromeCode": ${spec.AerodromeCode},
      "WakeTurbulenceCategory": ${spec.WakeTurbulenceCategory},
      "WheelBase": ${spec.WheelBase},
      "ModelOffset": ${fmtFloat3(spec.ModelOffset)},
      "WingSpan": ${spec.WingSpan},
      "DockingPositions": ${dockStr},
      "RunwayVRSpeed": ${spec.RunwayVRSpeed},
      "RunwayTakeOffLength": ${spec.RunwayTakeOffLength}
    },
    "Direction": ${fmtV3(dir)},
    "DynamicInternalState": {
      "$type": ${T.dyn},
      "DynamicsState": 2,
      "TaxiSpeed": 240,
      "ForwardSpeed": true,
      "TargetTaxiSpeed": 240,
      "PositiveTaxiAcceleration": 1,
      "NegativeTaxiAcceleration": -2,
      "TaxiArrivalToSpotPath": null,
      "TaxiArrivalToHoldingPointPath": null,
      "FrontWheelSteeringAngle": 0,
      "DynamicsParams": {
        "$id": ${id++},
        "$type": ${T.approachDyn},
        "ProgressRatio": 0,
        "TouchDownPosition": ${fmtV3(state5Params.touchDownPosition || { x:0, z:0 })},
        "ApproachDirection": ${fmtV3(state5Params.approachDirection || { x:0, z:-1 })},
        "CommandedGoAround": false,
        "InitialPosition": {
          "$type": ${nsVec3},
          ${ppList.length > 0 ? ppList[0].x : 0},
          ${ppList.length > 0 ? Math.min(approachCap, pointDists[0] * TAN_3_DEG) : approachCap},
          ${ppList.length > 0 ? ppList[0].z : 0}
        },
        "PathPointList": ${pathPointsStr}
      }
    },
    "AircraftRunwayCoordinateState": {
      "$id": ${id++},
      "$type": ${T.acRwy},
      "Guid": null,
      "Enabled": false,
      "TaxiPathUnPassedIntersectionRunwayNames": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "TaxiBlockingRunwayNames": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwayFenceCurrentEnterRunways": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwayGuardCurrentEnterRunways": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "CrossRunwayPermissions": { "$id": ${id++}, "$type": ${nsStrArr}, "$rlength": 0, "$rcontent": [] },
      "RunwaySetterIdx": 0
    },
    "FlightPlanGuid": "${flightPlanGuid}",
    "ActiveFlightDirection": 1,
    "Position": {
      "$type": ${nsVec3},
      ${pos.x},
      ${pos.y},
      ${pos.z}
    },
    "RadioChannelGuid": "${towerChannelGuid}",
    "JurisdictionRadioChannelGuid": "${towerChannelGuid}",
    "TaxiPathStartingPosition": { "$type": ${nsVec3}, 0, 0, 0 },
    "TaxiPath": null,
    "RollingPresetTaxiPathStartingPosition": { "$type": ${nsVec3}, 0, 0, 0 },
    "RollingPresetTaxiPath": null,
    "SelectedRunwayEntryIndex": -1,
    "SelectedRunwayEntryRunwayGuid": null,
    "SelectedRunwayExitIndex": ${selectedRunwayExitIndex},
    "SelectedTaxiPushBackNodeGuid": null,
    "SelectedTowNavigationPointGuid": null,
    "IsFirstTaxi": false,
    "WaitingForCommands": {
      "$id": ${id++},
      "$type": ${T.waitCmd},
      "$rlength": ${waitingForCommand === 0 ? 0 : 1},
      "$rcontent": [${waitingForCommand === 0 ? '' : waitingForCommand}]
    },
    "ReceivedEvents": {
      "$id": ${id++},
      "$type": ${T.recvEvt},
      "$rlength": 0,
      "$rcontent": []
    },
    "Route": "${route}"
  }`;

  return {
    guid,
    block,
    nextId: id,
  };
}

// ─── 9. Designator Mapping ────────────────────────────────────────

/**
 * Build AircraftType (full name) → Designator (ICAO code) mapping.
 * Cross-references FlightPlans with AircraftStates in ACL text.
 * Returns Map<string, string> e.g., "BOEING 737-800" → "B738".
 */
function buildDesignatorMapping(aclText) {
  const map = new Map();

  // ── v4: cross-reference StaticItems and RuntimeEntities ──────────
  // Step 1: Scan StaticItems for flight-plan entries → (Registration, AircraftType, Stand)
  const regToType = new Map();   // Registration → AircraftType
  const standToType = new Map(); // Stand (e.g. "it4-38") → AircraftType
  const siIdx = aclText.indexOf('"StaticItems"');
  if (siIdx >= 0) {
    const afterSi = aclText.substring(siIdx);
    const rcMatch = afterSi.match(/"\$rcontent"\s*:\s*\[/);
    if (rcMatch) {
      const absRc = siIdx + rcMatch.index + rcMatch[0].length;
      const endPos = _findArrayEnd(aclText, absRc);
      if (endPos) {
        const arr = aclText.substring(absRc, endPos);
        let depth = 0, start = -1;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === '{') { if (depth === 0) start = i; depth++; }
          else if (arr[i] === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
              const block = arr.substring(start, i + 1);
              const vBlock = _extractValueBlock(block);
              if (vBlock && vBlock[0] === '{') {
                const reg = _extractString(vBlock, 'Registration');
                const at = _extractString(vBlock, 'AircraftType');
                if (reg && at) regToType.set(reg, at);
                const stand = _extractString(vBlock, 'Stand');
                if (stand && at) {
                  // Register alias forms of the stand so Pass B's exact
                  // jetway-key lookup resolves regardless of format:
                  // flight plans say "31" while jetway keys are "31A"/"31B",
                  // or "07" vs "7". First-registered wins per alias.
                  const aliases = new Set([stand]);
                  const baseNum = parseInt(stand, 10);
                  if (!Number.isNaN(baseNum)) {
                    const base = String(baseNum);
                    const padded = base.padStart(2, '0');
                    aliases.add(base);
                    aliases.add(padded);
                    aliases.add(base + 'A');
                    aliases.add(base + 'B');
                    aliases.add(padded + 'A');
                    aliases.add(padded + 'B');
                  }
                  for (const alias of aliases) {
                    if (!standToType.has(alias)) standToType.set(alias, at);
                  }
                }
              }
              start = -1;
            }
          }
        }
      }
    }
  }

  if (regToType.size === 0) return map;

  // Step 2: Scan RuntimeEntities for aircraft and jetway entries → Designator
  const reIdx = aclText.indexOf('"RuntimeEntities"');
  if (reIdx >= 0) {
    const afterRe = aclText.substring(reIdx);
    const rcMatch = afterRe.match(/"\$rcontent"\s*:\s*\[/);
    if (rcMatch) {
      const absRc = reIdx + rcMatch.index + rcMatch[0].length;
      const endPos = _findArrayEnd(aclText, absRc);
      if (endPos) {
        const arr = aclText.substring(absRc, endPos);
        let depth = 0, start = -1;

        // Pass A: aircraft entries with inline $v → Designator
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === '{') { if (depth === 0) start = i; depth++; }
          else if (arr[i] === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
              const block = arr.substring(start, i + 1);
              const kMatch = block.match(/"\$k"\s*:\s*"aircraft:([^"]+)"/);
              if (kMatch) {
                const reg = kMatch[1];
                const at = regToType.get(reg);
                if (at && !map.has(at)) {
                  const vBlock = _extractValueBlock(block);
                  if (vBlock && vBlock[0] === '{') {
                    const specObj = _extractNestedObject(vBlock, 'Specification');
                    const designator = specObj ? _extractString(specObj, 'Designator') : null;
                    if (designator) map.set(at, designator);
                  }
                }
              }
              start = -1;
            }
          }
        }

        // Pass B: jetway entries with DockingAircraft → link via stand
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === '{') { if (depth === 0) start = i; depth++; }
          else if (arr[i] === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
              const block = arr.substring(start, i + 1);
              const kMatch = block.match(/"\$k"\s*:\s*"jetway:([^"]+)"/);
              if (kMatch) {
                const stand = kMatch[1];
                const at = standToType.get(stand);
                if (at && !map.has(at)) {
                  const vBlock = _extractValueBlock(block);
                  if (vBlock && vBlock[0] === '{') {
                    const daObj = _extractNestedObject(vBlock, 'DockingAircraft');
                    if (daObj) {
                      const specObj = _extractNestedObject(daObj, 'Specification');
                      const designator = specObj ? _extractString(specObj, 'Designator') : null;
                      if (designator) map.set(at, designator);
                    }
                  }
                }
              }
              start = -1;
            }
          }
        }
      }
    }
  }
  return map;
}

// ─── 9c. Type Map Extraction ──────────────────────────────────────

/**
 * Extract the type number → type name map from an ACL file.
 * Unity's JSON serializer assigns type numbers per-file sequentially — they are
 * NOT consistent across airports or even levels of the same airport. This function
 * captures ALL fully-qualified $type declarations so they can be preserved during
 * save, preventing type numbering drift.
 *
 * @param {string} aclText - raw ACL file content
 * @returns {Map<number, string>} type number → fully-qualified type name
 */
function extractTypeMap(aclText) {
  const typeMap = new Map();
  const typeDeclRegex = /"\$type":\s*"(\d+)\|([^"]+)"/g;
  let m;
  while ((m = typeDeclRegex.exec(aclText)) !== null) {
    const num = parseInt(m[1], 10);
    // First declaration wins — earliest in file is canonical
    if (!typeMap.has(num)) {
      typeMap.set(num, m[2]);
    }
  }
  return typeMap;
}

/**
 * Invert a Map<id, name> to a Map<name, id> (exact type name → type number).
 * First declaration wins (consistent with extractTypeMap's policy).
 * Exported so flight_plans.js and dynamics.js can use it for cache lookups.
 * @param {Map<number, string>} typeMap
 * @returns {Map<string, number>}
 */
function buildTypeNameIndex(typeMap) {
  const idx = new Map();
  for (const [id, name] of typeMap) {
    if (!idx.has(name)) idx.set(name, id);
  }
  return idx;
}

// ─── 9c. STAR Path Visualization Data ──────────────────────────────

/**
 * Build STAR path visualization data from appPointMap + SceneryData.
 * Groups appPointMap entries by STAR name, resolves full flight paths
 * (fly approach + app points) for each (STAR, runway) combo.
 *
 * Reuses resolveFlyApproachPoints() and buildFullPath() — the same
 * path-resolution functions used by computePosition() for approach aircraft.
 *
 * @param {string} aclText - raw ACL text containing SceneryData
 * @param {Map<string, Vector3[]>} appPointMap - Map<"STAR|Runway", Vector3[]> (may be null/empty)
 * @param {Object<string, string[]>} [starRunwayMap] - { starName → [runway, ...] } from SceneryData
 * @returns {{[starName: string]: Array<{runway: string, points: Vector3[]}>}}
 */
function buildStarPaths(aclText, appPointMap, starRunwayMap) {
  if (!aclText) return {};

  const starPaths = {};

  // ── Pass 1: appPointMap-driven paths (from State=30 aircraft) ──
  if (appPointMap && appPointMap.size > 0) {
    // Group appPointMap entries by STAR name
    const starGroups = new Map(); // starName -> [{runway, appPoints}]
    for (const [key, points] of appPointMap) {
      const pipeIdx = key.lastIndexOf('|');
      if (pipeIdx === -1) continue;
      const route = key.substring(0, pipeIdx);
      const runway = key.substring(pipeIdx + 1);
      if (!route || !runway) continue;
      if (!starGroups.has(route)) starGroups.set(route, []);
      starGroups.get(route).push({ runway, appPoints: points });
    }

    for (const [route, entries] of starGroups) {
      const routePaths = [];
      for (const { runway, appPoints } of entries) {
        // Resolve fly approach points from SceneryData AirwayNodes
        const flyPoints = resolveFlyApproachPoints(aclText, route, runway);
        // Build full path: fly approach + final approach points
        const fullPath = buildFullPath(flyPoints, appPoints, null);
        if (fullPath.length >= 2) {
          routePaths.push({ runway, points: fullPath });
        } else if (appPoints.length >= 2) {
          // Fallback: use appPoints alone if fly points couldn't be resolved
          routePaths.push({ runway, points: appPoints });
        }
      }
      if (routePaths.length > 0) {
        starPaths[route] = routePaths;
      }
    }
  }

  // ── Pass 2: starRunwayMap-driven paths (from SceneryData Routes Type=0) ──
  if (starRunwayMap) {
    for (const [starName, runways] of Object.entries(starRunwayMap)) {
      const existingRunways = new Set(
        (starPaths[starName] || []).map(v => v.runway)
      );
      for (const runway of runways) {
        if (existingRunways.has(runway)) continue;
        const flyPoints = resolveFlyApproachPoints(aclText, starName, runway);
        if (flyPoints.length >= 2) {
          if (!starPaths[starName]) starPaths[starName] = [];
          starPaths[starName].push({ runway, points: flyPoints });
        }
      }
    }
  }

  return starPaths;
}

// ─── 10. Approach Cache Builder ────────────────────────────────────

/**
 * Scan all production .acl files for an airport and build the approach cache.
 * @param {string} airportDir - path to .../Airports/<ICAO>/Levels/
 * @returns {{specDB: Map, appPointMap: Map, totalApproachTimes: Map, designatorMap: Map, typeMap: Map}}
 */
function buildApproachCache(airportDir, progressCallback) {
  const fs = require('fs');
  const path = require('path');
  const log = (msg) => console.log('[APPROACH-CACHE]', msg);

  // Find all .acl files (exclude .acl.bak + RE_HIDDEN patterns: tutorial, bench, test, crossrunway, dev, endless, .prod)
  const RE_SKIP = /tutorial|bench|test|crossrunway|dev|endless|\.prod/i;
  let aclFiles = [];
  try {
    const files = fs.readdirSync(airportDir);
    aclFiles = files
      .filter(f => f.endsWith('.acl') && !RE_SKIP.test(f))
      .map(f => path.join(airportDir, f));
  } catch (_) { return null; }

  if (aclFiles.length === 0) {
    log('WARNING: no .acl files found in ' + airportDir);
    return null;
  }

  log('Scanning ' + aclFiles.length + ' production files...');

  // Collect all approach entries from all files
  const allEntries = [];
  let specDB = new Map();
  let designatorMap = new Map();
  const typeMap = new Map(); // per-airport: type_number → type_name
  const fileTypeMaps = new Map(); // per-file: basename → Map<number, string>
  let firstAclText = null;

  const { parseTaxiwayPaths } = require('./taxiway');
  const seenTaxiwayKeys = new Set();
  const mergedTaxiwayPaths = [];

  const total = aclFiles.length;
  for (let i = 0; i < aclFiles.length; i++) {
    const aclPath = aclFiles[i];
    if (progressCallback) {
      progressCallback({ current: i + 1, total, fileName: path.basename(aclPath) });
    }
    try {
      const text = readAclText(aclPath);
      if (!firstAclText) {
        firstAclText = text;
      }

      // ── Taxiway paths: parse from every file, merge with dedup ──
      try {
        const twResult = parseTaxiwayPaths(text);
        for (const tp of twResult.paths) {
          const key = (tp.name || '') + '|' + tp.points.map(p =>
            `${p.x.toFixed(2)},${(p.z !== undefined ? p.z : 0).toFixed(2)}`
          ).join('|');
          if (!seenTaxiwayKeys.has(key)) {
            seenTaxiwayKeys.add(key);
            mergedTaxiwayPaths.push(tp);
          }
        }
      } catch (_) { /* skip taxiway parse errors */ }

      const entries = extractApproachData(text);
      for (const e of entries) e._file = path.basename(aclPath);
      allEntries.push(...entries);

      // Merge specDB from each file
      const fileSpecs = extractSpecificationDB(text, path.basename(aclPath));
      for (const [k, v] of fileSpecs) {
        if (!specDB.has(k)) specDB.set(k, v);
      }

      // Designator mapping from each file
      const dm = buildDesignatorMapping(text);
      for (const [k, v] of dm) designatorMap.set(k, v);

      // Type map from each file
      const fileTypeMap = extractTypeMap(text);
      for (const [k, v] of fileTypeMap) {
        if (!typeMap.has(k)) typeMap.set(k, v);
      }

      fileTypeMaps.set(path.basename(aclPath), fileTypeMap);

      log('  ' + path.basename(aclPath) + ': ' + entries.length + ' approach a/c, ' + fileSpecs.size + ' specs, ' + fileTypeMap.size + ' types');
    } catch (e) {
      log('  SKIP ' + path.basename(aclPath) + ': ' + e.message);
    }
  }

  if (allEntries.length === 0) {
    log('WARNING: no approach aircraft found in any file');
    // Don't return null — SceneryData-derived data (starRunwayMap, runwayThresholds,
    // taxiwayPaths, sidPaths, state5ParamsMap, etc.) is still extractable even without
    // State=30 aircraft. Airports with zero aircraft entries (e.g., KDCA smoke test)
    // still need map data for GroundMapWindow/AirMapWindow.
    if (!firstAclText) {
      log('WARNING: no ACL text available — returning null');
      return null;
    }
    log('Building SceneryData-only cache (no aircraft-derived data)');
  }

  // ── Derive path data from SceneryData (NOT from Aircraft section) ──

  // Extract authoritative STAR↔runway mappings from SceneryData.
  // This captures ALL valid combos (not just those with State=30 aircraft).
  const starMappings = firstAclText
    ? extractStarRunwayMappings(firstAclText)
    : { starRunwayMap: {}, runwayStarMap: {} };

  // Build state5ParamsMap from SceneryData for all runways.
  // No dependency on State=5 aircraft — touchDownPosition, approachDirection,
  // pathPointList, and initialPosition all come from the scenery's approach procedures.
  // For runways with multiple Type=1 variants (e.g. ZSJN 01 has three
  // "RNAV ILS Z Rwy 01" variants), the first variant is stored under the
  // runway-only key as fallback. STAR-specific keys ("STAR|runway") are
  // added below in the appPointMap loop with variant-correct data.
  const state5ParamsMap = new Map();
  if (firstAclText && starMappings.runwayStarMap) {
    for (const runway of Object.keys(starMappings.runwayStarMap)) {
      const data = resolveApproachProcedureData(firstAclText, runway, undefined);
      if (data) {
        state5ParamsMap.set(runway, data);
        const normalized = _normalizeRunway(runway);
        if (normalized !== runway && !state5ParamsMap.has(normalized)) {
          state5ParamsMap.set(normalized, data);
        }
      }
    }
  }

  // Build appPointMap from SceneryData (Type=1 approach procedure routes).
  // Each STAR gets the approach procedure variant whose first AirwayNode is
  // closest to the STAR's last FlyApproach point — resolving the correct
  // variant when multiple "RNAV ILS Z Rwy XX" entries exist.
  const appPointMap = new Map();
  for (const [runway, stars] of Object.entries(starMappings.runwayStarMap)) {
    for (const star of stars) {
      // Resolve FlyApproach points to find the STAR's exit (IAF) point
      const flyPoints = resolveFlyApproachPoints(firstAclText, star, runway);
      const hintPos = (flyPoints && flyPoints.length > 0)
        ? flyPoints[flyPoints.length - 1]
        : null;

      // Get variant-correct approach procedure data for this STAR
      const s5 = resolveApproachProcedureData(firstAclText, runway, hintPos);
      if (!s5 || !s5.pathPointList || s5.pathPointList.length < 2) continue;

      appPointMap.set(star + '|' + runway, s5.pathPointList);

      // Also store STAR-specific state5Params entry for State=5 generation
      const s5Key = star + '|' + runway;
      if (!state5ParamsMap.has(s5Key)) {
        state5ParamsMap.set(s5Key, s5);
      }
    }
    // Also register normalized runway variant (e.g. "1" for "01")
    const normRunway = _normalizeRunway(runway);
    if (normRunway !== runway) {
      for (const star of stars) {
        const flyPoints = resolveFlyApproachPoints(firstAclText, star, normRunway);
        const hintPos = (flyPoints && flyPoints.length > 0)
          ? flyPoints[flyPoints.length - 1]
          : null;
        const s5n = resolveApproachProcedureData(firstAclText, normRunway, hintPos);
        if (!s5n || !s5n.pathPointList) continue;
        const key = star + '|' + normRunway;
        if (!appPointMap.has(key)) appPointMap.set(key, s5n.pathPointList);
        const s5Key = star + '|' + normRunway;
        if (!state5ParamsMap.has(s5Key)) {
          state5ParamsMap.set(s5Key, s5n);
        }
      }
    }
  }

  // Build starPaths from appPointMap and starRunwayMap.
  // Pass 1 uses appPointMap (now SceneryData-derived, covers all STARs).
  // Pass 2 uses starRunwayMap to add any STARs still missing (FlyApproach-only).
  const starPaths = firstAclText
    ? buildStarPaths(firstAclText, appPointMap, starMappings.starRunwayMap)
    : {};
  const runwayThresholds = firstAclText
    ? _parseRunwayThresholds(firstAclText)
    : {};

  // ── Taxiway paths (already merged from all files in main loop above) ──
  const taxiwayPaths = { paths: mergedTaxiwayPaths };
  if (mergedTaxiwayPaths.length > 0) {
    log('  taxiway paths: ' + mergedTaxiwayPaths.length + ' segments merged from ' + aclFiles.length + ' files');
  }

  // ── Parse SID + Missed Approach routes from SceneryData ──
  let sidRunwayMap = {};
  let runwaySidMap = {};
  let missedAppMap = {};
  let runwayMissedAppMap = {};
  let sidPaths = {};
  let missedAppPaths = {};
  if (firstAclText) {
    try {
      const { extractSidRunwayMappings, extractMissedApproachMappings, buildSidPaths, buildMissedApproachPaths } = require('./sid_goaround');
      const sidMappings = extractSidRunwayMappings(firstAclText);
      sidRunwayMap = sidMappings.sidRunwayMap || {};
      runwaySidMap = sidMappings.runwaySidMap || {};
      const maMappings = extractMissedApproachMappings(firstAclText);
      missedAppMap = maMappings.missedAppMap || {};
      runwayMissedAppMap = maMappings.runwayMissedAppMap || {};
      sidPaths = buildSidPaths(firstAclText, sidRunwayMap);
      missedAppPaths = buildMissedApproachPaths(firstAclText, missedAppMap);
    } catch (e) { log('  SID/go-around parse warning: ' + e.message); }
  }

  // ── Parse APPR (RNAV approach) routes from SceneryData (Type=1) ──
  let apprRunwayMap = {};
  let runwayApprMap = {};
  let apprPaths = {};
  if (firstAclText) {
    try {
      const { extractApprRunwayMappings, buildApprPaths } = require('./sid_goaround');
      const apprMappings = extractApprRunwayMappings(firstAclText);
      apprRunwayMap = apprMappings.apprRunwayMap || {};
      runwayApprMap = apprMappings.runwayApprMap || {};
      apprPaths = buildApprPaths(firstAclText, apprRunwayMap);
    } catch (e) { log('  APPR path parse warning: ' + e.message); }
  }

  // Compute per-airport coordinate scale from runway threshold geometry
  const airportScale = firstAclText
    ? computeAirportScale(firstAclText)
    : DEFAULT_AIRPORT_SCALE;

  // Compute totalApproachTimes from SceneryData path-length estimates.
  // Uses physics-based formula: TAT = totalGamePath × airportScale / 240kts
  // with ratio estimation from reference STARs on the same runway where available.
  const totalApproachTimes = computeApproachTimesFromScenery(
    firstAclText, starMappings, appPointMap, null, DEFAULT_TAT, airportScale
  );

  // Compute per-file saveTime offsets from approach entries.
  // saveTime = LandingTime - (1 - PR) * totalApproachTime  → seconds since midnight
  const saveTimeOffsets = new Map(); // filename -> saveSec
  const fileGroups = new Map();
  for (const e of allEntries) {
    if (!e._file) continue;
    if (!fileGroups.has(e._file)) fileGroups.set(e._file, []);
    fileGroups.get(e._file).push(e);
  }
  const _toSec = (t) => { const p = String(t).split(':'); return +p[0]*3600 + +p[1]*60 + (+p[2]||0); };
  for (const [filename, entries] of fileGroups) {
    const offsets = [];
    for (const e of entries) {
      const tat = totalApproachTimes.get(e.route) || DEFAULT_TAT;
      const lt = e.landingTimeTicks;
      if (!lt || lt === 0) continue;
      const baseTicks = Math.floor(lt / 864000000000) * 864000000000;
      const ltSec = (lt - baseTicks) / 10000000;
      const saveSec = ltSec - (1 - e.progressRatio) * tat;
      offsets.push(saveSec);
    }
    if (offsets.length > 0) {
      offsets.sort((a, b) => a - b);
      saveTimeOffsets.set(filename, Math.round(offsets[Math.floor(offsets.length / 2)]));
    }
  }

  log('Done: ' + specDB.size + ' specs, ' + appPointMap.size + ' route combos, ' +
      totalApproachTimes.size + ' routes, ' + designatorMap.size + ' type mappings, ' +
      saveTimeOffsets.size + ' file saveTime offsets, ' + typeMap.size + ' type declarations, ' +
      fileTypeMaps.size + ' file typeMaps, ' + state5ParamsMap.size + ' state5 route combos, ' +
      Object.keys(starPaths).length + ' star paths (' +
      Object.keys(starMappings.starRunwayMap).length + ' STARs from SceneryData), ' +
      taxiwayPaths.paths.length + ' taxiway paths, ' +
      Object.keys(sidPaths).length + ' SID paths, ' +
      Object.keys(missedAppPaths).length + ' missed approach paths, ' +
      Object.keys(apprPaths).length + ' APPR paths, ' +
      'airportScale=' + (airportScale ? airportScale.toFixed(1) : 'N/A') + ', ' +
      Object.keys(runwayThresholds).length + ' runways');

  // Clean up _file property from entries
  for (const e of allEntries) delete e._file;

  // Build name→id indexes (reverse of id→name typeMap/fileTypeMaps)
  const typeNameIndex = buildTypeNameIndex(typeMap);
  const fileTypeNameIndexes = new Map();
  for (const [fn, ftm] of fileTypeMaps) {
    fileTypeNameIndexes.set(fn, buildTypeNameIndex(ftm));
  }

  return {
    specDB, appPointMap, totalApproachTimes, designatorMap,
    saveTimeOffsets, typeMap, typeNameIndex, fileTypeMaps, fileTypeNameIndexes, state5ParamsMap,
    starPaths, runwayThresholds, airportScale,
    starRunwayMap: starMappings.starRunwayMap,
    runwayStarMap: starMappings.runwayStarMap,
    taxiwayPaths,
    sidRunwayMap, runwaySidMap, sidPaths,
    missedAppMap, runwayMissedAppMap, missedAppPaths,
    apprRunwayMap, runwayApprMap, apprPaths,
  };
}

// ─── 9b. AircraftAnimators Block Builder ──────────────────────────

function buildAnimatorBlock(aircraftGuid, opts) {
  const { nextId = 80000, typeNums = null, gearRatio = 1 } = opts || {};
  const tn = typeNums || {};
  const resolve = (key, fullName) => {
    const id = tn[key];
    if (id == null) {
      throw new Error(
        `[APPROACH] buildAnimatorBlock: missing typeNum "${key}" = "${fullName}, GroundATC.Core".\n` +
        `  Provided keys: ${Object.keys(tn).join(', ') || '(none)'}`
      );
    }
    return `"${id}|${fullName}, GroundATC.Core"`;
  };
  const animType = resolve('animState', 'ContextCross.States.AircraftAnimatorState');
  const stateType = resolve('animSubState', 'ContextCross.States.AircraftAnimState');
  let id = nextId;

  const block = `{
    "$id": ${id++},
    "$type": ${animType},
    "Guid": "ac_anim::${aircraftGuid}",
    "Enabled": true,
    "AircraftGuid": "${aircraftGuid}",
    "AnimState": {
      "$id": ${id++},
      "$type": ${stateType},
      "Version": 2,
      "HasSnapshot": true,
      "FlapRatio": 0.5,
      "SlatRatio": 0.75,
      "GearRatio": ${gearRatio},
      "IsGearMoving": false,
      "GearTargetRatio": ${gearRatio},
      "GoAroundPhase": 0,
      "HasGoAroundCommandTick": false,
      "GoAroundCommandTick": 0,
      "GearRetractIssued": false
    }
  }`;

  return { guid: 'ac_anim::' + aircraftGuid, block, nextId: id };
}

// ─── 10b. Extract GameTime from ACL text ──────────────────────────

function extractGameTime(aclText) {
  // Use tokenizer to find GameTime section, then pre-processor + JSON.parse
  const t = createTokenizer(aclText);
  const gtSec = t.findSection('GameTime');
  if (!gtSec) return null;

  const gtText = t.substring(gtSec.valueStart, gtSec.valueEnd);
  try {
    const cleaned = preprocessUnityJson(gtText);
    const parsed = JSON.parse(cleaned);
    const cdt = parsed.CurrentDateTime;
    if (cdt && cdt.__v && cdt.__v.length > 0) {
      const ticks = BigInt(cdt.__v[0]);
      const baseTicks = (ticks / 864000000000n) * 864000000000n;
      return Number((ticks - baseTicks) / 10000000n);
    }
  } catch (_) {
    // Fallback to regex
  }

  // Fallback: regex extraction
  const gtIdx = aclText.indexOf('"GameTime"');
  if (gtIdx < 0) return null;
  const sub = aclText.substring(gtIdx, gtIdx + 2000);
  const cdtMatch = sub.match(/"CurrentDateTime"[\s\S]{0,200}?"\$type":\s*(?:"\d+\|[^"]*"|\d+)\s*,\s*(-?\d+)/);
  if (!cdtMatch) return null;
  const ticks = parseInt(cdtMatch[1]);
  const baseTicks = Math.floor(ticks / 864000000000) * 864000000000;
  return Math.round((ticks - baseTicks) / 10000000); // seconds since midnight
}

// ─── 10c. Extract saveTime from ACL approach entries ──────────────

function extractSaveTime(aclText, totalApproachTimes) {
  // v4: use MetaData.BaseTime instead (handled by extractCurrentDateTime)
  return null;
}

// ─── 11. Cache Serialization ──────────────────────────────────────

/**
 * Serialize approach cache to JSON-safe plain objects.
 * Converts Map objects to plain { key: value } for disk storage.
 */
function serializeApproachCache(cache) {
  if (!cache) return null;
  const out = {};
  if (cache.specDB) { out.specDB = {}; for (const [k, v] of cache.specDB) out.specDB[k] = v; }
  if (cache.designatorMap) { out.designatorMap = {}; for (const [k, v] of cache.designatorMap) out.designatorMap[k] = v; }
  if (cache.saveTimeOffsets) { out.saveTimeOffsets = {}; for (const [k, v] of cache.saveTimeOffsets) out.saveTimeOffsets[k] = v; }
  if (cache.typeMap) { out.typeMap = {}; for (const [k, v] of cache.typeMap) out.typeMap[String(k)] = v; }
  if (cache.fileTypeMaps) { out.fileTypeMaps = {}; for (const [fileName, tm] of cache.fileTypeMaps) { const obj = {}; for (const [k, v] of tm) obj[String(k)] = v; out.fileTypeMaps[fileName] = obj; } }
  if (cache.totalApproachTimes) { out.totalApproachTimes = {}; for (const [k, v] of cache.totalApproachTimes) out.totalApproachTimes[k] = v; }
  if (cache.appPointMap) { out.appPointMap = {}; for (const [k, v] of cache.appPointMap) out.appPointMap[k] = v; }
  if (cache.state5ParamsMap) { out.state5ParamsMap = {}; for (const [k, v] of cache.state5ParamsMap) out.state5ParamsMap[k] = v; }
  if (cache.starPaths) { out.starPaths = cache.starPaths; }
  if (cache.runwayThresholds) { out.runwayThresholds = cache.runwayThresholds; }
  if (cache.airportScale != null) { out.airportScale = cache.airportScale; }
  if (cache.starRunwayMap) { out.starRunwayMap = cache.starRunwayMap; }
  if (cache.runwayStarMap) { out.runwayStarMap = cache.runwayStarMap; }
  if (cache.taxiwayPaths) { out.taxiwayPaths = cache.taxiwayPaths; }
  if (cache.sidRunwayMap) { out.sidRunwayMap = cache.sidRunwayMap; }
  if (cache.runwaySidMap) { out.runwaySidMap = cache.runwaySidMap; }
  if (cache.sidPaths) { out.sidPaths = cache.sidPaths; }
  if (cache.missedAppMap) { out.missedAppMap = cache.missedAppMap; }
  if (cache.runwayMissedAppMap) { out.runwayMissedAppMap = cache.runwayMissedAppMap; }
  if (cache.missedAppPaths) { out.missedAppPaths = cache.missedAppPaths; }
  if (cache.apprPaths) { out.apprPaths = cache.apprPaths; }
  if (cache.apprRunwayMap) { out.apprRunwayMap = cache.apprRunwayMap; }
  if (cache.runwayApprMap) { out.runwayApprMap = cache.runwayApprMap; }
  return out;
}

/**
 * Deserialize approach cache from JSON.
 * Reconstructs Map objects from plain { key: value } objects.
 */
function deserializeApproachCache(json) {
  if (!json) return null;
  const cache = {};
  if (json.specDB && typeof json.specDB === 'object') { cache.specDB = new Map(Object.entries(json.specDB)); }
  if (json.designatorMap && typeof json.designatorMap === 'object') { cache.designatorMap = new Map(Object.entries(json.designatorMap)); }
  if (json.saveTimeOffsets && typeof json.saveTimeOffsets === 'object') { cache.saveTimeOffsets = new Map(Object.entries(json.saveTimeOffsets)); }
  if (json.typeMap && typeof json.typeMap === 'object') { cache.typeMap = new Map(Object.entries(json.typeMap).map(([k, v]) => [parseInt(k, 10), v])); }
  if (json.fileTypeMaps && typeof json.fileTypeMaps === 'object') { cache.fileTypeMaps = new Map(Object.entries(json.fileTypeMaps).map(([name, obj]) => [name, new Map(Object.entries(obj).map(([k, v]) => [parseInt(k, 10), v]))])); }
  if (json.totalApproachTimes && typeof json.totalApproachTimes === 'object') { cache.totalApproachTimes = new Map(Object.entries(json.totalApproachTimes)); }
  if (json.appPointMap && typeof json.appPointMap === 'object') { cache.appPointMap = new Map(Object.entries(json.appPointMap)); }
  if (json.state5ParamsMap && typeof json.state5ParamsMap === 'object') { cache.state5ParamsMap = new Map(Object.entries(json.state5ParamsMap)); }
  if (json.starPaths && typeof json.starPaths === 'object') { cache.starPaths = json.starPaths; }
  if (json.runwayThresholds && typeof json.runwayThresholds === 'object') { cache.runwayThresholds = json.runwayThresholds; }
  if (json.airportScale != null && typeof json.airportScale === 'number') { cache.airportScale = json.airportScale; }
  if (json.starRunwayMap && typeof json.starRunwayMap === 'object') { cache.starRunwayMap = json.starRunwayMap; }
  if (json.runwayStarMap && typeof json.runwayStarMap === 'object') { cache.runwayStarMap = json.runwayStarMap; }
  if (json.taxiwayPaths && typeof json.taxiwayPaths === 'object') { cache.taxiwayPaths = json.taxiwayPaths; }
  if (json.sidRunwayMap && typeof json.sidRunwayMap === 'object') { cache.sidRunwayMap = json.sidRunwayMap; }
  if (json.runwaySidMap && typeof json.runwaySidMap === 'object') { cache.runwaySidMap = json.runwaySidMap; }
  if (json.sidPaths && typeof json.sidPaths === 'object') { cache.sidPaths = json.sidPaths; }
  if (json.missedAppMap && typeof json.missedAppMap === 'object') { cache.missedAppMap = json.missedAppMap; }
  if (json.runwayMissedAppMap && typeof json.runwayMissedAppMap === 'object') { cache.runwayMissedAppMap = json.runwayMissedAppMap; }
  if (json.missedAppPaths && typeof json.missedAppPaths === 'object') { cache.missedAppPaths = json.missedAppPaths; }
  if (json.apprPaths && typeof json.apprPaths === 'object') { cache.apprPaths = json.apprPaths; }
  if (json.apprRunwayMap && typeof json.apprRunwayMap === 'object') { cache.apprRunwayMap = json.apprRunwayMap; }
  if (json.runwayApprMap && typeof json.runwayApprMap === 'object') { cache.runwayApprMap = json.runwayApprMap; }
  return cache;
}

// ─── Public API ──────────────────────────────────────────────────

module.exports = {
  // Data extraction
  requireSpecField,
  extractSpecificationDB,
  _extractFallbackSpec,
  extractApproachData,
  extractState5Data,
  extractTypeMap,
  buildAppPointMap,
  buildState5ParamsMap,

  // Path resolution
  resolveFlyApproachPoints,
  resolveApproachProcedureData,

  // Computation
  computeProgressRatio,
  computePosition,
  computeDirection,
  buildFullPath,
  computePathLength,
  computeApproachTimesFromScenery,
  computeAirportScale,
  computeApproachCap,
  computeFullTerminalPath,

  // Designator mapping & cache
  buildDesignatorMapping,
  buildApproachCache,
  buildTypeNameIndex,
  buildStarPaths,
  extractStarRunwayMappings,
  extractSaveTime,
  extractGameTime,
  serializeApproachCache,
  deserializeApproachCache,

  // Assembly
  buildApproachAircraftBlock,
  buildState5AircraftBlock,
  buildAnimatorBlock,

  // Utility
  _generateGuid,

  // Internal exports (for testing)
  _normalizeRunway,
  _vec3Sub, _vec3Add, _vec3Scale, _vec3Length, _vec3Normalize, _vec3Dist,
  _interpolateAlongPath, _tangentAlongPath,
  _findArrayEnd, _extractValueBlock, _extractNestedObject,
  _extractFloat, _extractInt, _extractString, _extractVector3, _extractVector3Array,
  _parseRunwayThresholds,
  _findRunwayGuid,
};
