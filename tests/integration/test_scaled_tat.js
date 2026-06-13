/**
 * Diagnostic: Scale terminal path by runway threshold ratio to get real-world meters,
 * then compute TAT = realPath / 240kts. Compare against aircraft-derived TAT.
 *
 * Usage:
 *   node --require ./tests/integration/preload.cjs tests/integration/test_scaled_tat.js [--root <game-root>]
 */
const fs = require('fs');
const path = require('path');

let gameRoot = path.resolve(__dirname, '..', '..', '..');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--root' && i + 1 < process.argv.length) {
    gameRoot = path.resolve(process.argv[i + 1]);
  }
}

const dataDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports');
const approach = require('../../src/acl/approach');

// Real-world runway lengths (meters)
const RWY_REAL = {
  ZSJN: { '01/19': 3601 },
  KJFK: { '4L/22R': 3682, '4R/22L': 2560, '13L/31R': 3048, '13R/31L': 4423 },
};

const APPROACH_SPEED_MS = 240 * 0.514444; // 123.47 m/s

// ── Helpers ──

function findDictEntryValue(text, guid) {
  // Search entire text for "$k": "guid" and return the $v block
  const searchStr = '"$k": "' + guid + '"';
  const kIdx = text.indexOf(searchStr);
  if (kIdx < 0) return null;
  const afterK = text.substring(kIdx);
  const vIdx = afterK.indexOf('"$v"');
  if (vIdx < 0) return null;
  const vStart = afterK.indexOf('{', vIdx);
  let d = 0, vEnd = -1;
  for (let i = vStart; i < afterK.length; i++) {
    if (afterK[i] === '{') d++;
    else if (afterK[i] === '}') { d--; if (d === 0) { vEnd = i + 1; break; } }
  }
  return afterK.substring(vStart, vEnd);
}

function extractVector3(block) {
  const pi = block.indexOf('"Position"');
  if (pi < 0) return null;
  const after = block.substring(pi);
  const ob = after.indexOf('{');
  const cb = after.indexOf('}', ob);
  const parts = after.substring(ob + 1, cb).split(',');
  if (parts.length >= 4) return { x: +parts[1], y: +parts[2], z: +parts[3] };
  return null;
}

