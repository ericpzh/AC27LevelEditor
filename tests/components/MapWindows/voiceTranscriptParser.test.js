import { describe, it, expect } from 'vitest';
import { parseVoiceTranscript, buildSyntheticAircraftList } from '../../../src/components/MapWindows/voiceTranscriptParser';

// ─── Fixtures ──────────────────────────────────────────────────────────

const AIRCRAFT = [
  { callSign: 'CSC6918', controlSeat: 5, position: { x: 0, y: 0, z: 0 }, noseDirection: { x: 0, y: 0, z: 1 }, airSpeedKnot: 200 },
  { callSign: 'CES1234', controlSeat: 3, position: { x: 0, y: 0, z: 0 }, noseDirection: { x: 0, y: 0, z: 1 }, airSpeedKnot: 200 },
  { callSign: 'DAL3401', controlSeat: 5, position: { x: 0, y: 0, z: 0 }, noseDirection: { x: 0, y: 0, z: 1 }, airSpeedKnot: 200 },
];

const types = (r) => r.commands.map(c => c.type);
const firstPayload = (r) => r.commands[0].payload;

// ─── The user's 4 examples ─────────────────────────────────────────────

describe('parseVoiceTranscript — user examples', () => {
  it('Ex1: "CSC6918: Fly heading 120" → direct mapping to command window output', () => {
    const r = parseVoiceTranscript('CSC6918: Fly heading 120', AIRCRAFT);
    expect(r.ok).toBe(true);
    expect(r.callsign).toBe('CSC6918');
    expect(r.commands).toHaveLength(1);
    expect(firstPayload(r)).toEqual({
      type: 'update_heading', callSign: 'CSC6918',
      dx: 0.866, dy: -0.5,        // sin(120°), cos(120°)
      rate: 3,
    });
    expect(r.renderedLine).toBe('CSC6918: Fly Heading 120');
  });

  it('Ex2: "CSC6918:" → selection only (active/yellow), zero commands', () => {
    const r = parseVoiceTranscript('CSC6918:', AIRCRAFT);
    expect(r.ok).toBe(true);
    expect(r.callsign).toBe('CSC6918');
    expect(r.commands).toEqual([]);
    expect(r.renderedLine).toBe('CSC6918:');
  });

  it('Ex3: "CSC6918: Climb and maintain 9000" → Fly altitude 9000', () => {
    const r = parseVoiceTranscript('CSC6918: Climb and maintain 9000', AIRCRAFT);
    expect(types(r)).toEqual(['altitude']);
    expect(firstPayload(r)).toEqual({ type: 'altitude', callSign: 'CSC6918', targetFt: 9000, rate: 1000 });
    expect(r.renderedLine).toBe('CSC6918: Fly Altitude 9000');
  });

  it('Ex4: "CSC6918: Descend and maintain 2000, reduce speed to 180 knots" → chained', () => {
    const r = parseVoiceTranscript('CSC6918: Descend and maintain 2000, reduce speed to 180 knots', AIRCRAFT);
    expect(types(r)).toEqual(['altitude', 'update_speed']);
    expect(r.commands[0].payload).toEqual({ type: 'altitude', callSign: 'CSC6918', targetFt: 2000, rate: 1000 });
    expect(r.commands[1].payload).toEqual({ type: 'update_speed', callSign: 'CSC6918', kts: 180 });
    expect(r.renderedLine).toBe('CSC6918: Fly Altitude 2000, Fly Speed 180');
  });
});

// ─── The 2026-08-06 DAL3401 regression ─────────────────────────────────

describe('parseVoiceTranscript — DAL3401 regression (turn left + reduce speed)', () => {
  it('"delta thirty four o one, turn left heading three six zero, reduce speed to two hundred knots" → heading 360 + speed 200', () => {
    const r = parseVoiceTranscript('delta thirty four o one, turn left heading three six zero, reduce speed to two hundred knots', AIRCRAFT);
    expect(r.ok).toBe(true);
    expect(r.callsign).toBe('DAL3401');
    expect(types(r)).toEqual(['update_heading', 'update_speed']);
    expect(r.commands[0].payload).toEqual({ type: 'update_heading', callSign: 'DAL3401', dx: 0, dy: 1, rate: 3 });
    expect(r.commands[1].payload).toEqual({ type: 'update_speed', callSign: 'DAL3401', kts: 200 });
    expect(r.renderedLine).toBe('DAL3401: Fly Heading 360, Fly Speed 200');
  });

  it('dedupes by command type, last wins ("heading 120, heading 240" → 240)', () => {
    const r = parseVoiceTranscript('CSC6918: heading 120, heading 240', AIRCRAFT);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].label).toBe('Fly Heading 240');
  });
});

