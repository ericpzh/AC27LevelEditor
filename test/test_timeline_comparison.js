/**
 * Timeline Comparison Test
 *
 * Compares JSON timeline files against ACL-embedded timeline data.
 * Extracts WeatherFrames, WindFrames, and RunwayTimeline sections from the
 * ACL and compares each entry field-by-field against the JSON source.
 *
 * Usage: node test/test_timeline_comparison.js <path-to-.acl-file>
 *
 * Timeline JSON files are auto-discovered from the ACL's directory.
 */
const fs = require('fs');
const path = require('path');
const { ticksToTime } = require('../src/utils/timeUtils');

// ─── CLI ──────────────────────────────────────────────────────
if (process.argv.length < 3 || process.argv[2] === '--help' || process.argv[2] === '-h') {
  console.error('Usage: node test/test_timeline_comparison.js <path-to-.acl-file>');
  console.error('  Compares JSON timeline files against ACL-embedded timeline sections.');
  process.exit(process.argv[2] === '--help' || process.argv[2] === '-h' ? 0 : 1);
}

const aclPath = path.resolve(process.argv[2]);
if (!fs.existsSync(aclPath)) {
  console.error('ERROR: File not found: ' + aclPath);
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────

function check(condition, label) {
  if (condition) { console.log('  ✓ ' + label); return true; }
  else { console.log('  ✗ ' + label); return false; }
}

function normalizeKey(key) {
  if (!key) return '';
  const lower = key.toLowerCase().trim();
  const map = { preset: 'preset', time: 'time', direction: 'direction', speed: 'speed',
    gustspeed: 'gustSpeed', status: 'status', runways: 'runways', activerunways: 'runways',
    initialrunways: 'initialRunways', changes: 'timeline', timeline: 'timeline' };
  return map[lower] || key;
}

function normalizeObject(obj) {
  if (Array.isArray(obj)) return obj.map(normalizeObject);
  if (obj === null || typeof obj !== 'object') return obj;
  const result = {};
  for (const [k, v] of Object.entries(obj)) result[normalizeKey(k)] = normalizeObject(v);
  return result;
}

/** Extract a section object from ACL text by brace-matching. */
function extractAclSection(text, sectionKey) {
  const idx = text.indexOf('"' + sectionKey + '"');
  if (idx < 0) return null;
  const colonIdx = text.indexOf(':', idx);
  if (colonIdx < 0) return null;
  let braceIdx = colonIdx + 1;
  while (braceIdx < text.length && text[braceIdx] !== '{') braceIdx++;
  if (braceIdx >= text.length) return null;
  const between = text.substring(colonIdx + 1, braceIdx).trim();
  if (between.startsWith('null')) return null;
  let depth = 0, endIdx = braceIdx;
  for (let i = braceIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
  }
  return text.substring(braceIdx, endIdx);
}

/** Parse a frames section (WeatherFrames/WindFrames) into array of entries. */
function parseFramesSection(sectionText) {
  if (!sectionText) return [];
  const entries = [];
  const rcMatch = sectionText.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return entries;

  const absStart = rcMatch.index + rcMatch[0].length;
  let depth = 0, blockStart = -1;
  for (let i = absStart; i < sectionText.length; i++) {
    if (sectionText[i] === '{') {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (sectionText[i] === '}') {
      depth--;
      if (depth === 0 && blockStart >= 0) {
        const block = sectionText.substring(blockStart, i + 1);
        const entry = {};
        // Extract all "key": value pairs (lowercase keys to match JSON convention)
        const strMatches = block.matchAll(/"(\w+)":\s*"([^"]*)"/g);
        for (const m of strMatches) entry[m[1].toLowerCase()] = m[2];
        const numMatches = block.matchAll(/"(\w+)":\s*(-?\d+)/g);
        for (const m of numMatches) {
          const key = m[1].toLowerCase();
          if (!(key in entry)) entry[key] = parseInt(m[2], 10);
        }
        entries.push(entry);
        blockStart = -1;
      }
    }
  }
  return entries;
}

/** Parse RunwayTimeline section into structured object. */
function parseRunwaySection(sectionText) {
  if (!sectionText) return null;
  const result = { initialRunways: [], timeline: [] };

  const irIdx = sectionText.indexOf('"InitialRunways"');
  if (irIdx >= 0) {
    const rcMatch = sectionText.substring(irIdx).match(/"\$rcontent"\s*:\s*\[([^\]]*)\]/);
    if (rcMatch) {
      const items = rcMatch[1].match(/"([^"]+)"/g);
      if (items) result.initialRunways = items.map(s => s.replace(/"/g, ''));
    }
  }

  const tlIdx = sectionText.indexOf('"Timeline"');
  if (tlIdx >= 0) {
    let depth = 0, start = -1, end = -1;
    for (let i = tlIdx; i < sectionText.length; i++) {
      if (sectionText[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (sectionText[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (start >= 0) {
      const tlText = sectionText.substring(start, end);
      const entries = parseFramesSection(tlText);
      result.timeline = entries.map(e => ({
        time: e.time || '',
        changes: [],
      }));
      // Extract changes from full tlText by brace-matching each entry
      let depth2 = 0, blockStart2 = -1;
      const tlBlocks = [];
      for (let i = 0; i < tlText.length; i++) {
        if (tlText[i] === '{') {
          if (depth2 === 0) blockStart2 = i;
          depth2++;
        } else if (tlText[i] === '}') {
          depth2--;
          if (depth2 === 0 && blockStart2 >= 0) {
            tlBlocks.push(tlText.substring(blockStart2, i + 1));
            blockStart2 = -1;
          }
        }
      }
      tlBlocks.forEach((block, i) => {
        if (i < result.timeline.length) {
          const srcMatches = block.matchAll(/"Source":\s*"([^"]*)"/g);
          const dstMatches = block.matchAll(/"Dest":\s*"([^"]*)"/g);
          const sources = [...srcMatches].map(m => m[1]);
          const dests = [...dstMatches].map(m => m[1]);
          result.timeline[i].changes = sources.map((s, j) => ({ source: s, dest: dests[j] || '' }));
        }
      });
    }
  }
  return result;
}

/** Compare two arrays of frame entries. */
function compareFrameEntries(jsonEntries, aclEntries, fields, label) {
  let diffs = 0;
  if (jsonEntries.length !== aclEntries.length) {
    console.log('  ✗ ' + label + ' count mismatch: JSON=' + jsonEntries.length + ' vs ACL=' + aclEntries.length);
    return Math.abs(jsonEntries.length - aclEntries.length) + 1;
  }
  for (let i = 0; i < jsonEntries.length; i++) {
    const j = jsonEntries[i];
    const a = aclEntries[i];
    for (const f of fields) {
      const jv = j[f], av = a[f];
      if (jv === undefined && av === undefined) continue;
      if (String(jv) !== String(av)) {
        console.log('  ✗ ' + label + '[' + i + '].' + f + ': JSON="' + jv + '" vs ACL="' + av + '"');
        diffs++;
      }
    }
  }
  if (diffs === 0) console.log('  ✓ ' + label + ': ' + jsonEntries.length + ' entries match');
  return diffs;
}

/** Compare runway data. */
function compareRunwayEntries(jsonData, aclData) {
  let diffs = 0;
  if (!jsonData || !aclData) {
    console.log('  ✗ Runway: missing data on one side');
    return 1;
  }

  // Initial runways
  const jIR = (jsonData.initialRunways || []).slice().sort();
  const aIR = (aclData.initialRunways || []).slice().sort();
  if (JSON.stringify(jIR) !== JSON.stringify(aIR)) {
    console.log('  ✗ InitialRunways: JSON=' + JSON.stringify(jIR) + ' vs ACL=' + JSON.stringify(aIR));
    diffs++;
  } else {
    console.log('  ✓ InitialRunways: ' + jIR.length + ' runways match');
  }

  // Timeline entries
  const jTL = jsonData.timeline || [];
  const aTL = aclData.timeline || [];
  if (jTL.length !== aTL.length) {
    console.log('  ✗ Timeline count mismatch: JSON=' + jTL.length + ' vs ACL=' + aTL.length);
    diffs += Math.abs(jTL.length - aTL.length);
  } else {
    for (let i = 0; i < jTL.length; i++) {
      const jt = jTL[i], at = aTL[i];
      if (jt.time !== at.time) {
        console.log('  ✗ Timeline[' + i + '].time: JSON="' + jt.time + '" vs ACL="' + at.time + '"');
        diffs++;
      }
      const jCh = (jt.changes || []).slice().sort((a, b) => (a.source + a.dest).localeCompare(b.source + b.dest));
      const aCh = (at.changes || []).slice().sort((a, b) => (a.source + a.dest).localeCompare(b.source + b.dest));
      if (JSON.stringify(jCh) !== JSON.stringify(aCh)) {
        console.log('  ✗ Timeline[' + i + '].changes mismatch');
        diffs++;
      }
    }
    if (diffs === 0) console.log('  ✓ Timeline: ' + jTL.length + ' entries match');
  }

  return diffs;
}

// ─── Main ─────────────────────────────────────────────────────

console.log('Test: Timeline Comparison (JSON vs ACL)');
console.log('ACL: ' + aclPath + '\n');

const aclText = fs.readFileSync(aclPath, 'utf-8');
const dir = path.dirname(aclPath);
const base = path.basename(aclPath, '.acl');
let totalDiffs = 0, totalOk = 0;

// ── Weather ────────────────────────────────────────────────
console.log('=== Weather Timeline ===');
let weatherJson = null;
const weatherJsonPath = path.join(dir, 'weather_timeline.json');
if (fs.existsSync(weatherJsonPath)) {
  weatherJson = JSON.parse(fs.readFileSync(weatherJsonPath, 'utf-8'));
}
const weatherSection = extractAclSection(aclText, 'WeatherFrames');
const weatherAclEntries = parseFramesSection(weatherSection);

if (weatherJson && weatherAclEntries.length > 0) {
  const diffs = compareFrameEntries(weatherJson, weatherAclEntries, ['time', 'preset'], 'Weather');
  totalDiffs += diffs;
  if (diffs === 0) totalOk++;
} else {
  console.log('  SKIP: weather data not available on both sides (JSON=' + !!weatherJson + ', ACL=' + (weatherAclEntries.length > 0) + ')');
}

// ── Wind ───────────────────────────────────────────────────
console.log('\n=== Wind Timeline ===');
let windJson = null;
const windJsonPath = path.join(dir, 'wind_timeline.json');
if (fs.existsSync(windJsonPath)) {
  windJson = JSON.parse(fs.readFileSync(windJsonPath, 'utf-8'));
}
const windSection = extractAclSection(aclText, 'WindFrames');
const windAclEntries = parseFramesSection(windSection);

if (windJson && windAclEntries.length > 0) {
  const diffs = compareFrameEntries(windJson, windAclEntries, ['time', 'direction', 'speed'], 'Wind');
  totalDiffs += diffs;
  if (diffs === 0) totalOk++;
} else {
  console.log('  SKIP: wind data not available on both sides (JSON=' + !!windJson + ', ACL=' + (windAclEntries.length > 0) + ')');
}

// ── Runway ─────────────────────────────────────────────────
console.log('\n=== Runway Timeline ===');
let runwayJson = null;
const runwayJsonPath = path.join(dir, 'runway_timeline_' + base + '.json');
const altRunwayPath = (() => {
  const files = fs.readdirSync(dir).filter(f => f.startsWith('runway_timeline_') && f.endsWith('.json'));
  return files.length > 0 ? path.join(dir, files[0]) : null;
})();
const rwPath = fs.existsSync(runwayJsonPath) ? runwayJsonPath : altRunwayPath;
if (rwPath) runwayJson = JSON.parse(fs.readFileSync(rwPath, 'utf-8'));

const runwaySection = extractAclSection(aclText, 'RunwayTimeline');
const runwayAclData = parseRunwaySection(runwaySection);

if (runwayJson && runwayAclData) {
  const diffs = compareRunwayEntries(runwayJson, runwayAclData);
  totalDiffs += diffs;
  if (diffs === 0) totalOk++;
} else {
  console.log('  SKIP: runway data not available on both sides (JSON=' + !!runwayJson + ', ACL=' + !!runwayAclData + ')');
}

// ── Summary ────────────────────────────────────────────────
console.log('\n' + '═'.repeat(40));
console.log('Sections checked: ' + totalOk + ' OK, ' + totalDiffs + ' difference(s)');
console.log('═'.repeat(40));

if (totalDiffs > 0) {
  console.log('\n✗ TIMELINE MISMATCHES DETECTED');
  process.exit(1);
} else {
  console.log('\n✓ ALL TIMELINES MATCH');
  process.exit(0);
}
