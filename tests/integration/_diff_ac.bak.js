// Quick diff script for .bak vs .acl aircraft entries
const fs = require('fs');

const aclPath = 'D:/SteamLibrary/steamapps/common/Airport Control 27 Demo/GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels/ZSJN_07-10.demo.acl';
const bakPath = aclPath + '.bak';

const origText = fs.readFileSync(bakPath, 'utf-8');
const newText = fs.readFileSync(aclPath, 'utf-8');

function extractAcRcontent(text) {
  const acIdx = text.indexOf('"Aircrafts"');
  const rest = text.substring(acIdx);
  const marker = 'rcontent": [';
  const rcIdx = rest.indexOf(marker);
  const start = acIdx + rcIdx + marker.length;
  let depth = 0, end = null;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    else if (text[i] === ']' && depth === 0) { end = i; break; }
  }
  return { content: text.substring(start, end), start, end };
}

function parseEntries(rcText) {
  const entries = [];
  let pos = 0;
  while (true) {
    const kIdx = rcText.indexOf('"$k":', pos);
    if (kIdx < 0) break;
    // Find the GUID value after "$k":
    const valStart = rcText.indexOf('"', kIdx + 5) + 1;
    const valEnd = rcText.indexOf('"', valStart);
    const guid = rcText.substring(valStart, valEnd);
    // Find "$v": {
    const vIdx = rcText.indexOf('"$v":', valEnd);
    if (vIdx < 0) break;
    const vStart = rcText.indexOf('{', vIdx);
    let depth = 0, vEnd = null;
    for (let i = vStart; i < rcText.length; i++) {
      if (rcText[i] === '{') depth++;
      else if (rcText[i] === '}') { depth--; if (depth === 0) { vEnd = i + 1; break; } }
    }
    if (!vEnd) break;
    const raw = rcText.substring(vStart, vEnd);
    entries.push({ guid, raw });
    pos = vEnd;
  }
  return entries;
}

function parseEntry(raw) {
  const state = (raw.match(/"State":\s*(\d+)/) || [])[1];
  const dynState = (raw.match(/"DynamicsState":\s*(\d+)/) || [])[1];
  const route = (raw.match(/"Route":\s*"([^"]*)"/) || [])[1] || '';
  const designator = (raw.match(/"Designator":\s*"([^"]*)"/) || [])[1] || '';
  const pr = (raw.match(/"ProgressRatio":\s*([\d.eE+-]+)/) || [])[1];
  const fpGuid = (raw.match(/"FlightPlanGuid":\s*"([^"]+)"/) || [])[1] || '';
  const chGuid = (raw.match(/"RadioChannelGuid":\s*"([^"]+)"/) || [])[1] || '';
  const jchGuid = (raw.match(/"JurisdictionRadioChannelGuid":\s*"([^"]+)"/) || [])[1] || '';

  let paramsType = '-';
  if (raw.includes('ApproachDynamicsParams')) paramsType = 'AppDP';
  else if (raw.includes('FlyApproachDynamicsParams')) paramsType = 'FlyDP';
  else if (raw.includes('RollingDynamicsParams')) paramsType = 'RolDP';

  return { state, dynState, route, designator, pr, fpGuid, chGuid, jchGuid, paramsType };
}

const origAc = extractAcRcontent(origText);
const newAc = extractAcRcontent(newText);

const origEntries = parseEntries(origAc.content).map(e => ({ guid: e.guid, ...parseEntry(e.raw) }));
const newEntries = parseEntries(newAc.content).map(e => ({ guid: e.guid, ...parseEntry(e.raw) }));

console.log('=== ORIGINAL (.bak): ' + origEntries.length + ' entries ===');
for (const e of origEntries) {
  console.log('  S=' + e.state + ' ds=' + e.dynState + ' dp=' + e.paramsType + ' rte=' + e.route + ' des=' + e.designator + ' pr=' + (e.pr ? parseFloat(e.pr).toFixed(3) : '-') + ' ch=' + (e.chGuid ? e.chGuid.substring(0,8) : 'null') + ' jch=' + (e.jchGuid ? e.jchGuid.substring(0,8) : 'null') + ' fp=' + (e.fpGuid ? e.fpGuid.substring(0,8) : 'null'));
}

console.log('');
console.log('=== NEW (.acl): ' + newEntries.length + ' entries ===');
for (const e of newEntries) {
  console.log('  S=' + e.state + ' ds=' + e.dynState + ' dp=' + e.paramsType + ' rte=' + e.route + ' des=' + e.designator + ' pr=' + (e.pr ? parseFloat(e.pr).toFixed(3) : '-') + ' ch=' + (e.chGuid ? e.chGuid.substring(0,8) : 'null') + ' jch=' + (e.jchGuid ? e.jchGuid.substring(0,8) : 'null') + ' fp=' + (e.fpGuid ? e.fpGuid.substring(0,8) : 'null'));
}

console.log('');
const origStates = {};
origEntries.forEach(e => origStates[e.state] = (origStates[e.state]||0)+1);
const newStates = {};
newEntries.forEach(e => newStates[e.state] = (newStates[e.state]||0)+1);
console.log('Original states:', JSON.stringify(origStates));
console.log('New states:     ', JSON.stringify(newStates));

// Compare
console.log('');
console.log('=== Diff ===');
const origByFp = new Map();
origEntries.forEach(e => { if (e.fpGuid) origByFp.set(e.fpGuid, e); });
const newByFp = new Map();
newEntries.forEach(e => { if (e.fpGuid) newByFp.set(e.fpGuid, e); });

// Entries in old but not new
for (const [fp, e] of origByFp) {
  if (!newByFp.has(fp)) console.log('  REMOVED: S=' + e.state + ' rte=' + e.route + ' fp=' + fp.substring(0,8));
}
// Entries in new but not old
for (const [fp, e] of newByFp) {
  if (!origByFp.has(fp)) console.log('  ADDED:   S=' + e.state + ' ds=' + e.dynState + ' dp=' + e.paramsType + ' rte=' + e.route + ' pr=' + (e.pr ? parseFloat(e.pr).toFixed(3) : '-') + ' fp=' + fp.substring(0,8));
}
// Same FP, different state
for (const [fp, e] of newByFp) {
  const old = origByFp.get(fp);
  if (old && old.state !== e.state) {
    console.log('  CHANGED: S=' + old.state + ' -> S=' + e.state + ' ds=' + old.dynState + '->' + e.dynState + ' dp=' + old.paramsType + '->' + e.paramsType + ' rte=' + old.route + '->' + e.route + ' fp=' + fp.substring(0,8));
  }
}
