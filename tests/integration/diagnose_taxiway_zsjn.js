/**
 * Diagnostic script: Analyze ZSJN taxiway A & B connectivity.
 * Usage: node tests/integration/diagnose_taxiway_zsjn.js
 */

const { parseTaxiwayPaths } = require('../../src/acl/taxiway');
const fs = require('fs');
const path = require('path');

const fixtureAcl = path.join(__dirname, '..', 'fixtures', 'game-root',
  'GroundATC_Data', 'StreamingAssets', 'Airports', 'ZSJN', 'Levels', 'ZSJN-Morning_120min.acl');

if (!fs.existsSync(fixtureAcl)) {
  console.error('Fixture not found:', fixtureAcl);
  process.exit(1);
}

const aclText = fs.readFileSync(fixtureAcl, 'utf8');
const result = parseTaxiwayPaths(aclText);

console.log('Total taxiway segments:', result.paths.length);

// Group segments by name
const byName = {};
for (const tp of result.paths) {
  const name = tp.name || '(unnamed)';
  if (!byName[name]) byName[name] = [];
  byName[name].push(tp);
}

console.log('\n=== Taxiway segments by name ===');
const sortedNames = Object.keys(byName).sort();
for (const name of sortedNames) {
  console.log(`  ${name}: ${byName[name].length} segments`);
}

// Analyze connectivity for taxiways A and B
function analyzeConnectivity(name, segments) {
  console.log(`\n=== Connectivity analysis for taxiway "${name}" (${segments.length} segments) ===`);

  // Build a graph: for each node (by coordinate key), list segments that touch it
  const coordKey = (p) => `${p.x.toFixed(6)},${p.z.toFixed(6)}`;
  const nodeToSegments = new Map();
  const segmentEndpoints = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const p0 = seg.points[0];
    const p1 = seg.points[seg.points.length - 1];
    const k0 = coordKey(p0);
    const k1 = coordKey(p1);
    segmentEndpoints.push({ idx: i, k0, k1, p0, p1 });

    if (!nodeToSegments.has(k0)) nodeToSegments.set(k0, []);
    nodeToSegments.get(k0).push(i);
    if (k1 !== k0) {
      if (!nodeToSegments.has(k1)) nodeToSegments.set(k1, []);
      nodeToSegments.get(k1).push(i);
    }
  }

  // Find connected components
  const visited = new Set();
  const components = [];

  for (let i = 0; i < segments.length; i++) {
    if (visited.has(i)) continue;
    // BFS to find all segments in this component
    const component = [];
    const queue = [i];
    visited.add(i);
    while (queue.length > 0) {
      const cur = queue.shift();
      component.push(cur);
      const ep = segmentEndpoints[cur];
      // All segments sharing either endpoint
      for (const k of [ep.k0, ep.k1]) {
        const neighbors = nodeToSegments.get(k) || [];
        for (const n of neighbors) {
          if (!visited.has(n)) {
            visited.add(n);
            queue.push(n);
          }
        }
      }
    }
    components.push(component);
  }

  console.log(`  Connected components: ${components.length}`);
  for (let c = 0; c < components.length; c++) {
    const comp = components[c];
    console.log(`  Component ${c + 1}: ${comp.length} segments, indices [${comp[0]}..${comp[comp.length - 1]}]`);
    // Print the first and last segments
    const first = segmentEndpoints[comp[0]];
    const last = segmentEndpoints[comp[comp.length - 1]];
    console.log(`    First seg: (${first.p0.x.toFixed(1)}, ${first.p0.z.toFixed(1)}) -> (${first.p1.x.toFixed(1)}, ${first.p1.z.toFixed(1)})`);
    console.log(`    Last seg:  (${last.p0.x.toFixed(1)}, ${last.p0.z.toFixed(1)}) -> (${last.p1.x.toFixed(1)}, ${last.p1.z.toFixed(1)})`);
  }

  // Check endpoint sharing precision
  console.log(`\n  Endpoint precision check:`);
  let closeButNotExact = 0;
  const threshold = 0.001;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const si = segmentEndpoints[i];
      const sj = segmentEndpoints[j];
      for (const pk of [si.k0, si.k1]) {
        for (const qk of [sj.k0, sj.k1]) {
          if (pk === qk) continue; // exact match
          const [px, pz] = pk.split(',').map(Number);
          const [qx, qz] = qk.split(',').map(Number);
          const dist = Math.sqrt((px - qx) ** 2 + (pz - qz) ** 2);
          if (dist < threshold) {
            closeButNotExact++;
            if (closeButNotExact <= 5) {
              console.log(`    Near-match: seg${i} (${pk}) vs seg${j} (${qk}), dist=${dist.toFixed(6)}`);
            }
          }
        }
      }
    }
  }
  console.log(`    Close-but-not-exact endpoints (< ${threshold}): ${closeButNotExact}`);

  // Dump all segments with their coordinates
  console.log(`\n  All segments:`);
  for (let i = 0; i < segments.length; i++) {
    const ep = segmentEndpoints[i];
    const midX = (ep.p0.x + ep.p1.x) / 2;
    const midZ = (ep.p0.z + ep.p1.z) / 2;
    const len = Math.sqrt((ep.p1.x - ep.p0.x) ** 2 + (ep.p1.z - ep.p0.z) ** 2);
    console.log(`    seg${i}: (${ep.p0.x.toFixed(2)}, ${ep.p0.z.toFixed(2)}) -> (${ep.p1.x.toFixed(2)}, ${ep.p1.z.toFixed(2)})  mid=(${midX.toFixed(1)}, ${midZ.toFixed(1)})  len=${len.toFixed(1)}`);
  }

  return { components, nodeToSegments, segmentEndpoints };
}

