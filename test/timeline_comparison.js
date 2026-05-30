/**
 * Timeline Comparison Test
 * Compares JSON timeline files against ACL-embedded timeline data.
 * Usage: node test/timeline_comparison.js <acl-path>
 */

const fs = require('fs');
const path = require('path');

// Normalize field names (handle case differences: preset vs Preset, time vs Time, etc.)
function normalizeKey(key) {
  if (!key) return '';
  const lower = key.toLowerCase().trim();
  const map = {
    'preset': 'preset',
    'time': 'time',
    'direction': 'direction',
    'speed': 'speed',
    'gustspeed': 'gustSpeed',
    'status': 'status',
    'runways': 'runways',
    'activerunways': 'runways',
    'initialrunways': 'initialRunways',
    'changes': 'timeline',
    'timeline': 'timeline',
  };
  return map[lower] || key;
}

// Normalize object keys recursively
function normalizeObject(obj) {
  if (Array.isArray(obj)) return obj.map(normalizeObject);
  if (obj === null || typeof obj !== 'object') return obj;
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[normalizeKey(k)] = normalizeObject(v);
  }
  return result;
}

// Compare two timeline entries
function compareEntries(a, b, fields) {
  const diffs = [];
  for (const f of fields) {
    const va = a[f];
    const vb = b[f];
    if (va === undefined && vb === undefined) continue;
    if (va === vb) continue;
    if (typeof va === 'number' && typeof vb === 'number') {
      if (Math.abs(va - vb) < 0.001) continue;
    }
    if (String(va) === String(vb)) continue;
    diffs.push({ field: f, a: va, b: vb });
  }
  return diffs;
}

// Parse ACL file and extract embedded timeline data
function extractAclTimelines(aclPath) {
  const text = fs.readFileSync(aclPath, 'utf-8');
  const result = { weather: null, wind: null, runway: null };
  const dir = path.dirname(aclPath);
  const base = path.basename(aclPath, '.acl');

  // Try reading .aclcfg for file references
  const cfgPath = path.join(dir, base + '.aclcfg');
  if (fs.existsSync(cfgPath)) {
    try {
      return loadTimelinesFromCfg(cfgPath, dir);
    } catch (_) {}
  }

  // Fallback: search JSON timeline files in the same directory
  const weatherPath = path.join(dir, 'weather_timeline.json');
  const windPath = path.join(dir, 'wind_timeline.json');
  if (fs.existsSync(weatherPath)) result.weather = JSON.parse(fs.readFileSync(weatherPath, 'utf-8'));
  if (fs.existsSync(windPath)) result.wind = JSON.parse(fs.readFileSync(windPath, 'utf-8'));

  return result;
}

function loadTimelinesFromCfg(cfgPath, dir) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  const result = { weather: null, wind: null, runway: null };

  // Weather
  if (cfg.weatherTimelineFile) {
    const p = path.join(dir, cfg.weatherTimelineFile + '.json');
    if (fs.existsSync(p)) result.weather = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } else {
    const p = path.join(dir, 'weather_timeline.json');
    if (fs.existsSync(p)) result.weather = JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  // Wind
  if (cfg.windTimelineFile) {
    const p = path.join(dir, cfg.windTimelineFile + '.json');
    if (fs.existsSync(p)) result.wind = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } else {
    const p = path.join(dir, 'wind_timeline.json');
    if (fs.existsSync(p)) result.wind = JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  // Runway
  if (cfg.runwayTimelineFile) {
    const p = path.join(dir, cfg.runwayTimelineFile + '.json');
    if (fs.existsSync(p)) result.runway = JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  return result;
}

// Main comparison
function compareTimelines(aclPath) {
  const dir = path.dirname(aclPath);
  const base = path.basename(aclPath, '.acl');
  const timelines = loadTimelinesFromCfg(path.join(dir, base + '.aclcfg'), dir);

  const report = { total: 0, matched: 0, diffs: 0, details: [] };

  // Compare Weather Timeline
  if (timelines.weather && Array.isArray(timelines.weather)) {
    report.details.push('=== Weather Timeline ===');
    const normWeather = normalizeObject(timelines.weather);
    report.total += normWeather.length;
    report.details.push(`  Entries: ${normWeather.length}`);
    normWeather.forEach((entry, i) => {
      const fields = ['time', 'preset'];
      const issues = [];
      for (const f of fields) {
        if (entry[f] === undefined || entry[f] === null || entry[f] === '') {
          issues.push(`${f}: missing`);
        }
      }
      if (issues.length > 0) {
        report.diffs++;
        report.details.push(`  [${i}] Issues: ${issues.join(', ')}`);
      } else {
        report.matched++;
      }
    });
  }

  // Compare Wind Timeline
  if (timelines.wind && Array.isArray(timelines.wind)) {
    report.details.push('');
    report.details.push('=== Wind Timeline ===');
    const normWind = normalizeObject(timelines.wind);
    report.total += normWind.length;
    report.details.push(`  Entries: ${normWind.length}`);
    normWind.forEach((entry, i) => {
      const fields = ['time', 'direction', 'speed'];
      const issues = [];
      for (const f of fields) {
        if (entry[f] === undefined || entry[f] === null || entry[f] === '') {
          issues.push(`${f}: missing`);
        }
      }
      if (issues.length > 0) {
        report.diffs++;
        report.details.push(`  [${i}] Issues: ${issues.join(', ')}`);
      } else {
        report.matched++;
      }
    });
  }

  // Compare Runway Timeline
  if (timelines.runway) {
    report.details.push('');
    report.details.push('=== Runway Timeline ===');
    const normRunway = normalizeObject(timelines.runway);
    const changes = normRunway.timeline || [];
    const initialRunways = normRunway.initialRunways || [];

    report.details.push(`  Initial runways: ${initialRunways.join(', ') || '(none)'}`);
    report.total += changes.length + 1; // +1 for initial
    if (initialRunways.length > 0) report.matched++;

    changes.forEach((entry, i) => {
      const issues = [];
      if (!entry.time && entry.time !== 0) issues.push('time: missing');
      const rwList = entry.runways || [];
      if (rwList.length === 0) issues.push('runways: empty');
      if (issues.length > 0) {
        report.diffs++;
        report.details.push(`  [${i}] Issues: ${issues.join(', ')}`);
      } else {
        report.matched++;
      }
    });

    report.details.push(`  Changes: ${changes.length}`);
  }

  return report;
}

// ─── Main ──────────────────────────────────────────────

if (process.argv.length < 3) {
  console.error('Usage: node test/timeline_comparison.js <acl-path>');
  process.exit(1);
}

const aclPath = path.resolve(process.argv[2]);
if (!fs.existsSync(aclPath)) {
  console.error(`File not found: ${aclPath}`);
  process.exit(1);
}

console.log(`Comparing timelines for: ${aclPath}`);
console.log('');

const report = compareTimelines(aclPath);

console.log(report.details.join('\n'));
console.log('');
console.log('═══════════════════════════════');
console.log(`Total items checked:  ${report.total}`);
console.log(`Matched (valid):      ${report.matched}`);
console.log(`Issues found:         ${report.diffs}`);
console.log('═══════════════════════════════');

if (report.diffs > 0) {
  process.exit(1);
} else {
  console.log('✓ All timeline entries are valid.');
  process.exit(0);
}
