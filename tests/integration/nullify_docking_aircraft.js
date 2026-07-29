/**
 * Set all DockingAircraft entries to null in the decoded text,
 * then re-encode to .acl via the garcarc CLI.
 *
 * Odin JSON format for a DockingAircraft ReactiveProperty:
 *   "DockingAircraft": {
 *       "$id": N,
 *       "$type": M,
 *       { ... aircraft object ... }   // or null
 *   },
 *
 * We replace the inner value (everything after $type line up to the closing },
 * before the next field) with just "null".
 */
const fs = require('fs');

const BASE = 'D:/SteamLibrary/steamapps/common/Airport Control 25 Playtest/GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels/test';
const INPUT = `${BASE}/fails_decoded_encode.txt`;
const OUTPUT = `${BASE}/fails_decoded_encode_null.txt`;
const OUTPUT_ACL = `${BASE}/fails_null.acl`;

let text = fs.readFileSync(INPUT, 'utf-8');
const lines = text.split('\n');
const outLines = [];

let inDocking = false;
let depth = 0;
let skipDepth = 0; // if >0, we're inside a DockingAircraft value that we're replacing

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  if (!inDocking) {
    // Look for "DockingAircraft": {
    if (/^\s*"DockingAircraft":\s*\{\s*$/.test(line)) {
      inDocking = true;
      depth = 1;   // the opening { from "DockingAircraft": {
      outLines.push(line);

      // Read the next lines: $id and $type
      const idLine = lines[++i];
      outLines.push(idLine);
      const typeLine = lines[++i];
      outLines.push(typeLine);

      // Now look at what follows — could be { (non-null) or null
      const valueLine = lines[++i];
      if (/^\s*null\s*,?\s*$/.test(valueLine)) {
        // Already null — just emit as-is
        outLines.push(valueLine);
        inDocking = false;
      } else if (/^\s*\{\s*$/.test(valueLine)) {
        // Non-null object — skip lines until we close the outer "DockingAircraft": { },
        // then emit "null" instead
        skipDepth = 1; // count the inner {
        // Scan to find the closing }, of the DockingAircraft entry
        let j = i + 1;
        // Count balanced braces
        let innerDepth = 1; // starts with one open from the value line
        while (j < lines.length) {
          const l = lines[j];
          for (const ch of l) {
            if (ch === '{') innerDepth++;
            else if (ch === '}') innerDepth--;
          }
          if (innerDepth === 0) {
            // This closing } ends the inner value object
            // But we need to go further — the outer "DockingAircraft": { } closes next
            // Check if this line also closes the outer
            break;
          }
          j++;
        }
        // j now points to the line that closes the inner object (with })
        // The outer DockingAircraft closing }, should be on the NEXT line after j
        // Or possibly on the same line
        const closeLine = lines[j];
        // Check if the line after j has just }, (closing DockingAircraft)
        let k = j;
        // Skip the inner closing line
        // Now look for the outer closing },
        let outerCloseLine = lines[k + 1] || '';
        // Check for trailing brace on inner close line closing outer too
        const outerDepthInClose = (closeLine.match(/\}/g) || []).length;
        if (outerDepthInClose >= 2) {
          // The inner close line also closes the outer — e.g. "    }", where
          // the first } closes the inner object and the second }, closes DockingAircraft
          // Actually in Odin JSON: each closing line has just one indent level
          // So this shouldn't happen — let's just check
        }

        // Better approach: find the closing }, of DockingAircraft
        // After the inner object closes on line j, the closing }, should follow
        // Re-scan from i to find the matching } that closes the outDockingAircraft
        let scanDepth = 1; // the opening "DockingAircraft": {
        let closeIdx = i;
        for (let s = i; s < lines.length; s++) {
          for (const ch of lines[s]) {
            if (ch === '{') scanDepth++;
            else if (ch === '}') scanDepth--;
          }
          if (scanDepth === 0) {
            closeIdx = s;
            break;
          }
        }

        // Replace: from the value line (i) through the closing }, (closeIdx)
        // with "null"
        outLines.push('                                    null');

        // Skip all the lines we replaced
        i = closeIdx;
        // Emit the closing }, as-is
        outLines.push(lines[i]);
        inDocking = false;
      } else {
        // Unexpected — emit as-is
        outLines.push(valueLine);
        inDocking = false;
      }
    } else {
      outLines.push(line);
    }
  } else {
    // We're inside a DockingAircraft scanning mode that we already handled above
    // This shouldn't be reached
    outLines.push(line);
  }
}

fs.writeFileSync(OUTPUT, outLines.join('\n'), 'utf-8');
console.log(`Written: ${OUTPUT}`);

// Count remaining DockingAircraft entries in output
const resultText = fs.readFileSync(OUTPUT, 'utf-8');
const fullCount = (resultText.match(/"DockingAircraft"/g) || []).length;
const nullCount = (resultText.match(/"DockingAircraft":\s*\{\s*\n\s*"\$id"/g) || []).length;
console.log(`DockingAircraft entries: ${fullCount} (all should still have $id/$type)`);
console.log(`Now verifying all values are null...`);

// Quick check: look for any DockingAircraft that isn't null
const lines2 = resultText.split('\n');
let problems = 0;
for (let i = 0; i < lines2.length; i++) {
  if (/^\s*"DockingAircraft":\s*\{\s*$/.test(lines2[i])) {
    // Check three lines down for null
    const valLine = lines2[i + 3] || '';
    if (!/^\s*null\s*,?\s*$/.test(valLine)) {
      console.log(`  PROBLEM at line ${i+1}: expected null, got: ${valLine.trim()}`);
      problems++;
    }
  }
}
if (problems === 0) {
  console.log('All DockingAircraft values are null ✓');
} else {
  console.log(`${problems} entries still have non-null values!`);
}
