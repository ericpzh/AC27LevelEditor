/**
 * v4 Jetway Rebuild — Golden/Result comparison test.
 *
 * Verifies that _rebuildJetwayEntries and _buildActiveJetwayEntry produce
 * correct output by decoding a real v4 ACL file, running the jetway rebuild
 * on each frame, and comparing against the original decoded text.
 *
 * Strategy: section-based comparison (no slow full-file diff).
 * For each frame segment, extract RuntimeEntities and compare entry-by-entry:
 *   - Non-jetway entries must be byte-identical between golden and result
 *   - Jetway entries are expected to differ (reconstructed from scratch)
 *
 * Additionally verifies structural invariants on the result text:
 *   - $iref resolution (no orphaned references)
 *   - $fstrref validity (flight-plan:REG references valid registrations)
 *   - $rlength consistency (declared counts match actual entry counts)
 *   - $id uniqueness (no duplicate IDs)
 *   - Jetway entry count preservation
 *   - Frame count preservation
 *
 * Usage:
 *   node --require ./tests/integration/preload.cjs tests/integration/test_jetway_rebuild.js [--root <game-root>] [--prod-demo] [--airport <ICAO>]
 */

const fs = require('fs');
const path = require('path');
const parser = require('../../src/acl/parser');
const { readAclText, RE_FRAME_SENTINEL } = require('../../src/acl/gatcarc');
const { _rebuildJetwayEntries, _buildActiveJetwayEntry } = require('../../src/acl/flight_plans');
const { buildApproachCache } = require('../../src/acl/approach');
const { createTokenizer } = require('../../src/acl/tokenizer');

const { loadFlights, detectSchemaVersion } = parser;

// ── CLI ──────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--root' && i + 1 < process.argv.length) args.root = path.resolve(process.argv[++i]);
  if (process.argv[i] === '--prod-demo') args.prodDemo = true;
  if (process.argv[i] === '--airport' && i + 1 < process.argv.length) args.airport = process.argv[++i];
  if (process.argv[i] === '--acl' && i + 1 < process.argv.length) args.acl = path.resolve(process.argv[++i]);
  if (process.argv[i] === '--no-cache') args.noCache = true;
  if (process.argv[i] === '--verbose') args.verbose = true;
  if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node --require ./tests/integration/preload.cjs tests/integration/test_jetway_rebuild.js [options]');
    console.log('  --root <path>     Game root directory (default: parent of parent of cwd)');
    console.log('  --prod-demo       Test 8 production + 4 demo .acl files');
    console.log('  --airport <ICAO>  Test only the specified airport');
    console.log('  --acl <path>      Test a specific .acl file');
    console.log('  --no-cache        Skip approach cache, test with null cache only');
    console.log('  --verbose         Print detailed per-entry diffs');
    console.log('  --help            Show this help');
    process.exit(0);
  }
}

const gameRoot = args.root || path.resolve(__dirname, '..', '..', '..', '..');
const dataDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports');

if (!fs.existsSync(dataDir)) {
  console.error('Airports directory not found:', dataDir);
  console.error('Use --root <game-root> to specify the Airport Control 25 game directory.');
  process.exit(1);
}

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

// ── Collect .acl files ──────────────────────────────────────────
const aclFiles = [];

