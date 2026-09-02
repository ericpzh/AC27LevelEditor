/**
 * Ground Painter — runway entrance/exit access listing.
 *
 * Guards the rule: a taxiway's runway entrance/exit checkbox panel lists ONLY the
 * runway(s) the taxiway is PHYSICALLY connected to (it shares a graph node with a
 * runway's coupled pavement-strip chain). A name match against an existing
 * entry/exit is NOT a physical connection and must NOT surface an unrelated runway.
 */
import { describe, it, expect } from 'vitest';
import {
  isSegmentEligibleForRunwayAccess,
  getSegmentRunwayAccess,
} from '../../../../src/components/EditorScreen/GroundPainter/runwayAccess';

// ── Graph: two physical runways + a couple of taxiways ─────────────────
// nodes: 0(0,0) 1(10,0) 2(10,10)   taxiway vertices
//        3(20,0) 4(40,0) 5(30,0)   runway A 01/19 thA/thB/pav-intermediate
//        6(20,20) 7(40,20) 8(30,20) runway B 09/27 thA/thB/pav-intermediate
function mkGraph() {
  return {
    nodes: [
      { x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 },
      { x: 20, z: 0 }, { x: 40, z: 0 }, { x: 30, z: 0 },
      { x: 20, z: 20 }, { x: 40, z: 20 }, { x: 30, z: 20 },
    ],
    segments: [
      // Taxiway "A1": connects to runway A at shared pavement node 3.
      { aIdx: 3, bIdx: 1, nodeIdxs: [3, 1], name: 'A1', flags: 2, directed: false },
      // Taxiway "E": does NOT touch any runway pavement (name coincidentally
      // matches an existing exit of runway A — must not be listed).
      { aIdx: 1, bIdx: 2, nodeIdxs: [1, 2], name: 'E', flags: 2, directed: false },
      // A runway-coupled pavement strip (flags 4) — never eligible.
      { aIdx: 3, bIdx: 4, nodeIdxs: [3, 5, 4], name: '01/19', flags: 4, directed: false },
    ],
    runways: [
      {
        thAIdx: 3, thBIdx: 4, names: ['01', '19'], physicalName: '01/19', width: 0.5,
        entries: [{ name: 'A1', runwayName: '01', holdingIdx: 1, lineUpIdx: 3, defineIdx: 1 }],
        exits: [
          { name: 'A1', runwayName: '19', exitIdx: 3, holdingIdx: 1, defineIdx: 1 },
          { name: 'E', runwayName: '01', exitIdx: 3, holdingIdx: 1, defineIdx: 1 },
        ],
      },
      {
        thAIdx: 6, thBIdx: 7, names: ['09', '27'], physicalName: '09/27', width: 0.5,
        entries: [], exits: [],
      },
    ],
    areas: [], stands: [],
  };
}
function mkMeta() {
  return { runwayPavement: [[3, 5, 4], [6, 8, 7]] };
}

describe('GroundPainter — runway entrance/exit access listing', () => {
  it('lists a runway only when the taxiway shares a node with that runway pavement', () => {
    const g = mkGraph();
    const m = mkMeta();
    // Taxiway "A1" connects to runway A (node 3) but NOT runway B.
    const access = getSegmentRunwayAccess(g, m, 0);
    // Only the physically-connected physical runway is listed, both its directions.
    expect(access.map((d) => d.physName)).toEqual(['01/19', '01/19']);
    expect(access.map((d) => d.dirName)).toEqual(['01', '19']);
    expect(access.every((d) => d.physIdx === 0)).toBe(true);
    // Directional checked-state: entry on 01, exit on 19.
    const d01 = access.find((d) => d.dirName === '01');
    const d19 = access.find((d) => d.dirName === '19');
    expect(d01.entrance).toBe(true);
    expect(d01.exit).toBe(false);
    expect(d19.entrance).toBe(false);
    expect(d19.exit).toBe(true);
  });

  it('does NOT list a runway on name match alone (no physical connection)', () => {
    const g = mkGraph();
    const m = mkMeta();
    // Taxiway "E" name-matches an existing exit of runway A but shares no node
    // with any runway pavement → nothing is listed.
    expect(getSegmentRunwayAccess(g, m, 1)).toEqual([]);
  });

  it('eligibility is a non-pavement taxiway physically touching some runway pavement (name not required)', () => {
    const g = mkGraph();
    const m = mkMeta();
    expect(isSegmentEligibleForRunwayAccess(g, m, 0)).toBe(true); // A1, physically connected
    expect(isSegmentEligibleForRunwayAccess(g, m, 1)).toBe(false); // E, name-only
    expect(isSegmentEligibleForRunwayAccess(g, m, 2)).toBe(false); // runway pavement strip
  });

  it('an unnamed taxiway that physically touches a runway IS eligible (naming is enforced at toggle, not eligibility)', () => {
    const g = mkGraph();
    const m = mkMeta();
    g.segments[0] = { ...g.segments[0], name: '' };
    expect(isSegmentEligibleForRunwayAccess(g, m, 0)).toBe(true);
    // It still lists the physically-connected runway (both directions).
    const access = getSegmentRunwayAccess(g, m, 0);
    expect(access.map((d) => d.physName)).toEqual(['01/19', '01/19']);
    expect(access.map((d) => d.dirName)).toEqual(['01', '19']);
  });

  it('returns [] when the runway has NO coupled pavement (no matching strip, no meta)', () => {
    const g = mkGraph();
    // Give runway A a physical name that matches NO segment and leave its meta
    // entry absent — it has no pavement coupling at all.
    g.runways[0] = { ...g.runways[0], physicalName: '07L/25R', names: ['07L', '25R'] };
    const m = { runwayPavement: [null, [6, 8, 7]] };
    expect(isSegmentEligibleForRunwayAccess(g, m, 0)).toBe(false);
    expect(getSegmentRunwayAccess(g, m, 0)).toEqual([]);
  });

  it('detects a connection at a junction node created by splitting a pavement strip (live graph despite stale meta snapshot)', () => {
    const g = mkGraph();
    // Junction node at the interior of the original '01/19' strip.
    g.nodes[9] = { x: 25, z: 0 };
    // The strip was split: now two pieces named '01/19' sharing junction node 9.
    g.segments[2] = { aIdx: 3, bIdx: 9, nodeIdxs: [3, 9], name: '01/19', flags: 4, directed: false };
    g.segments.push({ aIdx: 9, bIdx: 4, nodeIdxs: [9, 5, 4], name: '01/19', flags: 4, directed: false });
    // A new taxiway connects to the NEW junction node 9.
    g.segments.push({ aIdx: 9, bIdx: 1, nodeIdxs: [9, 1], name: 'A2', flags: 2, directed: false });
    // meta.runwayPavement was snapshotted at LOAD and does NOT know node 9 (stale).
    const m = { runwayPavement: [[3, 5, 4], [6, 8, 7]] };
    const taxiIdx = g.segments.length - 1; // 'A2'
    expect(isSegmentEligibleForRunwayAccess(g, m, taxiIdx)).toBe(true);
    const access = getSegmentRunwayAccess(g, m, taxiIdx);
    expect(access.map((d) => d.physName)).toEqual(['01/19', '01/19']);
    expect(access.map((d) => d.dirName)).toEqual(['01', '19']);
  });
});