function computeRunwayScales(aclPath, icao) {
  const text = fs.readFileSync(aclPath, 'utf-8');
  const sdText = text.substring(text.indexOf('"SceneryData"'));

  // Find Runways section and iterate entries
  const rwIdx = sdText.indexOf('"Runways"');
  const rwText = sdText.substring(rwIdx);
  const rcIdx = rwText.indexOf('$rcontent');
  const bracket = rwText.indexOf('[', rcIdx);
  let depth = 0, end = -1;
  for (let i = bracket; i < rwText.length; i++) {
    if (rwText[i] === '[') depth++;
    else if (rwText[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  const arrText = rwText.substring(bracket, end + 1);

  const runways = [];

  // Parse each entry in the $rcontent array
  let d = 0, start = -1;
  for (let i = 0; i < arrText.length; i++) {
    if (arrText[i] === '{') { if (d === 0) start = i; d++; }
    else if (arrText[i] === '}') {
      d--;
      if (d === 0 && start >= 0) {
        const entry = arrText.substring(start, i + 1);
        const vIdx = entry.indexOf('"$v"');
        if (vIdx >= 0) {
          const vs = entry.indexOf('{', vIdx);
          let vd = 0, ve = -1;
          for (let j = vs; j < entry.length; j++) {
            if (entry[j] === '{') vd++;
            else if (entry[j] === '}') { vd--; if (vd === 0) { ve = j + 1; break; } }
          }
          if (ve >= 0) {
            const vBlock = entry.substring(vs, ve);

            // Extract metadata
            const pnMatch = vBlock.match(/"PhysicalName":\s*"([^"]*)"/);
            const nMatch = vBlock.match(/"Name":\s*"([^"]*)"/);
            const physName = pnMatch ? pnMatch[1] : null;
            const rwyName = nMatch ? nMatch[1] : null;

            // Extract ThresholdPointGuids
            const tpIdx = vBlock.indexOf('"ThresholdPointGuids"');
            if (tpIdx >= 0) {
              const tpAfter = vBlock.substring(tpIdx);
              const trc = tpAfter.indexOf('$rcontent');
              if (trc >= 0) {
                const tb = tpAfter.indexOf('[', trc);
                let tpd = 0, te = -1;
                for (let j = tb; j < tpAfter.length; j++) {
                  if (tpAfter[j] === '[') tpd++;
                  else if (tpAfter[j] === ']') { tpd--; if (tpd === 0) { te = j; break; } }
                }
                const tpArr = tpAfter.substring(tb + 1, te);
                const gm = tpArr.match(/"([a-f0-9-]+)"/g);
                if (gm && gm.length === 2) {
                  const g1 = gm[0].replace(/"/g, '');
                  const g2 = gm[1].replace(/"/g, '');

                  // Find positions - search all sections in text for these GUIDs
                  let p1 = null, p2 = null;
                  for (const guid of [g1, g2]) {
                    const vEntry = findDictEntryValue(text, guid);
                    const pos = vEntry ? extractVector3(vEntry) : null;
                    if (!p1) p1 = pos; else p2 = pos;
                  }

                  if (p1 && p2) {
                    const gameDist = Math.sqrt(
                      (p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2 + (p1.z - p2.z) ** 2
                    );
                    const realLen = RWY_REAL[icao] ? (RWY_REAL[icao][physName] || null) : null;
                    const scale = realLen ? realLen / gameDist : null;
                    runways.push({ physName, rwyName, gameDist, realLen, scale });
                  }
                }
              }
            }
          }
        }
        start = -1;
      }
    }
  }
  return runways;
}

// ── Step 1: Compute all runway scales ──

console.log('='.repeat(95));
console.log('STEP 1: Runway Scale Factors (real runway length / in-game threshold distance)');
console.log('='.repeat(95));

const allScales = new Map(); // 'icao|runwayName' → scale

for (const [icao, firstFile] of [
  ['ZSJN', 'ZSJN-Morning_120min'],
  ['KJFK', 'KJFK_07-09'],
]) {
  const aclPath = path.join(dataDir, icao, 'Levels', firstFile + '.acl');
  if (!fs.existsSync(aclPath)) continue;

  console.log('\n  ' + icao + ':');
  const runways = computeRunwayScales(aclPath, icao);
  for (const r of runways) {
    console.log(
      '    ' + (r.physName || '?').padEnd(12) +
      'name=' + (r.rwyName || '?').padEnd(6) +
      'game=' + r.gameDist.toFixed(2).padStart(8) +
      ' real=' + String(r.realLen || '?').padStart(5) + 'm' +
      '  => scale=' + (r.scale ? r.scale.toFixed(2) : 'N/A').padStart(8) + ' m/unit'
    );
    if (r.scale && r.rwyName) {
      allScales.set(icao + '|' + r.rwyName, r.scale);
      // Also map by PhysicalName components
      if (r.physName) {
        const parts = r.physName.split('/');
        for (const p of parts) allScales.set(icao + '|' + p, r.scale);
      }
    }
  }
}

// ── Shared file list ──

const files = [
  { icao: 'ZSJN', name: 'ZSJN-Morning_120min' },
  { icao: 'ZSJN', name: 'ZSJN_07-10' },
  { icao: 'ZSJN', name: 'ZSJN-Evening_120min' },
  { icao: 'ZSJN', name: 'ZSJN_19-21' },
  { icao: 'KJFK', name: 'KJFK_07-09' },
  { icao: 'KJFK', name: 'KJFK_09-11' },
  { icao: 'KJFK', name: 'KJFK_17-20' },
  { icao: 'KJFK', name: 'KJFK_20-22' },
];

// ── Step 2: Apply FIXED scale=100 to terminal paths ──

console.log('\n' + '='.repeat(95));
console.log('STEP 2a: Fixed scale=100 m/unit — TAT = (flyLen + procLen) * 100 / 123.47');
console.log('='.repeat(95));

console.log(
  'STAR                Rwy   ICAO  #AC  GamePath  TermT(s)  A-TAT(s)   Err%'
);
console.log('-'.repeat(76));

const FIXED_SCALE = 100;
const SPEED_MS = 240 * 0.514444;
const fixedResults = [];

for (const f of files) {
  const aclPath = path.join(dataDir, f.icao, 'Levels', f.name + '.acl');
  if (!fs.existsSync(aclPath)) continue;
  const text = fs.readFileSync(aclPath, 'utf-8');
  const entries = approach.extractApproachData(text).filter(e => e.landingTimeTicks > 0 && e.route && e.runway);

  const byKey = new Map();
  for (const e of entries) {
    const key = e.route + '|' + e.runway;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }

  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const star = group[0].route;
    const runway = group[0].runway;

    // Aircraft TAT
    const ratios = [];
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const dPR = Math.abs(group[i].progressRatio - group[j].progressRatio);
        const dLT = Math.abs(group[i].landingTimeTicks - group[j].landingTimeTicks);
        const dSec = dLT / 10000000;
        if (dPR > 0.001 && dSec > 0) ratios.push(dSec / dPR);
      }
    }
    if (ratios.length === 0) continue;
    ratios.sort((a, b) => a - b);
    const aTAT = Math.round(ratios[Math.floor(ratios.length / 2)]);

    // Terminal path
    const flyPoints = approach.resolveFlyApproachPoints(text, star, runway);
    const procData = approach.resolveApproachProcedureData(text, runway);
    const procPoints = procData ? procData.pathPointList : [];
    const gamePath = approach.computePathLength(flyPoints) + approach.computePathLength(procPoints);

    const termTime = gamePath * FIXED_SCALE / SPEED_MS;
    const errPct = (termTime - aTAT) / aTAT * 100;

    const line = [
      star.padEnd(20), runway.padEnd(5), f.icao.padEnd(5),
      String(group.length).padStart(4), gamePath.toFixed(0).padStart(9),
      termTime.toFixed(0).padStart(9), String(aTAT).padStart(9),
      errPct.toFixed(1) + '%'
    ].join('');
    console.log(line);

    fixedResults.push({ star, runway, icao: f.icao, count: group.length, gamePath, termTime, aTAT, errPct });
  }
}

// Summary for fixed scale
if (fixedResults.length > 0) {
  const absErrs = fixedResults.map(r => Math.abs(r.errPct));
  const meanAbs = absErrs.reduce((s, e) => s + e, 0) / absErrs.length;
  const within10 = absErrs.filter(e => e <= 10).length;
  const within15 = absErrs.filter(e => e <= 15).length;
  console.log('');
  console.log('Fixed scale=100: Mean abs error = ' + meanAbs.toFixed(1) + '%  |  Within 10%: ' + within10 + '/' + fixedResults.length + '  |  Within 15%: ' + within15 + '/' + fixedResults.length);
}

// ── Step 3: Apply per-runway scale to terminal paths (for comparison) ──

console.log('\n' + '='.repeat(95));
console.log('STEP 2: Scaled Terminal Time vs Aircraft TAT');
console.log('='.repeat(95));

console.log(
  'STAR                Rwy   ICAO  GamePath  Scale   RealPath   TermT   A-TAT   Err%    #AC'
);
console.log('-'.repeat(95));

const allResults = [];

for (const f of files) {
  const aclPath = path.join(dataDir, f.icao, 'Levels', f.name + '.acl');
  if (!fs.existsSync(aclPath)) continue;
  const text = fs.readFileSync(aclPath, 'utf-8');
  const entries = approach.extractApproachData(text).filter(
    e => e.landingTimeTicks > 0 && e.route && e.runway
  );

  // Group by (STAR, runway)
  const byKey = new Map();
  for (const e of entries) {
    const key = e.route + '|' + e.runway;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }

  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const star = group[0].route;
    const runway = group[0].runway;

    // Aircraft TAT from pairs
    const ratios = [];
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const dPR = Math.abs(group[i].progressRatio - group[j].progressRatio);
        const dLT = Math.abs(group[i].landingTimeTicks - group[j].landingTimeTicks);
        const dSec = dLT / 10000000;
        if (dPR > 0.001 && dSec > 0) ratios.push(dSec / dPR);
      }
    }
    if (ratios.length === 0) continue;
    ratios.sort((a, b) => a - b);
    const aTAT = Math.round(ratios[Math.floor(ratios.length / 2)]);

    // Terminal path from SceneryData
    const flyPoints = approach.resolveFlyApproachPoints(text, star, runway);
    const procData = approach.resolveApproachProcedureData(text, runway);
    const procPoints = procData ? procData.pathPointList : [];
    const flyLen = approach.computePathLength(flyPoints);
    const procLen = approach.computePathLength(procPoints);
    const gamePath = flyLen + procLen;

    // Get scale
    const scale = allScales.get(f.icao + '|' + runway);
    if (!scale) {
      console.log(star.padEnd(17) + runway.padEnd(5) + f.icao.padEnd(5) +
        gamePath.toFixed(0).padStart(9) + 'N/A'.padStart(8) + '-'.padStart(10) +
        '-'.padStart(8) + String(aTAT).padStart(8) + '?'.padStart(7) + String(group.length).padStart(5) +
        '  (no scale for ' + f.icao + '/' + runway + ')');
      continue;
    }

    const realPath = gamePath * scale;
    const termTime = realPath / APPROACH_SPEED_MS;
    const errPct = ((termTime - aTAT) / aTAT * 100);

    const line = [
      star.padEnd(20), runway.padEnd(6), f.icao.padEnd(6),
      gamePath.toFixed(0).padStart(9), scale.toFixed(1).padStart(8),
      realPath.toFixed(0).padStart(10), termTime.toFixed(0).padStart(8),
      String(aTAT).padStart(8), errPct.toFixed(1).padStart(7) + '%', String(group.length).padStart(5)
    ].join('');
    console.log(line);

    allResults.push({ star, runway, icao: f.icao, gamePath, scale, realPath, termTime, aTAT, errPct, count: group.length });
  }
}

// ── Summary ──

if (allResults.length > 0) {
  const absErrs = allResults.map(r => Math.abs(r.errPct));
  const meanAbsErr = absErrs.reduce((s, e) => s + e, 0) / absErrs.length;
  const maxAbsErr = Math.max(...absErrs);
  console.log('\n' + '='.repeat(95));
  console.log('SUMMARY: Mean abs error = ' + meanAbsErr.toFixed(1) + '%  Max abs error = ' + maxAbsErr.toFixed(1) + '%  across ' + allResults.length + ' STAR/runway combos');
  console.log('Model: TAT = (flyLen + procLen) * realRunwayLength / gameThresholdDistance / 123.47');
}
