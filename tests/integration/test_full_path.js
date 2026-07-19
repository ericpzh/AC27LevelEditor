/**
 * Full path analysis: total game path (fly+proc+td) × threshold_scale / 240kts
 * vs aircraft-derived TAT
 */
const fs = require('fs');
const path = require('path');
const approach = require('../../src/acl/approach');
const { readAclText } = require('../../src/acl/gatcarc');

const BASE = 'D:/SteamLibrary/steamapps/common/Airport Control 25 Playtest/GroundATC_Data/StreamingAssets/Airports';
const SPEED = 240 * 0.514444;

const THRESHOLD_GAME = {
  'ZSJN|01': 37.32, 'ZSJN|19': 37.32,
  'KJFK|4R': 25.63, 'KJFK|22L': 25.63,
  'KJFK|4L': 24.97, 'KJFK|22R': 24.97,
  'KJFK|13L': 24.55, 'KJFK|31R': 24.55,
  'KJFK|13R': 28.01, 'KJFK|31L': 28.01,
};
const RWY_REAL = {
  ZSJN: { '01': 3601, '19': 3601 },
  KJFK: { '4R': 2560, '4L': 3682, '22L': 2560, '22R': 3682, '13L': 3048, '13R': 4423, '31R': 3048, '31L': 4423 },
};

function processAirport(icao, files) {
  const firstText = readAclText(BASE + '/' + icao + '/Levels/' + files[0] + '.acl');

  // Collect all entries across all files
  const allEntries = [];
  for (const file of files) {
    const text = readAclText(BASE + '/' + icao + '/Levels/' + file + '.acl');
    const entries = approach.extractApproachData(text).filter(e => e.landingTimeTicks > 0 && e.route && e.runway);
    for (const e of entries) e._file = file;
    allEntries.push(...entries);
  }

  const byKey = new Map();
  for (const e of allEntries) {
    const key = e.route + '|' + e.runway;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }

  console.log('=== ' + icao + ' ===');
  console.log('STAR                Rwy  GamePath  Scale  RealPath  T@240kt  A-TAT   Err%  #AC');
  console.log('-'.repeat(85));

  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const [star, runway] = key.split('|');
    if (!runway) continue;

    // Full path from first file
    const flyPts = approach.resolveFlyApproachPoints(firstText, star, runway);
    const procData = approach.resolveApproachProcedureData(firstText, runway);
    const procPts = procData ? procData.pathPointList : [];
    const tdPos = procData ? procData.touchDownPosition : null;

    const flyLen = flyPts && flyPts.length >= 2 ? approach.computePathLength(flyPts) : 0;
    const procLen = procPts && procPts.length >= 2 ? approach.computePathLength(procPts) : 0;
    let tdDist = 0;
    if (procPts && procPts.length > 0 && tdPos) {
      const last = procPts[procPts.length - 1];
      tdDist = Math.sqrt((last.x - tdPos.x) ** 2 + (last.z - tdPos.z) ** 2);
    }
    const totalGame = flyLen + procLen + tdDist;

    // A-TAT from pairs within same file
    const ratios = [];
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i]._file !== group[j]._file) continue;
        const dPR = Math.abs(group[i].progressRatio - group[j].progressRatio);
        const dLT = Math.abs(group[i].landingTimeTicks - group[j].landingTimeTicks);
        const dSec = dLT / 10000000;
        if (dPR > 0.001 && dSec > 0) ratios.push(dSec / dPR);
      }
    }
    if (ratios.length === 0) continue;
    ratios.sort((a, b) => a - b);
    const aTAT = Math.round(ratios[Math.floor(ratios.length / 2)]);

    // Threshold scale
    const realRwy = (RWY_REAL[icao] || {})[runway] || 3601;
    const gameThreshold = THRESHOLD_GAME[icao + '|' + runway] || 30;
    const scale = realRwy / gameThreshold;
    const realPath = totalGame * scale;
    const termTime = realPath / SPEED;
    const errPct = (termTime - aTAT) / aTAT * 100;

    console.log(
      star.padEnd(20) + runway.padEnd(4) +
      totalGame.toFixed(0).padStart(9) + scale.toFixed(1).padStart(8) +
      (realPath / 1000).toFixed(1).padStart(7) + 'km' +
      termTime.toFixed(0).padStart(9) + String(aTAT).padStart(8) +
      errPct.toFixed(1) + '%'.padStart(6) + String(group.length).padStart(5)
    );
  }
}

const zsjnFiles = ['ZSJN-Morning_120min', 'ZSJN_07-10', 'ZSJN-Evening_120min', 'ZSJN_19-21'];
const kjfkFiles = ['KJFK_07-09', 'KJFK_09-11', 'KJFK_17-20', 'KJFK_20-22'];

processAirport('ZSJN', zsjnFiles);
console.log('');
processAirport('KJFK', kjfkFiles);
