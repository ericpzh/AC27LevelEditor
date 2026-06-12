#!/usr/bin/env node
/**
 * Glide Slope Audit — scans all .acl files for aircraft with InitialPosition,
 * matches each to its assigned runway's aiming_point, and computes the
 * 3D glide slope angle.
 *
 * Uses proper JSON.parse (handles Unity serialization via recursive traversal).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const AIRPORTS_DIR = path.resolve(
  'D:/SteamLibrary/steamapps/common/Airport Control 25 Playtest/GroundATC_Data/StreamingAssets/Airports'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function horizDist(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function glideAngleDeg(altitude, horizDist) {
  return (Math.atan(altitude / horizDist) * 180) / Math.PI;
}

function deg(a) { return a.toFixed(2) + '°'; }

// ---------------------------------------------------------------------------
// JSON parser that handles Unity's $type, $id, $iref, $rlength, $rcontent
// ---------------------------------------------------------------------------
function parseAcl(text) {
  // Unity serialization uses $iref:N (unquoted) which is not valid JSON.
  // Replace with null so JSON.parse can handle it. We don't need reference
  // resolution for our extraction.
  const cleaned = text.replace(/\$iref:\d+/g, 'null');
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// Extract data from parsed ACL object
// ---------------------------------------------------------------------------

/** Build Map: runwayName → aiming_point Position {x,y,z} */
function buildAimingPointMap(sceneryData) {
  const map = new Map();
  const taxiNodes = sceneryData.TaxiwayNodes;
  if (!taxiNodes || !taxiNodes.$rcontent) return map;

  for (const entry of taxiNodes.$rcontent) {
    const node = entry.$v;
    if (node.Aeroway === 'aiming_point' && node.Ref) {
      const pos = node.Position;
      map.set(node.Ref, {
        x: Array.isArray(pos) ? pos[0] : pos.x,
        y: Array.isArray(pos) ? pos[1] : pos.y,
        z: Array.isArray(pos) ? pos[2] : pos.z,
      });
    }
  }
  return map;
}

/** Build Map: flightPlanGuid → { runway, callsign, isArrival } */
function buildFlightPlanMap(worldState) {
  const map = new Map();
  const flightPlans = worldState.FlightPlans;
  if (!flightPlans || !flightPlans.$rcontent) return map;

  for (const entry of flightPlans.$rcontent) {
    const fp = entry.$v;
    const guid = fp.Guid || entry.$k;
    let runway = null;
    let callsign = null;
    let isArrival = false;

    if (fp.Arrival) {
      isArrival = true;
      runway = fp.Arrival.Runway || fp.Arrival.PlannedRunway || null;
      callsign = fp.Arrival.CallSign || null;
    } else if (fp.Departure) {
      isArrival = false;
      runway = fp.Departure.Runway || fp.Departure.PlannedRunway || null;
      callsign = fp.Departure.CallSign || null;
    }

    map.set(guid, { runway, callsign, isArrival, registration: fp.Registration, aircraftType: fp.AircraftType, airline: fp.AirlineName });
  }
  return map;
}

/**
 * Find all aircraft with InitialPosition.
 * Returns Array<{ aircraftGuid, flightPlanGuid, initialPos, touchDownPos, designator }>
 */
