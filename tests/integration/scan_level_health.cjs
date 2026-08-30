#!/usr/bin/env node
/** Health table for every ZSJN .acl level: entity counts + dangling $iref count. */
const fs = require('fs');
const path = require('path');
const { parseArchive, decodePayloadToText } = require('../../src/acl/gatcarc');

const dir = 'D:/SteamLibrary/steamapps/common/Airport Control 25 Playtest/GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels';

const files = fs.readdirSync(dir).sort();
console.log('FILE'.padEnd(40) + 'BYTES'.padStart(9) + '  PK  NODES  SEGS   IDS  DANGLING  FRAMES');
console.log('-'.repeat(92));

for (const f of files) {
  const p = path.join(dir, f);
  if (!/\.acl(\.bak|\.corrupt\.bak|\.pre-repair\.bak)?$/.test(f) || fs.statSync(p).isDirectory()) continue;
  let a;
  try {
    a = parseArchive(fs.readFileSync(p));
  } catch (e) {
    console.log(f.padEnd(40) + '  ERROR: ' + e.message.slice(0, 44));
    continue;
  }
  const t = decodePayloadToText(a.header);
  const ids = new Set();
  for (const m of t.matchAll(/"\$id":\s*(-?\d+)/g)) ids.add(parseInt(m[1], 10));
  const pks = [...t.matchAll(/"PK":\s*"([^"]+)"/g)].map((m) => m[1]);
  const nodes = pks.filter((x) => x.startsWith('taxiway-node:')).length;
  const segs = pks.filter((x) => x.startsWith('taxiway-segment:')).length;
  let dang = 0;
  for (const m of t.matchAll(/\$iref:\s*(\d+|[^\s,\}\]]*)/g)) {
    const r = m[1];
    if (!/^\d+$/.test(r) || !ids.has(parseInt(r, 10))) dang++;
  }
  const flag = dang ? '   <== BROKEN' : '';
  console.log(
    f.padEnd(40)
    + String(fs.statSync(p).size).padStart(9)
    + String(pks.length).padStart(5)
    + String(nodes).padStart(7)
    + String(segs).padStart(6)
    + String(ids.size).padStart(7)
    + String(dang).padStart(9)
    + String(a.frames.length).padStart(8)
    + flag,
  );
}