// ─── Heading variants ──────────────────────────────────────────────────

describe('parseVoiceTranscript — heading', () => {
  it('heading one two zero (digit-by-digit) → 120', () => {
    const r = parseVoiceTranscript('CSC6918: heading one two zero', AIRCRAFT);
    expect(r.commands[0].payload.dx).toBe(0.866);
    expect(r.commands[0].label).toBe('Fly Heading 120');
  });

  it('fly heading one eighty → 180', () => {
    const r = parseVoiceTranscript('CSC6918: fly heading one eighty', AIRCRAFT);
    expect(r.commands[0].payload.dy).toBe(-1);   // cos(180°)
  });

  it('turn left heading 270 → 270 (absolute)', () => {
    const r = parseVoiceTranscript('CSC6918: turn left heading 270', AIRCRAFT);
    expect(r.commands[0].payload).toEqual({ type: 'update_heading', callSign: 'CSC6918', dx: -1, dy: 0, rate: 3 });
  });

  it('turn to heading 270 → 270', () => {
    const r = parseVoiceTranscript('CSC6918: turn to heading 270', AIRCRAFT);
    expect(r.commands[0].payload.dx).toBe(-1);
  });
});

// ─── Altitude / speed / numbers ────────────────────────────────────────

describe('parseVoiceTranscript — altitude & speed', () => {
  it('fly altitude two thousand → 2000', () => {
    const r = parseVoiceTranscript('CSC6918: fly altitude two thousand', AIRCRAFT);
    expect(r.commands[0].payload.targetFt).toBe(2000);
  });

  it('climb to nine zero zero zero → 9000', () => {
    const r = parseVoiceTranscript('CSC6918: climb to nine zero zero zero', AIRCRAFT);
    expect(r.commands[0].payload.targetFt).toBe(9000);
  });

  it('descend to 2000 (Arabic digits) → 2000', () => {
    const r = parseVoiceTranscript('CSC6918: descend to 2000', AIRCRAFT);
    expect(r.commands[0].payload.targetFt).toBe(2000);
  });

  it('level at 5000 → altitude', () => {
    const r = parseVoiceTranscript('CSC6918: level at 5000', AIRCRAFT);
    expect(types(r)).toEqual(['altitude']);
  });

  it('reduce speed to 180 knots → update_speed', () => {
    const r = parseVoiceTranscript('CSC6918: reduce speed to 180 knots', AIRCRAFT);
    expect(r.commands[0].payload).toEqual({ type: 'update_speed', callSign: 'CSC6918', kts: 180 });
  });

  it('slow down to 210 → update_speed', () => {
    const r = parseVoiceTranscript('CSC6918: slow down to 210', AIRCRAFT);
    expect(r.commands[0].payload.kts).toBe(210);
  });

  it('fly speed 180 → update_speed', () => {
    const r = parseVoiceTranscript('CSC6918: fly speed 180', AIRCRAFT);
    expect(r.commands[0].payload.kts).toBe(180);
  });

  it('chains via "and" without a comma', () => {
    const r = parseVoiceTranscript('CSC6918: climb and maintain 9000 and reduce speed to 180', AIRCRAFT);
    expect(types(r)).toEqual(['altitude', 'update_speed']);
  });
});

// ─── Maintain disambiguation matrix ────────────────────────────────────

describe('parseVoiceTranscript — "maintain" disambiguation', () => {
  it('maintain 9000 (bare, ≥1000) → altitude', () => {
    expect(types(parseVoiceTranscript('CSC6918: maintain 9000', AIRCRAFT))).toEqual(['altitude']);
  });

  it('maintain 180 (bare, <1000) → speed', () => {
    expect(types(parseVoiceTranscript('CSC6918: maintain 180', AIRCRAFT))).toEqual(['update_speed']);
  });

  it('maintain 180 knots (unit wins) → speed', () => {
    expect(types(parseVoiceTranscript('CSC6918: maintain 180 knots', AIRCRAFT))).toEqual(['update_speed']);
  });

  it('maintain 9000 feet (unit wins) → altitude', () => {
    expect(types(parseVoiceTranscript('CSC6918: maintain 9000 feet', AIRCRAFT))).toEqual(['altitude']);
  });

  it('maintain flight level 90 → altitude 9000', () => {
    const r = parseVoiceTranscript('CSC6918: maintain flight level 90', AIRCRAFT);
    expect(types(r)).toEqual(['altitude']);
    expect(r.commands[0].payload.targetFt).toBe(9000);
  });

  it('flight level 90 (bare FL) → altitude 9000', () => {
    const r = parseVoiceTranscript('CSC6918: flight level 90', AIRCRAFT);
    expect(r.commands[0].payload.targetFt).toBe(9000);
  });
});