// Analyze A and B
if (byName['A']) analyzeConnectivity('A', byName['A']);
if (byName['B']) analyzeConnectivity('B', byName['B']);

// Also look at E and N for context
if (byName['E']) {
  console.log(`\n=== Taxiway E: ${byName['E'].length} segments (for spatial context) ===`);
  for (const seg of byName['E']) {
    const p0 = seg.points[0], p1 = seg.points[seg.points.length - 1];
    console.log(`  (${p0.x.toFixed(1)}, ${p0.z.toFixed(1)}) -> (${p1.x.toFixed(1)}, ${p1.z.toFixed(1)})`);
  }
}
if (byName['N']) {
  console.log(`\n=== Taxiway N: ${byName['N'].length} segments (for spatial context) ===`);
  for (const seg of byName['N']) {
    const p0 = seg.points[0], p1 = seg.points[seg.points.length - 1];
    console.log(`  (${p0.x.toFixed(1)}, ${p0.z.toFixed(1)}) -> (${p1.x.toFixed(1)}, ${p1.z.toFixed(1)})`);
  }
}

// Check overall: are there unnamed segments between the spatial area of E and N that
// might be part of A/B but unnamed?
console.log('\n=== Checking unnamed segments near E/N gap ===');
// Find bounding box of all E segments
if (byName['E'] && byName['N']) {
  let eMinX = Infinity, eMaxX = -Infinity, eMinZ = Infinity, eMaxZ = -Infinity;
  for (const seg of byName['E']) {
    for (const p of seg.points) {
      eMinX = Math.min(eMinX, p.x); eMaxX = Math.max(eMaxX, p.x);
      eMinZ = Math.min(eMinZ, p.z); eMaxZ = Math.max(eMaxZ, p.z);
    }
  }
  let nMinX = Infinity, nMaxX = -Infinity, nMinZ = Infinity, nMaxZ = -Infinity;
  for (const seg of byName['N']) {
    for (const p of seg.points) {
      nMinX = Math.min(nMinX, p.x); nMaxX = Math.max(nMaxX, p.x);
      nMinZ = Math.min(nMinZ, p.z); nMaxZ = Math.max(nMaxZ, p.z);
    }
  }
  console.log(`  E bounds: X=[${eMinX.toFixed(1)}, ${eMaxX.toFixed(1)}], Z=[${eMinZ.toFixed(1)}, ${eMaxZ.toFixed(1)}]`);
  console.log(`  N bounds: X=[${nMinX.toFixed(1)}, ${nMaxX.toFixed(1)}], Z=[${nMinZ.toFixed(1)}, ${nMaxZ.toFixed(1)}]`);

  // Gap region between E and N
  const gapMinX = Math.min(eMinX, nMinX) - 5;
  const gapMaxX = Math.max(eMaxX, nMaxX) + 5;
  const gapMinZ = Math.min(eMinZ, nMinZ) - 5;
  const gapMaxZ = Math.max(eMaxZ, nMaxZ) + 5;
  console.log(`  Gap region: X=[${gapMinX.toFixed(1)}, ${gapMaxX.toFixed(1)}], Z=[${gapMinZ.toFixed(1)}, ${gapMaxZ.toFixed(1)}]`);

  // Find ALL segments (any name) in this region
  const regionSegs = [];
  for (const tp of result.paths) {
    const p0 = tp.points[0], p1 = tp.points[tp.points.length - 1];
    const midX = (p0.x + p1.x) / 2, midZ = (p0.z + p1.z) / 2;
    if (midX >= gapMinX && midX <= gapMaxX && midZ >= gapMinZ && midZ <= gapMaxZ) {
      regionSegs.push(tp);
    }
  }
  console.log(`  Segments in gap region: ${regionSegs.length}`);
  const byNameGap = {};
  for (const seg of regionSegs) {
    const n = seg.name || '(unnamed)';
    if (!byNameGap[n]) byNameGap[n] = [];
    byNameGap[n].push(seg);
  }
  for (const [n, segs] of Object.entries(byNameGap).sort()) {
    console.log(`    ${n}: ${segs.length} segments`);
  }
}
