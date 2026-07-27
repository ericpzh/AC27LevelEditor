/**
 * Find $id/$iref type mismatches in the frame section.
 * Check: for each $iref:N, does $id:N actually exist with the expected type?
 */
const fs = require('fs');

const WORKS = 'D:/SteamLibrary/steamapps/common/Airport Control 25 Playtest/GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels/test/works_decoded.txt';
const FAILS = 'D:/SteamLibrary/steamapps/common/Airport Control 25 Playtest/GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels/test/fails.acl.decoded.txt';

function analyze(text, label) {
  const sentinel = '$$$ GATCARC4 CHECKPOINT FRAME $$$';
  const frame = text.substring(text.indexOf(sentinel) + sentinel.length);
  const lines = frame.split('\n');

  console.log(`\n${'='.repeat(72)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(72)}`);

  // Build map: $id -> { type: string, name: string, line: number }
  const idMap = new Map();

  // Build map: line -> { field, irefTarget, parentKey }
  const irefMap = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Collect $id declarations
    const idMatch = line.match(/"\$id":\s*(\d+)/);
    if (idMatch) {
      const id = parseInt(idMatch[1]);
      // Determine the type from the same line or nearby
      let typeName = '';
      const typeMatch = line.match(/"\$type":\s*(?:"(\d+\|[^"]+)"|(\d+))/);
      if (typeMatch) {
        typeName = typeMatch[1] || typeMatch[2];
      } else {
        // Check next few lines
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          const t = lines[j].match(/"\$type":\s*(?:"(\d+\|[^"]+)"|(\d+))/);
          if (t) { typeName = t[1] || t[2]; break; }
        }
      }

      if (!idMap.has(id)) {
        idMap.set(id, { type: typeName, line: i, text: line.trim().substring(0, 100) });
      } else {
        // Duplicate $id!
        console.log(`  *** DUPLICATE \$id:${id} already defined at L${idMap.get(id).line+1}, also at L${i+1}`);
      }
    }

    // Collect $iref references
    const irefMatch = line.match(/\$iref:(\d+)/);
    if (irefMatch) {
      const id = parseInt(irefMatch[1]);
      // Find the parent field name
      let fieldName = '(unknown)';
      // Search backward for a field name pattern
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const fMatch = lines[j].match(/^\s*"(\w+)":/);
        if (fMatch) { fieldName = fMatch[1]; break; }
      }

      irefMap.push({ line: i, id, field: fieldName });
    }
  }

  // Check each $iref resolves AND has correct type context
  console.log(`\n\$id declarations: ${idMap.size}`);
  console.log(`\$iref references: ${irefMap.length}`);

  // Find chronological order of $id declarations
  const idOrder = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/"\$id":\s*(\d+)/);
    if (m) idOrder.push(parseInt(m[1]));
  }

  // For each $iref, check if the target exists and report what it is
  console.log(`\n--- \$iref target analysis ---`);
  let mismatches = 0;
  const seenIrefs = new Set();

  for (const ref of irefMap) {
    if (!seenIrefs.has(ref.id)) {
      seenIrefs.add(ref.id);
      const target = idMap.get(ref.id);
      if (!target) {
        console.log(`  *** MISSING \$id:${ref.id} (referenced at L${ref.line+1}, field: ${ref.field})`);
        mismatches++;
      }
    }
  }

  // Find irefs that could be type-mismatched by checking their surrounding context
  // vs the target's declared type
  console.log(`\n--- Field-by-field \$iref resolution ---`);

  // Group irefs by target ID to find all references to the same $id
  const irefsByTarget = new Map();
  for (const ref of irefMap) {
    if (!irefsByTarget.has(ref.id)) irefsByTarget.set(ref.id, []);
    irefsByTarget.get(ref.id).push(ref);
  }

  // For each unique target, show what type it has and who references it
  const sortedTargets = [...irefsByTarget.keys()].sort((a, b) => a - b);
  for (const id of sortedTargets) {
    const target = idMap.get(id);
    if (!target) continue; // already reported as missing

    const refs = irefsByTarget.get(id);
    const fields = [...new Set(refs.map(r => r.field))];

    // If this $id is referenced from fields with different expected types, warn
    if (fields.length > 1) {
      console.log(`  \$id:${id} (type=${target.type}) at L${target.line+1}`);
      console.log(`    Referenced by fields: ${fields.join(', ')} (${refs.length} refs)`);
      // Check if this is suspicious
      if (fields.some(f => f.includes('Position')) && fields.some(f => f.includes('Command') || f.includes('Event'))) {
        console.log(`    ⚠️  FIELD TYPE CONFLICT: same \$id used for position AND command/event data`);
        mismatches++;
      }
    }
  }

  // Specific check: delta between works and fails id ordering
  console.log(`\n--- First 30 \$id declarations ---`);
  for (let i = 0; i < Math.min(30, idOrder.length); i++) {
    const id = idOrder[i];
    const info = idMap.get(id);
    const line = lines[idMap.get(id)?.line ?? i];
    console.log(`  \$id ${String(id).padStart(4)} -> ${(info?.text || line.trim()).substring(0, 120)}`);
  }

  // Show any $id that's referenced by a field that doesn't match its type
  console.log(`\n--- Cross-field type consistency check ---`);
  const fieldTypeMap = new Map(); // fieldName -> set of $id values used
  for (const ref of irefMap) {
    if (!fieldTypeMap.has(ref.field)) fieldTypeMap.set(ref.field, new Set());
    fieldTypeMap.get(ref.field).add(ref.id);
  }

  // For fields that use $iref, check if the same $id is used for different fields
  for (const [field, ids] of fieldTypeMap) {
    if (ids.size > 1) {
      console.log(`  Field "${field}" references multiple \$ids: [${[...ids].join(',')}]`);
    }
  }

  if (mismatches === 0) {
    console.log('\n  No missing $id targets found for $iref references.');
  } else {
    console.log(`\n  *** ${mismatches} mismatches found`);
  }

  return { idMap, irefMap, idOrder };
}