// ─── Clear for approach ────────────────────────────────────────────────

describe('parseVoiceTranscript — clear for approach', () => {
  it('clear for approach alone → cfa', () => {
    const r = parseVoiceTranscript('CSC6918: clear for approach', AIRCRAFT);
    expect(types(r)).toEqual(['clear_for_appr']);
    expect(r.commands[0].payload).toEqual({ type: 'clear_for_appr', callSign: 'CSC6918', rate: 3 });
  });

  it('cleared for approach → cfa', () => {
    expect(types(parseVoiceTranscript('CSC6918: cleared for approach', AIRCRAFT))).toEqual(['clear_for_appr']);
  });

  it('cfa supersedes a composed chain', () => {
    const r = parseVoiceTranscript('CSC6918: climb to 3000, clear for approach', AIRCRAFT);
    expect(types(r)).toEqual(['clear_for_appr']);
  });

  it('"clear for the ILS approach" → cfa with the exact payload', () => {
    const r = parseVoiceTranscript('CSC6918: clear for the ILS approach', AIRCRAFT);
    expect(types(r)).toEqual(['clear_for_appr']);
    expect(r.commands[0].payload).toEqual({ type: 'clear_for_appr', callSign: 'CSC6918', rate: 3 });
    expect(r.renderedLine).toBe('CSC6918: Clear for Approach');
  });

  it('"clear for the rnav appr, runway one three left" → cfa, zero notices', () => {
    const r = parseVoiceTranscript('CSC6918: clear for the rnav appr, runway one three left', AIRCRAFT);
    expect(types(r)).toEqual(['clear_for_appr']);
    expect(r.notices).toEqual([]);
    expect(r.commands[0].payload).toEqual({ type: 'clear_for_appr', callSign: 'CSC6918', rate: 3 });
  });

  it('"clear for the visual appr runway 13 left" (same segment) → cfa, zero notices', () => {
    const r = parseVoiceTranscript('CSC6918: clear for the visual appr runway 13 left', AIRCRAFT);
    expect(types(r)).toEqual(['clear_for_appr']);
    expect(r.notices).toEqual([]);
  });

  it('chain after runway is superseded', () => {
    const r = parseVoiceTranscript('CSC6918: clear for the rnav appr, runway one three left, turn left heading 360', AIRCRAFT);
    expect(types(r)).toEqual(['clear_for_appr']);
    expect(r.notices).toEqual([]);
  });

  it('"cleared for the ILS" (no tail) → no commands, unsupported notice', () => {
    const r = parseVoiceTranscript('CSC6918: cleared for the ILS', AIRCRAFT);
    expect(r.commands).toEqual([]);
    expect(r.notices.some(n => n.includes('unsupported'))).toBe(true);
  });

  it('ZH: 跑道 designator after cfa stays unsupported', () => {
    const r = parseVoiceTranscript('川航六九幺八可以进近，跑道幺三左', AIRCRAFT);
    expect(types(r)).toEqual(['clear_for_appr']);
    expect(r.notices.some(n => n.includes('unsupported'))).toBe(true);
  });
});

// ─── Unsupported phrases ───────────────────────────────────────────────

describe('parseVoiceTranscript — unsupported', () => {
  it('relative turn "turn left 90 degrees" → unsupported notice, no command', () => {
    const r = parseVoiceTranscript('CSC6918: turn left 90 degrees', AIRCRAFT);
    expect(r.commands).toEqual([]);
    expect(r.notices.some(n => n.includes('unsupported'))).toBe(true);
  });

  it('"cleared to land" → unsupported notice', () => {
    const r = parseVoiceTranscript('CSC6918: cleared to land', AIRCRAFT);
    expect(r.commands).toEqual([]);
    expect(r.notices.some(n => n.includes('unsupported'))).toBe(true);
  });

  it('"go around" → unsupported notice', () => {
    const r = parseVoiceTranscript('CSC6918: go around', AIRCRAFT);
    expect(r.commands).toEqual([]);
    expect(r.notices.length).toBeGreaterThan(0);
  });

  it('out-of-range heading (heading 500) → unsupported notice', () => {
    const r = parseVoiceTranscript('CSC6918: heading 500', AIRCRAFT);
    expect(r.commands).toEqual([]);
    expect(r.notices.some(n => n.includes('out of range'))).toBe(true);
  });
});

