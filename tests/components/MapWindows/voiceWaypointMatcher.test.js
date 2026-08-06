import { describe, it, expect } from 'vitest';
import { matchWaypointValue } from '../../../src/components/MapWindows/voiceTranscriptParser';
import { bearingDegrees } from '../../../src/utils/patchCommands';

/**
 * Unit tests for the direct-to-waypoint slot: matchWaypointValue (single
 * token exact → D-L ≤ 2 → spelled-letter sequence) and bearingDegrees
 * (the payload heading). End-to-end rows live in the deviation matrix
 * (section 12) — these pin the slot-level rules.
 */

const FIX = [
  { name: 'BELTT', x: 100, z: 100 },
  { name: 'PANKI', x: 0, z: 100 },
  { name: 'BAL', x: 0, z: -100 },
  { name: 'AML', x: -100, z: -100 },
  { name: 'ESL', x: 100, z: -100 },
  { name: 'BELT', x: -100, z: 100 },
  { name: 'WAL', x: -100, z: 100 },
];

describe('matchWaypointValue — single token', () => {
  it('exact match, case-insensitive, consumed 1', () => {
    const m = matchWaypointValue('beltt', FIX);
    expect(m).toEqual({ name: 'BELTT', x: 100, z: 100, consumed: 1 });
  });

  it('D-L 1 ("panky")', () => {
    expect(matchWaypointValue('panky', FIX).name).toBe('PANKI');
  });

  it('D-L 2 ("pankee")', () => {
    expect(matchWaypointValue('pankee', FIX).name).toBe('PANKI');
  });

  it('exact-first: "belt" is BELT, never the D-L 1 BELTT', () => {
    expect(matchWaypointValue('belt', FIX).name).toBe('BELT');
  });

  it('letter-form token never D-L degrades ("bee" must not become BAL at distance 2)', () => {
    expect(matchWaypointValue('bee', FIX)).toBeNull();
  });

  it('no match → null', () => {
    expect(matchWaypointValue('banana', FIX)).toBeNull();
  });

  it('empty rest → null', () => {
    expect(matchWaypointValue('', FIX)).toBeNull();
    expect(matchWaypointValue('   ', FIX)).toBeNull();
  });
});

describe('matchWaypointValue — spelled letter sequence', () => {
  it('letter names → BELTT, consumed 5 tokens', () => {
    expect(matchWaypointValue('bee ee el tee tee', FIX))
      .toEqual({ name: 'BELTT', x: 100, z: 100, consumed: 5 });
  });

  it('spelled exact short name ("bee ee el tee" → BELT, consumed 4)', () => {
    expect(matchWaypointValue('bee ee el tee', FIX))
      .toEqual({ name: 'BELT', x: -100, z: 100, consumed: 4 });
  });

  it('NATO words → PANKI', () => {
    expect(matchWaypointValue('papa alpha november kilo india', FIX).name).toBe('PANKI');
  });

  it('spelled fuzzy ("papa alpha november kilo why" = PANKY → PANKI)', () => {
    expect(matchWaypointValue('papa alpha november kilo why', FIX).name).toBe('PANKI');
  });

  it('bare letters ("b e l t t")', () => {
    expect(matchWaypointValue('b e l t t', FIX).name).toBe('BELTT');
  });

  it('multi-token letter ("double you alpha lima" → WAL), consumed counts TOKENS (4)', () => {
    const m = matchWaypointValue('double you alpha lima', FIX);
    expect(m.name).toBe('WAL');
    expect(m.consumed).toBe(4);
  });

  it('stops at first non-letter ("pankee" is not a letter form)', () => {
    expect(matchWaypointValue('pankee', FIX).name).toBe('PANKI');   // path 1, D-L 2
    expect(matchWaypointValue('pankee alpha', FIX).name).toBe('PANKI');   // spelled stops immediately → path 1
  });

  it('single letter alone cannot form a name ("tee")', () => {
    expect(matchWaypointValue('tee', FIX)).toBeNull();
  });
});

describe('matchWaypointValue — ties & determinism', () => {
  it('ties first-wins in waypoint array order', () => {
    // "asl" is D-L 1 from both AML and ESL — AML comes first in FIX
    expect(matchWaypointValue('asl', FIX).name).toBe('AML');
  });
});

describe('bearingDegrees', () => {
  it('cardinal + intercardinal bearings', () => {
    expect(bearingDegrees(0, 0, 100, 100)).toBe(45);       // NE
    expect(bearingDegrees(0, 0, 0, 100)).toBe(360);        // north → 360 (not 0)
    expect(bearingDegrees(0, 0, 0, -100)).toBe(180);
    expect(bearingDegrees(0, 0, -100, -100)).toBe(225);
    expect(bearingDegrees(0, 0, -100, 100)).toBe(315);
  });

  it('rounds after normalize (150°, 359.6° → 360)', () => {
    expect(bearingDegrees(0, 0, 100, -173.205)).toBe(150);
    expect(bearingDegrees(0, 0, -0.07, 100)).toBe(360);
  });

  it('degenerate (aircraft on the waypoint) → 360, deterministic', () => {
    expect(bearingDegrees(5, 5, 5, 5)).toBe(360);
  });
});