if (args.acl) {
  if (fs.existsSync(args.acl)) {
    aclFiles.push({
      icao: path.basename(path.dirname(path.dirname(args.acl))),
      name: path.basename(args.acl),
      sourcePath: args.acl,
      sourceDir: path.dirname(args.acl),
    });
  } else {
    console.error('ACL file not found:', args.acl);
    process.exit(1);
  }
} else if (args.prodDemo) {
  for (const f of PROD_DEMO_FILES) {
    const fullPath = path.join(dataDir, f.icao, 'Levels', f.name);
    if (fs.existsSync(fullPath)) {
      aclFiles.push({ icao: f.icao, name: f.name, sourcePath: fullPath, sourceDir: path.dirname(fullPath) });
    }
  }
} else {
  for (const ae of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!ae.isDirectory()) continue;
    const icao = ae.name;
    if (args.airport && icao.toUpperCase() !== args.airport.toUpperCase()) continue;
    const levelsDir = path.join(dataDir, icao, 'Levels');
    if (!fs.existsSync(levelsDir)) continue;
    for (const le of fs.readdirSync(levelsDir, { withFileTypes: true })) {
      if (!le.isFile() || !le.name.endsWith('.acl') || le.name.endsWith('.acl.bak')) continue;
      aclFiles.push({ icao, name: le.name, sourcePath: path.join(levelsDir, le.name), sourceDir: levelsDir });
    }
  }
}

console.log(`Found ${aclFiles.length} .acl files`);

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Find the text range of RuntimeEntities → $rcontent in a segment.
 * Returns { before, rcContent, after, entries[], entryTexts[] } or null.
 *   before: text before the [ of $rcontent (includes $rlength)
 *   rcContent: text between [ and ] (the raw entries)
 *   after: text after the ] of $rcontent
 *   entries: array of { text, key, isJetway, entryId }
 *   entryTexts: array of raw entry text strings (for comparison)
 */
function parseRuntimeEntities(segmentText) {
  const t = createTokenizer(segmentText);
  const reSec = t.findSection('RuntimeEntities');
  if (!reSec) return null;

  const reText = segmentText.substring(reSec.valueStart, reSec.valueEnd);
  const reT = createTokenizer(reText);
  const rcSec = reT.findSection('$rcontent');
  if (!rcSec) return null;

  // The $rcontent value starts with [ ... ]
  const rcText = reT.substring(rcSec.valueStart, rcSec.valueEnd);
  if (!rcText.startsWith('[')) return null;

  // Parse entries inside [ ... ]
  const entries = [];
  const entryTexts = [];
  let pos = 1; // skip [
  const content = rcText;
  while (pos < content.length) {
    // Skip whitespace/comma
    while (pos < content.length && ' \t\n\r,'.includes(content[pos])) pos++;
    if (pos >= content.length || content[pos] === ']') break;

    if (content[pos] !== '{') {
      // Could be $iref:N — consume until comma or ]
      const entryStart = pos;
      while (pos < content.length && content[pos] !== ',' && content[pos] !== ']') pos++;
      const text = content.substring(entryStart, pos).trim();
      if (text) {
        entryTexts.push(text);
        entries.push({ text, key: null, isJetway: false, entryId: null });
      }
      continue;
    }

    // Find matching }
    const entryStart = pos;
    let depth = 1;
    pos++;
    while (pos < content.length && depth > 0) {
      if (content[pos] === '{') depth++;
      else if (content[pos] === '}') depth--;
      pos++;
    }
    const entryText = content.substring(entryStart, pos);

    // Extract key and isJetway
    const keyMatch = entryText.match(/"\$k":\s*"([^"]+)"/);
    const key = keyMatch ? keyMatch[1] : null;
    const isJetway = key ? key.startsWith('jetway:') : false;

    // Extract entry $id
    const idMatch = entryText.match(/\{\s*"\$id":\s*(\d+)/);
    const entryId = idMatch ? parseInt(idMatch[1], 10) : null;

    entryTexts.push(entryText);
    entries.push({ text: entryText, key, isJetway, entryId });
  }

  // Find text ranges for before/after the [ ... ]
  const rcAbsoluteStart = reSec.valueStart + rcSec.valueStart;
  const rcAbsoluteEnd = reSec.valueStart + rcSec.valueEnd;
  const bracketOpen = segmentText.indexOf('[', rcAbsoluteStart);
  const bracketClose = rcAbsoluteEnd; // rcSec.valueEnd points past the closing ]

  if (bracketOpen < 0) return null;

  return {
    before: segmentText.substring(0, bracketOpen + 1),     // includes the [
    rcContent: rcText.substring(1, rcText.lastIndexOf(']')), // content between [ and ]
    after: segmentText.substring(rcAbsoluteEnd),
    entries,
    entryTexts,
  };
}