function findApproachAircraft(worldState) {
  const results = [];
  const aircrafts = worldState.Aircrafts;
  if (!aircrafts || !aircrafts.$rcontent) return results;

  for (const entry of aircrafts.$rcontent) {
    const ac = entry.$v;
    const dyn = ac.DynamicInternalState;
    if (!dyn || !dyn.DynamicsParams) continue;

    const dp = dyn.DynamicsParams;
    // Check if it's approach dynamics
    const dtype = typeof dp.$type === 'string' ? dp.$type : '';
    if (!dtype.includes('Approach') && !dtype.includes('approch')) {
      // Also check by presence of InitialPosition
      if (!dp.InitialPosition && !dp.initialPosition) continue;
    }

    const initPosRaw = dp.InitialPosition || dp.initialPosition;
    if (!initPosRaw) continue;

    const initPos = {
      x: Array.isArray(initPosRaw) ? initPosRaw[0] : initPosRaw.x,
      y: Array.isArray(initPosRaw) ? initPosRaw[1] : initPosRaw.y,
      z: Array.isArray(initPosRaw) ? initPosRaw[2] : initPosRaw.z,
    };

    const tdRaw = dp.TouchDownPosition || dp.touchDownPosition || null;
    const touchDownPos = tdRaw ? {
      x: Array.isArray(tdRaw) ? tdRaw[0] : tdRaw.x,
      y: Array.isArray(tdRaw) ? tdRaw[1] : tdRaw.y,
      z: Array.isArray(tdRaw) ? tdRaw[2] : tdRaw.z,
    } : null;

    results.push({
      aircraftGuid: ac.Guid || entry.$k,
      flightPlanGuid: ac.FlightPlanGuid,
      designator: (ac.Specification && ac.Specification.Designator) || '?',
      state: ac.State,
      initialPos: initPos,
      touchDownPos: touchDownPos,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Process a single file
// ---------------------------------------------------------------------------
function processFile(filePath) {
  const fileName = path.basename(filePath);
  const airport = path.basename(path.dirname(path.dirname(filePath)));
  const text = fs.readFileSync(filePath, 'utf-8');

  let data;
  try {
    data = parseAcl(text);
  } catch (e) {
    return { airport, fileName, error: `JSON parse failed: ${e.message}`, results: [] };
  }

  const aimingPoints = buildAimingPointMap(data.SceneryData);
  const fpMap = buildFlightPlanMap(data.WorldState);
  const aircraft = findApproachAircraft(data.WorldState);

  const results = [];
  for (const ac of aircraft) {
    const fp = fpMap.get(ac.flightPlanGuid);
    if (!fp) {
      results.push({ ...ac, airport, file: fileName, runway: '?', aimPoint: null, horizDist: null, glideAngle: null,
        callsign: '?', registration: '?', acType: '?', fpIsArrival: null,
        error: `FlightPlan ${ac.flightPlanGuid} not found` });
      continue;
    }
    if (!fp.runway) {
      results.push({ ...ac, airport, file: fileName, runway: '?', aimPoint: null, horizDist: null, glideAngle: null,
        callsign: fp.callsign, registration: fp.registration, acType: fp.aircraftType, fpIsArrival: fp.isArrival,
        error: `FlightPlan has no runway assignment` });
      continue;
    }

    const aimPoint = aimingPoints.get(fp.runway);
    if (!aimPoint) {
      results.push({ ...ac, airport, file: fileName, runway: fp.runway, aimPoint: null, horizDist: null, glideAngle: null,
        callsign: fp.callsign, registration: fp.registration, acType: fp.aircraftType, fpIsArrival: fp.isArrival,
        error: `No aiming_point for runway "${fp.runway}" (available: ${[...aimingPoints.keys()].join(', ')})` });
      continue;
    }

    const hd = horizDist(ac.initialPos, aimPoint);
    const ga = glideAngleDeg(ac.initialPos.y, hd);

    results.push({
      ...ac, airport, file: fileName, runway: fp.runway, aimPoint, horizDist: hd, glideAngle: ga,
      callsign: fp.callsign, registration: fp.registration, acType: fp.aircraftType, fpIsArrival: fp.isArrival,
      error: null,
    });
  }

  return { airport, fileName, error: null, results };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('═'.repeat(110));
console.log('  GLIDE SLOPE AUDIT — All aircraft with InitialPosition across all .acl files');
console.log('═'.repeat(110));

let allResults = [];
const airports = fs.readdirSync(AIRPORTS_DIR).filter(d => {
  const p = path.join(AIRPORTS_DIR, d);
  return fs.statSync(p).isDirectory() && d !== '.' && d !== '..';
});

for (const airport of airports.sort()) {
  const levelsDir = path.join(AIRPORTS_DIR, airport, 'Levels');
  if (!fs.existsSync(levelsDir)) continue;

  const aclFiles = fs.readdirSync(levelsDir).filter(f => f.endsWith('.acl'));
  if (aclFiles.length === 0) continue;

  console.log(`\n${'─'.repeat(110)}`);
  console.log(`  AIRPORT: ${airport}  (${aclFiles.length} .acl files)`);
  console.log(`${'─'.repeat(110)}`);

  for (const aclFile of aclFiles.sort()) {
    const filePath = path.join(levelsDir, aclFile);
    const { fileName, error, results } = processFile(filePath);

    if (error) {
      console.log(`  ${fileName}: ⚠ ${error}`);
      continue;
    }

    allResults = allResults.concat(results);

    if (results.length === 0) {
      console.log(`  ${fileName}: No aircraft with InitialPosition`);
      continue;
    }

    console.log(`\n  ▸ ${fileName}  (${results.length} aircraft with InitialPosition)`);

    for (const r of results) {
      if (r.error) {
        console.log(`      ${r.callsign.padEnd(10)} ${r.registration.padEnd(10)} ${r.acType.padEnd(18)} ⚠ ${r.error}`);
      } else {
        console.log(`      ${r.callsign.padEnd(10)} ${r.registration.padEnd(10)} ${r.acType.padEnd(18)} → RWY ${r.runway.padEnd(5)}  glide ${deg(r.glideAngle).padStart(7)}  |  ${r.horizDist.toFixed(1).padStart(7)}m horiz  ${r.initialPos.y.toFixed(2)}m alt  fp_is_arr=${r.fpIsArrival}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n\n${'═'.repeat(110)}`);
console.log('  SUMMARY');
console.log(`${'═'.repeat(110)}`);

const valid = allResults.filter(r => !r.error);
const errors = allResults.filter(r => r.error);

console.log(`\n  Total aircraft with InitialPosition: ${allResults.length}`);
console.log(`  Successfully matched:                ${valid.length}`);
console.log(`  Errors:                               ${errors.length}`);

if (valid.length > 0) {
  const angles = valid.map(r => r.glideAngle);
  const min = Math.min(...angles);
  const max = Math.max(...angles);
  const avg = angles.reduce((a, b) => a + b, 0) / angles.length;
  const variance = angles.reduce((s, a) => s + (a - avg) ** 2, 0) / angles.length;
  const stddev = Math.sqrt(variance);

  console.log(`\n  ── Glide Slope Statistics ──`);
  console.log(`  Min:    ${deg(min)}`);
  console.log(`  Max:    ${deg(max)}`);
  console.log(`  Mean:   ${deg(avg)}`);
  console.log(`  StdDev: ${deg(stddev)}`);
  console.log(`  Standard 3° glide slope difference from mean: ${deg(Math.abs(avg - 3))}`);

  // By airport
  console.log(`\n  ── By Airport ──`);
  const byAirport = {};
  for (const r of valid) {
    if (!byAirport[r.airport]) byAirport[r.airport] = [];
    byAirport[r.airport].push(r);
  }
  for (const [apt, recs] of Object.entries(byAirport).sort()) {
    const anglesA = recs.map(r => r.glideAngle);
    console.log(`  ${apt.padEnd(6)}: ${String(recs.length).padStart(2)} aircraft  mean ${deg(anglesA.reduce((a,b)=>a+b,0)/anglesA.length)}  min ${deg(Math.min(...anglesA))}  max ${deg(Math.max(...anglesA))}`);
  }

  // By runway (airport/runway)
  console.log(`\n  ── By Runway ──`);
  const byRunway = {};
  for (const r of valid) {
    const key = `${r.airport}/${r.runway}`;
    if (!byRunway[key]) byRunway[key] = [];
    byRunway[key].push(r);
  }
  for (const [key, recs] of Object.entries(byRunway).sort()) {
    const anglesR = recs.map(r => r.glideAngle);
    console.log(`  ${key.padEnd(24)} ${String(recs.length).padStart(2)} ac  mean ${deg(anglesR.reduce((a,b)=>a+b,0)/anglesR.length)}  min ${deg(Math.min(...anglesR))}  max ${deg(Math.max(...anglesR))}  ${recs.map(r=>r.callsign).join(', ')}`);
  }

  // Full detail table
  console.log(`\n  ── Full Detail ──`);
  console.log(`  ${'Airport'.padEnd(8)} ${'File'.padEnd(35)} ${'CallSign'.padEnd(12)} ${'Reg'.padEnd(10)} ${'Type'.padEnd(20)} ${'RWY'.padEnd(6)} ${'Glide'.padEnd(8)} ${'HorizDist'.padEnd(12)} ${'Alt(m)'.padEnd(10)} ${'InitPos(x,z)'.padEnd(30)} ${'AimPt(x,z)'}`);
  console.log(`  ${'─'.repeat(8)} ${'─'.repeat(35)} ${'─'.repeat(12)} ${'─'.repeat(10)} ${'─'.repeat(20)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(12)} ${'─'.repeat(10)} ${'─'.repeat(30)} ${'─'.repeat(20)}`);

  for (const r of allResults.sort((a,b) => (a.airport+b.file).localeCompare(b.airport+b.file))) {
    if (r.error) {
      console.log(`  ${r.airport.padEnd(8)} ${r.file.padEnd(35)} ${(r.callsign||'?').padEnd(12)} ⚠ ${r.error}`);
    } else {
      console.log(`  ${r.airport.padEnd(8)} ${r.file.padEnd(35)} ${(r.callsign||'?').padEnd(12)} ${(r.registration||'?').padEnd(10)} ${(r.acType||'?').padEnd(20)} ${r.runway.padEnd(6)} ${deg(r.glideAngle).padEnd(8)} ${r.horizDist.toFixed(1).padEnd(12)} ${r.initialPos.y.toFixed(2).padEnd(10)} (${r.initialPos.x.toFixed(1)}, ${r.initialPos.z.toFixed(1)})`.padEnd(30) + ` (${r.aimPoint.x.toFixed(1)}, ${r.aimPoint.z.toFixed(1)})`);
    }
  }
}

if (errors.length > 0) {
  console.log(`\n  ── Errors ──`);
  for (const e of errors) {
    console.log(`  ${e.file} | ${e.callsign || '?'} | ${e.error}`);
  }
}

console.log();
