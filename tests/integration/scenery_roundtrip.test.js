/**
 * §7.1 Ground Painter — scenery roundtrip / no-touch invariant + edit paths.
 *
 * Covers the read/write core:
 *  - no-touch: buildSceneryGraph → patchSceneryBlob(none) is byte-identical and
 *    re-parses to an equivalent graph (ids ignored);
 *  - move: a shared node's coordinate change propagates to incident segments;
 *  - add: new nodes + segment are synthesized and re-parse;
 *  - delete: a flagged stand is dropped (count -1).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { buildSceneryGraph } = require('../../src/acl/scenery_graph');
const { patchSceneryBlob, _staticEntitiesRanges, _splitArrayEntries } = require('../../src/acl/scenery_write');

const FIXTURE = path.join(__dirname, '..', '_debug', 'ZSJN_leisure_1.decoded.txt');
const text = fs.readFileSync(FIXTURE, 'utf8');

function nodeKey(n) { return n.x.toFixed(6) + ',' + n.z.toFixed(6); }

// Extract the inner List<Vector3> `$type` from the LAST NonPK area in `text`.
// The List object is "NodePositions": { $type: RP, { $id, $type: LIST, $rlength } }.
function lastNonPkAreaListType(text) {
  const ranges = _staticEntitiesRanges(text);
  const npkArray = text.substring(ranges.npkRc.start, ranges.npkRc.end);
  const entries = _splitArrayEntries(npkArray);
  const last = entries[entries.length - 1];
  const m = last.match(/"NodePositions"\s*:\s*\{[^{]*?"\$type"\s*:\s*("[^"]+"|\d+)\s*,\s*\{[^{}]*?"\$type"\s*:\s*("[^"]+"|\d+)\s*,\s*"\$rlength"/);
  return m ? m[2] : null;
}

function graphsEqual(a, b, eps = 1e-6) {
  expect(b.nodes.length).toBe(a.nodes.length);
  expect(b.segments.length).toBe(a.segments.length);
  expect(b.runways.length).toBe(a.runways.length);
  expect(b.areas.length).toBe(a.areas.length);
  expect(b.stands.length).toBe(a.stands.length);
  const setA = new Set(a.nodes.map(nodeKey));
  for (const n of b.nodes) expect(setA.has(nodeKey(n))).toBe(true);
  for (const rw of a.runways) {
    const mate = b.runways.find((r) => r.physicalName === rw.physicalName);
    expect(mate).toBeTruthy();
    // threshold coords (order-insensitive)
    const coords = (rr) => [nodeKey(b.nodes[rr.thAIdx]), nodeKey(b.nodes[rr.thBIdx])].sort();
    expect(coords(mate)).toEqual(coords(rw));
  }
  for (const st of a.stands) {
    // stand identity by nosed coord set
    const noseA = nodeKey(a.nodes[st.noseIdx]);
    expect(b.stands.some((s) => nodeKey(b.nodes[s.noseIdx]) === noseA)).toBe(true);
  }
}

describe('Ground Painter — scenery roundtrip', () => {
  it('no-touch patch is lossless (byte-identical) and re-parses to equal graph', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    const noTouch = patchSceneryBlob(text, g0, null, meta);
    expect(noTouch).toBe(text); // byte-identical → lossless
    const { graph: g1 } = buildSceneryGraph(noTouch);
    graphsEqual(g0, g1);
  });

  it('move shared node propagates to incident segments', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    const nodeIdx = g0.segments[0].aIdx;
    const cur = g0.nodes[nodeIdx];
    const nx = cur.x + 7, nz = cur.z + 4;
    cur.x = nx; cur.z = nz;
    const patched = patchSceneryBlob(text, g0, null, meta);
    const { graph: g1 } = buildSceneryGraph(patched);
    const idx1 = g1.nodes.findIndex((n) => Math.abs(n.x - nx) < 1e-6 && Math.abs(n.z - nz) < 1e-6);
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(g1.segments.some((s) => s.aIdx === idx1 || s.bIdx === idx1)).toBe(true);
    expect(g1.nodes.some((n) => Math.abs(n.x - cur.x) > 1e-6 || Math.abs(n.z - cur.z) > 1e-6)).toBe(true);
  });

  it('add new nodes + segment synthesizes and re-parses', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    const nBase = g0.nodes.length, sBase = g0.segments.length;
    const nA = g0.nodes.length;
    g0.nodes.push({ x: 1000.5, z: 2000.25, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);
    const nB = g0.nodes.length;
    g0.nodes.push({ x: 1010.75, z: 2010.5, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);
    g0.segments.push({ aIdx: nA, bIdx: nB, name: 'new-seg', flags: 2, directed: false });
    meta.segOrigPk.push(null);
    const patched = patchSceneryBlob(text, g0, null, meta);
    const { graph: g1 } = buildSceneryGraph(patched);
    expect(g1.nodes.length).toBe(nBase + 2);
    expect(g1.segments.length).toBe(sBase + 1);
    const found = g1.segments.some((sg) => {
      const a = g1.nodes[sg.aIdx], b = g1.nodes[sg.bIdx];
      return a && b && Math.abs(a.x - 1000.5) < 1e-6 && Math.abs(a.z - 2000.25) < 1e-6 &&
        Math.abs(b.x - 1010.75) < 1e-6 && Math.abs(b.z - 2010.5) < 1e-6;
    });
    expect(found).toBe(true);
  });

  it('delete flagged stand drops its entry (count -1)', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    const standPk = meta.standOrigPk[0];
    const meta2 = { ...meta, deletedPks: [standPk] };
    const patched = patchSceneryBlob(text, g0, null, meta2);
    const { graph: g1 } = buildSceneryGraph(patched);
    expect(g1.stands.length).toBe(g0.stands.length - 1);
    expect(patched.includes(standPk)).toBe(false);
  });

  it('move surviving area vertex persists coordinates', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    // Prefer a building (type 2) area — the reported loss — else any survivor.
    let idx = g0.areas.findIndex((a) => a.areaType === 2);
    if (idx < 0) idx = g0.areas.findIndex((a) => a._origId != null);
    const moved = g0.areas[idx].points[0];
    const nx = moved.x + 5, nz = moved.z - 3;
    g0.areas[idx].points[0] = { x: nx, z: nz };
    const patched = patchSceneryBlob(text, g0, null, meta);
    expect(patched).not.toBe(text); // the edit must not be silently dropped
    const { graph: g1 } = buildSceneryGraph(patched);
    const g1Area = g1.areas.find((a) => a._origId === meta.areaOrigId[idx]);
    expect(g1Area).toBeTruthy();
    expect(g1Area.points.length).toBe(g0.areas[idx].points.length);
    expect(g1Area.points[0].x).toBeCloseTo(nx, 6);
    expect(g1Area.points[0].z).toBeCloseTo(nz, 6);
  });

  it('translate whole surviving area body persists (non-noop)', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    const idx = g0.areas.findIndex((a) => a.areaType === 1 && a._origId != null);
    const dx = 2.5, dz = 1.75;
    g0.areas[idx].points = g0.areas[idx].points.map((p) => ({ x: p.x + dx, z: p.z + dz }));
    const patched = patchSceneryBlob(text, g0, null, meta);
    expect(patched).not.toBe(text);
    const { graph: g1 } = buildSceneryGraph(patched);
    const first = g0.areas[idx].points[0];
    expect(g1.areas.some((a) => a.points.some((p) => Math.abs(p.x - first.x) < 1e-6 && Math.abs(p.z - first.z) < 1e-6))).toBe(true);
  });

  it('add new area synthesizes a valid List<Vector3> $type (no $type: 0) and re-parses', () => {
    const { graph: g0, meta } = buildSceneryGraph(text);
    const baseAreas = g0.areas.length;
    // Mirror what the painter does for a brand-new area: append a 3-vertex
    // polygon and extend meta.areaOrigId with a null (no original $id).
    g0.areas.push({ areaType: 2, points: [{ x: 100, z: 200 }, { x: 110, z: 200 }, { x: 110, z: 210 }], owner: null });
    meta.areaOrigId.push(null);
    const patched = patchSceneryBlob(text, g0, null, meta);
    expect(patched).not.toBe(text);
    // The synthesized area must carry a real List<Vector3> type — not the `0`
    // null-degraded type that Unity resolves to ArchiveHeader and rejects as
    // "Invalid Area static entity".
    const lastListType = lastNonPkAreaListType(patched);
    expect(lastListType).toBeTruthy();
    expect(lastListType).not.toBe('0');
    expect(lastListType).toMatch(/System\.Collections\.Generic\.List/);
    // The new area must survive a full re-parse.
    const { graph: g1 } = buildSceneryGraph(patched);
    expect(g1.areas.length).toBe(baseAreas + 1);
    const synth = g1.areas[g1.areas.length - 1];
    expect(synth.points.length).toBe(3);
    expect(synth.points.some((p) => Math.abs(p.x - 100) < 1e-6 && Math.abs(p.z - 200) < 1e-6)).toBe(true);
  });
});