const w = analyze(fs.readFileSync(WORKS,'utf-8'), 'WORKS');
const f = analyze(fs.readFileSync(FAILS,'utf-8'), 'FAILS');

// Compare $id ordering between works and fails
console.log(`\n${'='.repeat(72)}`);
console.log(`  WORKS vs FAILS: \$id ordering delta`);
console.log(`${'='.repeat(72)}`);

// Find the first difference in $id ordering
const minLen = Math.min(w.idOrder.length, f.idOrder.length);
let firstDiff = -1;
for (let i = 0; i < minLen; i++) {
  if (w.idOrder[i] !== f.idOrder[i]) {
    firstDiff = i;
    console.log(`\nFirst \$id order difference at position ${i}:`);
    console.log(`  WORKS: \$id:${w.idOrder[i]} ${w.idMap.get(w.idOrder[i])?.text || ''}`);
    console.log(`  FAILS: \$id:${f.idOrder[i]} ${f.idMap.get(f.idOrder[i])?.text || ''}`);
    break;
  }
}

if (firstDiff >= 0) {
  // Show the region around the first diff
  const start = Math.max(0, firstDiff - 3);
  const end = Math.min(minLen, firstDiff + 15);
  console.log(`\nId ordering comparison (positions ${start}-${end}):`);
  console.log('  Pos  | WORKS id | WORKS context    | FAILS id | FAILS context');
  for (let i = start; i < end; i++) {
    const wid = w.idOrder[i];
    const fid = f.idOrder[i];
    const wInfo = w.idMap.get(wid);
    const fInfo = f.idMap.get(fid);
    const wCtx = (wInfo?.text || '').substring(0, 40);
    const fCtx = (fInfo?.text || '').substring(0, 40);
    const marker = wid !== fid ? ' <<<' : '';
    console.log(`  ${String(i).padStart(3)}  | ${String(wid).padStart(4)}     | ${wCtx.padEnd(40)} | ${String(fid).padStart(4)}     | ${fCtx}${marker}`);
  }
}

// Check for specific known patterns that cause id mismatch:
// 1. _taxiPath / _rollingPresetTaxiPath sharing same $id
// 2. _position / _direction sharing same $id
// 3. $iref targets that are null vs non-null
console.log(`\n--- Known id-mismatch patterns ---`);
for (const [label, result] of [['WORKS', w], ['FAILS', f]]) {
  console.log(`\n${label}:`);
  const { idMap, irefMap, idOrder } = result;

  // Check all $iref:28 references (if any)
  const iref28s = irefMap.filter(r => r.id === 28);
  if (iref28s.length > 0) {
    const target28 = idMap.get(28);
    console.log(`  \$iref:28 references: ${iref28s.length}, target type: ${target28?.type || 'MISSING'}`);
    console.log(`  Fields using \$iref:28: ${[...new Set(iref28s.map(r => r.field))].join(', ')}`);
  }
}