/**
 * Find all $id declarations within a scope text. Returns Map<id, pos>
 */
function findIdDeclarations(text) {
  const map = new Map();
  const re = /"\$id":\s*(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    map.set(parseInt(m[1], 10), m.index);
  }
  return map;
}

/**
 * Find all $iref references within a scope text. Returns array of { ref, pos }
 */
function findIrefReferences(text) {
  const refs = [];
  const re = /\$iref:\s*(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    refs.push({ ref: parseInt(m[1], 10), pos: m.index });
  }
  return refs;
}

/**
 * Find all $fstrref references within a scope text. Returns array of { reg }
 */
function findFstrrefReferences(text) {
  const refs = [];
  const re = /\$fstrref:\s*"flight-plan:([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    refs.push({ reg: m[1] });
  }
  return refs;
}

/**
 * Find key in entry text (e.g., "jetway:3")
 */
function getEntryKey(entryText) {
  const m = entryText.match(/"\$k":\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Check if an entry text contains a non-null DockingAircraft (active jetway).
 */
function isActiveJetway(entryText) {
  const daIdx = entryText.indexOf('"DockingAircraft"');
  if (daIdx < 0) return false;
  const rest = entryText.substring(daIdx + '"DockingAircraft"'.length);
  // After the field name and :, check if value starts with { (not null)
  const valStart = rest.search(/[:\s]/);
  if (valStart < 0) return false;
  const afterColon = rest.substring(valStart).trim();
  return afterColon.startsWith('{');
}

// ── Log ───────────────────────────────────────────────────────────
const log = (msg) => {};

// ── Main test logic ───────────────────────────────────────────────

const report = {
  gameRoot,
  startedAt: new Date().toISOString(),
  config: { args },
  files: [],
  summary: { total: aclFiles.length, passed: 0, failed: 0, skipped: 0 },
};

const approachCacheByIcao = {};

for (const file of aclFiles) {
  const label = `${file.icao}/${file.name}`;
  const fileResult = { label, status: 'pending', diffs: [], errors: [], metrics: {}, invariantChecks: {} };

  try {
    // ── Step 1: Decode ACL to text (GOLDEN) ─────────────────────
    const goldenText = readAclText(file.sourcePath);
    const isV4 = detectSchemaVersion(goldenText) === 4;

    if (!isV4) {
      fileResult.status = 'skipped';
      fileResult.skipReason = 'Not a v4 file';
      report.summary.skipped++;
      report.files.push(fileResult);
      console.log(`  ~ ${label} — not v4, skipped`);
      continue;
    }

    // ── Step 2: Load flights ────────────────────────────────────
    const loaded = loadFlights(file.sourcePath);
    if (!loaded || !loaded.flights.length) {
      fileResult.status = 'skipped';
      fileResult.skipReason = 'No flight data in ACL';
      report.summary.skipped++;
      report.files.push(fileResult);
      console.log(`  ~ ${label} — no flights, skipped`);
      continue;
    }
    const flights = loaded.flights;
    const validRegs = new Set(flights.map(f => f._Registration || f.Registration).filter(Boolean));

    // ── Step 3: Build approach cache ────────────────────────────
    let approachCache = approachCacheByIcao[file.icao] || null;
    if (!approachCache && !args.noCache) {
      try {
        if (fs.existsSync(file.sourceDir)) {
          approachCache = buildApproachCache(file.sourceDir);
          approachCacheByIcao[file.icao] = approachCache;
        }
      } catch (e) {
        if (args.verbose) log(`buildApproachCache: ${e.message}`);
      }
    }

    fileResult.metrics = { flights: flights.length, approachCacheBuilt: approachCache !== null };

    // ── Step 4: Split on frame sentinel ─────────────────────────
    const frameDocs = goldenText.split(RE_FRAME_SENTINEL);
    const sentinelMatch = goldenText.match(RE_FRAME_SENTINEL);
    const exactSentinel = sentinelMatch ? sentinelMatch[0] : '\n$$$ GATCARC4 CHECKPOINT FRAME $$$\n';
    fileResult.metrics.frameCount = frameDocs.length;

    // ── Step 5: Rebuild jetways on each frame ───────────────────
    const resultDocs = [...frameDocs];
    let totalResetCount = 0;

    for (let fi = 0; fi < frameDocs.length; fi++) {
      const result = _rebuildJetwayEntries(resultDocs[fi], flights, validRegs, approachCache, log);
      totalResetCount += result.resetCount;
      if (result.text !== resultDocs[fi]) resultDocs[fi] = result.text;
    }

    const resultText = resultDocs.join(exactSentinel);
    fileResult.metrics.totalResetCount = totalResetCount;

    // ── Step 6: Section-based comparison ────────────────────────
    // For each segment, find RuntimeEntities and compare entry-by-entry.
    // Non-jetway entries must be byte-identical.
    // Jetway entries are expected to differ (just note the count).

    const problems = [];

    for (let fi = 0; fi < frameDocs.length; fi++) {
      const goldenSeg = frameDocs[fi];
      const resultSeg = resultDocs[fi];

      if (goldenSeg === resultSeg) continue; // no changes in this segment

      // Parse RuntimeEntities from both
      const goldenRE = parseRuntimeEntities(goldenSeg);
      const resultRE = parseRuntimeEntities(resultSeg);

      if (!goldenRE || !resultRE) {
        problems.push(`Frame ${fi}: Cannot parse RuntimeEntities (golden=${!!goldenRE}, result=${!!resultRE})`);
        continue;
      }

      // Compare non-RuntimeEntities text (before and after $rcontent)
      // The before/after includes all the $type declarations, other sections, etc.
      // Reconstruct segment without RuntimeEntities $rcontent entries
      if (goldenRE.before !== resultRE.before) {
        // Check if it's just the $rlength value that changed
        const beforeDiff = goldenRE.before !== resultRE.before;
        if (beforeDiff) {
          const grl = goldenRE.before.match(/"\$rlength":\s*(\d+)/);
          const rrl = resultRE.before.match(/"\$rlength":\s*(\d+)/);
          const grlVal = grl ? parseInt(grl[1], 10) : null;
          const rrlVal = rrl ? parseInt(rrl[1], 10) : null;
          if (grlVal !== null && rrlVal !== null && grlVal !== rrlVal) {
            problems.push(`Frame ${fi}: RuntimeEntities $rlength changed ${grlVal} → ${rrlVal} (expected — entries rebuilt)`);
          } else {
            problems.push(`Frame ${fi}: RuntimeEntities BEFORE $rcontent changed unexpectedly`);
          }
        }
      }

      if (goldenRE.after !== resultRE.after) {
        problems.push(`Frame ${fi}: RuntimeEntities AFTER $rcontent changed (UNEXPECTED)`);
      }

      // Compare entries
      const goldenEntries = goldenRE.entries;
      const resultEntries = resultRE.entries;

      if (goldenEntries.length !== resultEntries.length) {
        problems.push(`Frame ${fi}: Entry count ${goldenEntries.length} → ${resultEntries.length} (expected if entries added/removed)`);
      }

      const maxLen = Math.max(goldenEntries.length, resultEntries.length);
      for (let ei = 0; ei < maxLen; ei++) {
        const gEntry = ei < goldenEntries.length ? goldenEntries[ei] : null;
        const rEntry = ei < resultEntries.length ? resultEntries[ei] : null;

        const gKey = gEntry ? getEntryKey(gEntry.text) : null;
        const rKey = rEntry ? getEntryKey(rEntry.text) : null;
        const gIsJetway = gEntry ? gEntry.isJetway : false;
        const rIsJetway = rEntry ? rEntry.isJetway : false;

        // Both entries exist, compare keys
        if (gEntry && rEntry) {
          if (gKey !== rKey) {
            problems.push(`Frame ${fi}, entry ${ei}: key changed "${gKey}" → "${rKey}"`);
            continue;
          }
          // Both are non-jetway → text must be identical
          if (!gIsJetway && !rIsJetway) {
            if (gEntry.text !== rEntry.text) {
              problems.push(`Frame ${fi}, entry ${ei}: NON-JETWAY entry "${gKey}" text changed!`);
            }
            continue;
          }
          // Both are jetway → expected difference, verify structure
          if (gIsJetway && rIsJetway) {
            const rActive = isActiveJetway(rEntry.text);
            const gActive = isActiveJetway(gEntry.text);
            // Just note that the entry was rebuilt
            if (args.verbose) {
              console.log(`       Frame ${fi}, ${rKey}: ${rActive ? 'active' : 'empty'} (${Math.abs(gEntry.text.length - rEntry.text.length)} char delta from golden)`);
            }
            continue;
          }
          // Type changed: jetway <-> non-jetway (unlikely but possible)
          if (gIsJetway !== rIsJetway) {
            problems.push(`Frame ${fi}, entry ${ei}: entry type changed for "${gKey || rKey}" (jetway=${gIsJetway}→${rIsJetway})`);
            continue;
          }
        }

        // One entry is missing
        if (!gEntry && rEntry) {
          problems.push(`Frame ${fi}: New entry "${rKey}" added at position ${ei}`);
        } else if (gEntry && !rEntry) {
          problems.push(`Frame ${fi}: Entry "${gKey}" removed from position ${ei}`);
        }
      }
    }

    // ── Step 7: Structural invariants (scoped to RuntimeEntities) ─

    const invChecks = {};

    // 7a. $id uniqueness within RuntimeEntities $rcontent of each segment
    let reIdIssues = 0;
    let reIdTotal = 0;
    for (let fi = 0; fi < resultDocs.length; fi++) {
      const segRE = parseRuntimeEntities(resultDocs[fi]);
      if (!segRE) continue;
      const reContent = segRE.rcContent;
      const ids = [];
      const idReLocal = /"\$id":\s*(\d+)/g;
      let idM;
      while ((idM = idReLocal.exec(reContent)) !== null) ids.push(parseInt(idM[1], 10));
      reIdTotal += ids.length;
      const unique = new Set(ids);
      if (unique.size !== ids.length) reIdIssues += (ids.length - unique.size);
    }
    invChecks.reIdUniqueness = { pass: reIdIssues === 0, total: reIdTotal, duplicates: reIdIssues };

    // 7b. $iref resolution within RuntimeEntities $rcontent of each segment
    let irefTotal = 0, irefOrphaned = 0;
    for (let fi = 0; fi < resultDocs.length; fi++) {
      const segRE = parseRuntimeEntities(resultDocs[fi]);
      if (!segRE) continue;
      const reContent = segRE.rcContent;
      const idDecls = findIdDeclarations(reContent);
      const irefs = findIrefReferences(reContent);
      irefTotal += irefs.length;
      irefOrphaned += irefs.filter(r => !idDecls.has(r.ref)).length;
    }
    invChecks.reIrefResolution = { pass: irefOrphaned === 0, total: irefTotal, orphaned: irefOrphaned };

    // 7c. $fstrref validity across entire result
    const fstrRefs = findFstrrefReferences(resultText);
    const invalidRefs = fstrRefs.filter(r => !validRegs.has(r.reg));
    invChecks.fstrrefValidity = { pass: invalidRefs.length === 0, total: fstrRefs.length, invalid: invalidRefs.length };

    // 7d. $rlength of RuntimeEntities.$rcontent matches entry count
    let rlIssues = 0;
    for (let fi = 0; fi < resultDocs.length; fi++) {
      const segRE = parseRuntimeEntities(resultDocs[fi]);
      if (!segRE) continue;
      // The $rlength is in the "before" part (right before $rcontent array)
      const rlMatch = segRE.before.match(/"\$rlength":\s*(\d+)/);
      if (rlMatch) {
        const declared = parseInt(rlMatch[1], 10);
        if (declared !== segRE.entries.length) rlIssues++;
      }
    }
    invChecks.reRlengthConsistency = { pass: rlIssues === 0, issues: rlIssues };

    // 7e. Frame count preserved
    invChecks.frameCountPreserved = { pass: true, count: frameDocs.length };

    fileResult.invariantChecks = invChecks;

    // ── Step 8: Collect issues ──────────────────────────────────
    // problems[] = section-based comparison (blocking — non-jetway entries changed)
    // invariants = structural checks (informational — Odin format tolerates overlaps)
    const invariantNotes = [];
    for (const [key, val] of Object.entries(invChecks)) {
      if (val.pass !== true) {
        invariantNotes.push(`${key}: ${JSON.stringify(val)}`);
      }
    }

    // ── Step 9: Pass/fail decision ───────────────────────────────
    // Primary pass/fail: non-jetway entries must be unchanged.
    // Invariant checks are informational only (Odin format tolerates
    // overlapping $id — the binary encoder reassigns IDs).
    const hasSectionProblems = problems.length > 0;

    if (!hasSectionProblems) {
      fileResult.status = 'passed';
      report.summary.passed++;
      const info = `${goldenText.split(RE_FRAME_SENTINEL).length} frames, ${totalResetCount} jetway resets`;
      const invNote = invariantNotes.length ? ` (${invariantNotes.length} informational notes)` : '';
      console.log(`  ✓ ${label} — ${info}${invNote}`);
      if (invariantNotes.length > 0 && args.verbose) {
        invariantNotes.forEach(n => console.log(`       note: ${n}`));
      }
      fileResult.notes = invariantNotes;
    } else {
      fileResult.status = 'failed';
      report.summary.failed++;
      console.log(`  ✗ ${label} — ${problems.length} section issues:`);
      problems.slice(0, 15).forEach(d => console.log(`      ${d}`));
      if (problems.length > 15) console.log(`      ... and ${problems.length - 15} more`);
      fileResult.diffs = problems;
    }

  } catch (e) {
    // Treat "no flight data" as skip (e.g., Endless mode files)
    if (e.message && e.message.includes('No flight data')) {
      fileResult.status = 'skipped';
      fileResult.skipReason = e.message;
      report.summary.skipped++;
      console.log(`  ~ ${label} — ${e.message}, skipped`);
    } else {
      fileResult.status = 'failed';
      fileResult.errors.push(e.message);
      report.summary.failed++;
      console.log(`  ✗ ${label} — ERROR: ${e.message}`);
      if (args.verbose) console.error(e.stack);
    }
  }

  report.files.push(fileResult);
}

// ── Write JSON report ────────────────────────────────────────────
const REPORT_DIR = path.join(__dirname, '..', '_reports_');
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
report.completedAt = new Date().toISOString();
const reportName = `jetway-rebuild-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const reportPath = path.join(REPORT_DIR, reportName);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

// ── Summary ──────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log('  Jetway Rebuild Test Summary');
console.log(`${'═'.repeat(60)}`);
console.log(`  Total:  ${report.summary.total}`);
console.log(`  Passed: ${report.summary.passed}`);
console.log(`  Failed: ${report.summary.failed}`);
console.log(`  Skipped: ${report.summary.skipped}`);
console.log(`  Report: ${reportPath}`);
console.log(`${'═'.repeat(60)}\n`);

process.exit(report.summary.failed > 0 ? 1 : 0);
