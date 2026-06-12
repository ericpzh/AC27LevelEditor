// Audit CDG9663 diff between .bak and saved .acl in 27 Demo
const fs = require('fs');
const path = require('path');

const dir = 'D:/SteamLibrary/steamapps/common/Airport Control 27 Demo/GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels';
const bak = path.join(dir, 'ZSJN_07-10.demo.acl.bak');
const acl = path.join(dir, 'ZSJN_07-10.demo.acl');

for (const p of [bak, acl]) {
  const text = fs.readFileSync(p, 'utf-8');
  console.log('══════ ' + path.basename(p) + ' ══════');

  // Find CDG9663
  const csIdx = text.indexOf('CDG9663');
  if (csIdx < 0) { console.log('CDG9663 NOT FOUND\n'); continue; }

  // Find the FlightPlanState $k GUID before CDG9663
  const prefix = text.substring(0, csIdx);
  let lastKPos = -1, lastKGuid = null;
  let sp = 0;
  while (true) {
    const p = prefix.indexOf('"$k": "', sp);
    if (p < 0) break;
    const gs = p + 7;
    const ge = prefix.indexOf('"', gs);
    lastKGuid = prefix.substring(gs, ge);
    lastKPos = p;
    sp = ge;
  }
  console.log('FP GUID: ' + (lastKGuid || 'NOT FOUND'));

  if (lastKGuid) {
    // Find the $v block
    const vIdx = text.indexOf('"$v":', lastKPos);
    const vStart = text.indexOf('{', vIdx + 5);
    let d = 0, ve = null;
    for (let i = vStart; i < text.length; i++) {
      if (text[i] === '{') d++;
      else if (text[i] === '}') { d--; if (d === 0) { ve = i + 1; break; } }
    }
    const vBlock = text.substring(vStart, ve);

    const getStr = (key) => { const m = vBlock.match(new RegExp('"' + key + '":\\s*"([^"]*)"')); return m ? m[1] : ''; };
    const star = getStr('STAR');
    const runway = getStr('Runway');
    const cs = getStr('CallSign');
    const ltMatch = vBlock.match(/"LandingTime"[\s\S]{0,80}?(-?\d{15,20})/);
    let ltSec = null;
    if (ltMatch) {
      const ticks = BigInt(ltMatch[1]);
      const baseTicks = (ticks / 864000000000n) * 864000000000n;
      ltSec = Number((ticks - baseTicks) / 10000000n);
    }
    console.log('  CallSign: ' + cs + '  STAR: ' + star + '  Runway: ' + runway);
    if (ltSec != null) console.log('  LandingTime: ' + ltSec + 's = ' + Math.floor(ltSec/3600) + ':' + String(Math.floor((ltSec%3600)/60)).padStart(2,'0') + ':' + String(ltSec%60).padStart(2,'0'));

    // Find AircraftState entry
    const acIdx = text.indexOf('"Aircrafts"');
    const acRest = text.substring(acIdx);
    const gIdx = acRest.indexOf(lastKGuid);
    console.log('  In Aircrafts: ' + (gIdx >= 0 ? 'YES at +' + gIdx : 'NO'));

    if (gIdx >= 0) {
      const before = acRest.substring(0, gIdx);
      const lv = before.lastIndexOf('"$v": {');
      const vs = before.indexOf('{', lv + 6);
      let d = 0, ve = null;
      for (let i = vs; i < acRest.length; i++) {
        if (acRest[i] === '{') d++;
        else if (acRest[i] === '}') { d--; if (d === 0) { ve = i + 1; break; } }
      }
      const entry = acRest.substring(vs, ve);

      const state = (entry.match(/"State":\s*(\d+)/) || [])[1];
      const ds = (entry.match(/"DynamicsState":\s*(\d+)/) || [])[1];
      const pr = (entry.match(/"ProgressRatio":\s*([\d.eE+-]+)/) || [])[1];
      const route = (entry.match(/"Route":\s*"([^"]*)"/) || [])[1] || '';
      const des = (entry.match(/"Designator":\s*"([^"]*)"/) || [])[1] || '';
      const ch = (entry.match(/"RadioChannelGuid":\s*"([^"]+)"/) || [])[1] || 'null';
      const jch = (entry.match(/"JurisdictionRadioChannelGuid":\s*"([^"]+)"/) || [])[1] || 'null';
      const taxiSpeed = (entry.match(/"TaxiSpeed":\s*([\d.eE+-]+)/) || [])[1];
      const posM = entry.match(/"Position":\s*\{[^}]*?(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)/);
      const isFlyDP = entry.includes('FlyApproachDynamicsParams');
      const isAppDP = entry.includes('"ApproachDynamicsParams');

      console.log('  Aircraft:');
      console.log('    State: ' + state + '  DynState: ' + ds + '  PR: ' + (pr || 'N/A'));
      console.log('    Params: ' + (isFlyDP ? 'FlyApproachDP' : isAppDP ? 'ApproachDP' : 'none'));
      console.log('    Route: "' + route + '"  Designator: ' + des);
      console.log('    TaxiSpeed: ' + (taxiSpeed || 'N/A'));
      console.log('    RadioCh: ' + ch.substring(0,8) + '  JurisCh: ' + jch.substring(0,8));
      if (posM) console.log('    Position: (' + posM[1] + ', ' + posM[2] + ', ' + posM[3] + ')');

      // Show ApproachDynamicsParams details
      if (isAppDP || isFlyDP) {
        const ppCount = (entry.match(/"PathPointList"[\s\S]{0,50}?"\$rlength":\s*(\d+)/) || [])[1];
        if (ppCount) console.log('    PathPointList: ' + ppCount + ' points');
      }
    }
  }
  console.log('');
}
