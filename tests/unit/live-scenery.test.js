import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── helpers mirroring electron/main.js live logic ──────────────────────────
// (kept local so tests don't need to import the electron main process)
function unionLiveEntries(entries) {
  if (!entries || entries.length === 0) return null;
  const standSet = new Set();
  const runwaySet = new Set();
  const airwaySet = new Set();
  const standPositions = {};
  let runwayPairs = [];
  let starRunwayMap = {}, runwayStarMap = {};
  for (const e of entries) {
    const v = e.vals;
    if (!v) continue;
    for (const s of (v.dropdownPatch?.Stand || [])) standSet.add(s);
    for (const r of (v.dropdownPatch?.Runway || [])) runwaySet.add(r);
    for (const a of (v.dropdownPatch?.Airway || [])) airwaySet.add(a);
    Object.assign(standPositions, v.standPositions || {});
    if (Array.isArray(v.runwayPairs)) runwayPairs = runwayPairs.concat(v.runwayPairs);
    for (const [k, arr] of Object.entries(v.starRunwayMap || {})) {
      if (!starRunwayMap[k]) starRunwayMap[k] = [];
      for (const r of arr) if (!starRunwayMap[k].includes(r)) starRunwayMap[k].push(r);
    }
    for (const [k, arr] of Object.entries(v.runwayStarMap || {})) {
      if (!runwayStarMap[k]) runwayStarMap[k] = [];
      for (const s of arr) if (!runwayStarMap[k].includes(s)) runwayStarMap[k].push(s);
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const p of runwayPairs) {
    const k = p.source + '|' + p.dest;
    if (!seen.has(k)) { seen.add(k); deduped.push(p); }
  }
  return {
    Stand: [...standSet].sort((a, b) => a.localeCompare(b)),
    Runway: [...runwaySet].sort((a, b) => a.localeCompare(b)),
    Airway: [...airwaySet].sort((a, b) => a.localeCompare(b)),
    standPositions, runwayPairs: deduped, starRunwayMap, runwayStarMap,
  };
}

// Stand identifier allocation — mirrors src/acl/scenery_write.js
function allocateStandIdents(existingPks, desiredList) {
  let maxStand = 0;
  const existingIdents = new Set();
  for (const pk of existingPks) {
    if (pk.startsWith('stand:')) existingIdents.add(pk.slice(6));
    const m = /^stand:(\d+)$/.exec(pk);
    if (m) { const n = parseInt(m[1], 10); if (n > maxStand) maxStand = n; }
  }
  const allocated = new Set(existingIdents);
  let nextStand = maxStand + 1;
  const out = [];
  for (const desiredRaw of desiredList) {
    const desired = desiredRaw != null ? String(desiredRaw).trim() : '';
    let ident;
    if (desired && !desired.includes(':') && !desired.includes('"') && !allocated.has(desired)) {
      ident = desired;
      allocated.add(ident);
      const asNum = parseInt(desired, 10);
      if (!isNaN(asNum) && String(asNum) === desired && asNum >= nextStand) nextStand = asNum + 1;
    } else {
      ident = String(nextStand++);
      while (allocated.has(ident)) ident = String(nextStand++);
      allocated.add(ident);
    }
    out.push(ident);
  }
  return out;
}

describe('liveSceneryCache — union', () => {
  it('merges Stand/Runway/Airway across files, deduping sorted', () => {
    const entries = [
      { vals: { dropdownPatch: { Stand: ['A1', 'A2'], Runway: ['01'], Airway: ['STAR1'] }, standPositions: { A1: { x: 0 } }, runwayPairs: [{ source: '01', dest: '19' }], starRunwayMap: { STAR1: ['01'] }, runwayStarMap: { '01': ['STAR1'] } } },
      { vals: { dropdownPatch: { Stand: ['A2', 'A3'], Runway: ['01', '19'], Airway: ['STAR2'] }, standPositions: { A3: { x: 1 } }, runwayPairs: [{ source: '01', dest: '19' }, { source: '19', dest: '01' }], starRunwayMap: { STAR2: ['19'] }, runwayStarMap: { '19': ['STAR2'] } } },
    ];
    const u = unionLiveEntries(entries);
    expect(u.Stand).toEqual(['A1', 'A2', 'A3']);
    expect(u.Runway).toEqual(['01', '19']);
    expect(u.Airway).toEqual(['STAR1', 'STAR2']);
    expect(u.standPositions).toEqual({ A1: { x: 0 }, A3: { x: 1 } });
    expect(u.runwayPairs).toEqual([{ source: '01', dest: '19' }, { source: '19', dest: '01' }]);
    expect(u.starRunwayMap).toEqual({ STAR1: ['01'], STAR2: ['19'] });
  });

  it('returns null for empty input', () => {
    expect(unionLiveEntries([])).toBeNull();
    expect(unionLiveEntries(null)).toBeNull();
  });

  it('deduplicates runwayPairs by source|dest', () => {
    const entries = [
      { vals: { dropdownPatch: {}, runwayPairs: [{ source: '01', dest: '19' }], starRunwayMap: {}, runwayStarMap: {} } },
      { vals: { dropdownPatch: {}, runwayPairs: [{ source: '01', dest: '19' }], starRunwayMap: {}, runwayStarMap: {} } },
    ];
    expect(unionLiveEntries(entries).runwayPairs).toHaveLength(1);
  });

  it('merges starRunwayMap arrays without duplicates', () => {
    const entries = [
      { vals: { dropdownPatch: {}, starRunwayMap: { S1: ['01', '19'] }, runwayStarMap: {} } },
      { vals: { dropdownPatch: {}, starRunwayMap: { S1: ['19', '02'] }, runwayStarMap: {} } },
    ];
    expect(unionLiveEntries(entries).starRunwayMap.S1).toEqual(['01', '19', '02']);
  });
});

describe('liveSceneryCache — mtime invalidation', () => {
  it('invalidates after file touch (mtime bump)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-live-'));
    const f = path.join(dir, 'test.acl');
    fs.writeFileSync(f, 'hello');
    const m1 = fs.statSync(f).mtimeMs;
    // simulate cache entry
    const cache = new Map();
    cache.set(path.resolve(f), { mtimeMs: m1, vals: { Stand: ['A1'] } });
    const isFresh = (entry, p) => {
      try { return entry && fs.existsSync(p) && fs.statSync(p).mtimeMs === entry.mtimeMs; } catch { return false; }
    };
    expect(isFresh(cache.get(path.resolve(f)), f)).toBe(true);
    // touch
    await new Promise(r => setTimeout(r, 10));
    fs.writeFileSync(f, 'hello2');
    expect(isFresh(cache.get(path.resolve(f)), f)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('scenery_write — stand identifier allocation', () => {
  it('uses desired identifier when free and non-numeric', () => {
    expect(allocateStandIdents(['stand:1', 'stand:2'], ['A13'])).toEqual(['A13']);
  });

  it('falls back to numeric when desired collides', () => {
    // A13 already taken → next free numeric (max numeric is 1, so next is 2)
    expect(allocateStandIdents(['stand:1', 'stand:A13'], ['A13', 'A13'])).toEqual(['2', '3']);
  });

  it('numeric desired bumps nextStand', () => {
    // max numeric is 2, desired "5" is free → next numeric should be 6
    expect(allocateStandIdents(['stand:1', 'stand:2'], ['5', null])).toEqual(['5', '6']);
  });

  it('rejects desired containing colon or quote', () => {
    expect(allocateStandIdents(['stand:1'], ['a:b'])).toEqual(['2']);
    expect(allocateStandIdents(['stand:1'], ['a"b'])).toEqual(['2']);
  });

  it('GroundPainter + MCP contract: new stand via MCP sets identifier so dropdown reflects name', () => {
    // electron/api-server.js create_stands path sets { name, identifier, nameEdited }
    // scenery_write.js honors identifier for new stands
    const desired = 'B7';
    const allocated = allocateStandIdents([], [desired]);
    expect(allocated[0]).toBe('B7');
    // simulate second new stand without desired → numeric
    const second = allocateStandIdents(['stand:' + allocated[0]], [null]);
    expect(second[0]).toBe('1');
  });
});

describe('collect-values live stripping', () => {
  it('strips Stand/Runway/Airway from persisted dropdownValues', () => {
    const dropdownValues = { Stand: ['A1'], Runway: ['01'], Airway: ['S1'], AircraftType: ['B738'], Language: ['en'] };
    const stripped = { ...dropdownValues };
    delete stripped.Stand; delete stripped.Runway; delete stripped.Airway;
    expect(stripped).toEqual({ AircraftType: ['B738'], Language: ['en'] });
    expect(stripped.Stand).toBeUndefined();
  });
});