// ─── Chinese ───────────────────────────────────────────────────────────

describe('parseVoiceTranscript — Chinese', () => {
  it('川航六九幺八爬升至九千 → altitude 9000', () => {
    const r = parseVoiceTranscript('川航六九幺八爬升至九千', AIRCRAFT);
    expect(r.callsign).toBe('CSC6918');
    expect(r.commands[0].payload).toEqual({ type: 'altitude', callSign: 'CSC6918', targetFt: 9000, rate: 1000 });
  });

  it('下降保持两千 → altitude 2000', () => {
    const r = parseVoiceTranscript('川航六九幺八下降保持两千', AIRCRAFT);
    expect(r.commands[0].payload.targetFt).toBe(2000);
  });

  it('减速至一百八十节 → speed 180', () => {
    const r = parseVoiceTranscript('川航六九幺八减速至一百八十节', AIRCRAFT);
    expect(r.commands[0].payload).toEqual({ type: 'update_speed', callSign: 'CSC6918', kts: 180 });
  });

  it('飞航向幺二洞 → heading 120', () => {
    const r = parseVoiceTranscript('川航六九幺八飞航向幺二洞', AIRCRAFT);
    expect(r.commands[0].payload.dx).toBe(0.866);
  });

  it('左转航向二七洞 → heading 270', () => {
    const r = parseVoiceTranscript('川航六九幺八左转航向二七洞', AIRCRAFT);
    expect(r.commands[0].payload.dx).toBe(-1);
  });

  it('保持两千 (bare, ≥1000) → altitude', () => {
    expect(types(parseVoiceTranscript('川航六九幺八保持两千', AIRCRAFT))).toEqual(['altitude']);
  });

  it('保持一百八 (bare, <1000) → speed', () => {
    expect(types(parseVoiceTranscript('川航六九幺八保持一百八', AIRCRAFT))).toEqual(['update_speed']);
  });

  it('可以进近 → cfa', () => {
    expect(types(parseVoiceTranscript('川航六九幺八可以进近', AIRCRAFT))).toEqual(['clear_for_appr']);
  });

  it('bare callsign in Chinese → selection only', () => {
    const r = parseVoiceTranscript('川航六九幺八', AIRCRAFT);
    expect(r.callsign).toBe('CSC6918');
    expect(r.commands).toEqual([]);
  });
});

// ─── Synthetic aircraft list (CLI callsign resolution) ─────────────────

describe('buildSyntheticAircraftList', () => {
  it('resolves spoken callsign words (CSC six nine one eight → CSC6918)', () => {
    const list = buildSyntheticAircraftList('CSC six nine one eight climb and maintain 9000', 'en');
    expect(list.map(a => a.callSign)).toContain('CSC6918');
    expect(list[0].controlSeat).toBe(5);
  });

  it('resolves a literal callsign with colon (CSC6918: …)', () => {
    const list = buildSyntheticAircraftList('CSC6918: climb and maintain 9000', 'en');
    expect(list.map(a => a.callSign)).toContain('CSC6918');
  });

  it('feeding the synthetic list resolves the full pipeline (CLI round-trip)', () => {
    const list = buildSyntheticAircraftList('CSC6918: climb and maintain 9000', 'en');
    const r = parseVoiceTranscript('CSC6918: climb and maintain 9000', list);
    expect(r.ok).toBe(true);
    expect(r.callsign).toBe('CSC6918');
    expect(r.commands[0].payload.targetFt).toBe(9000);
  });
});

// ─── No callsign ───────────────────────────────────────────────────────

describe('parseVoiceTranscript — no callsign', () => {
  it('"climb to 9000" without a callsign → ok:false with a non-empty reason', () => {
    const r = parseVoiceTranscript('climb to 9000', AIRCRAFT);
    expect(r.ok).toBe(false);
    expect(r.callsign).toBeNull();
    expect(r.commands).toEqual([]);
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('"delta nine nine nine nine" (no such aircraft) → ok:false, reason names the candidates', () => {
    const r = parseVoiceTranscript('delta nine nine nine nine', AIRCRAFT);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('DAL9999');
  });

  it('empty transcript → ok:false, reason "empty transcript"', () => {
    const r = parseVoiceTranscript('   ', AIRCRAFT);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty transcript');
  });

  it('empty aircraft list → ok:false, reason mentions no aircraft data', () => {
    const r = parseVoiceTranscript('delta 3401', []);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('aircraft');
  });
});
