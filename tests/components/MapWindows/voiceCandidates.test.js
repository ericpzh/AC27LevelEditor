import { describe, it, expect } from 'vitest';
import { parseVoiceCandidates, parseVoiceTranscript } from '../../../src/components/MapWindows/voiceTranscriptParser';

/**
 * Stage A: candidate ordering for parseVoiceCandidates — the primary
 * System.Speech result first, then the engine's alternate hypotheses.
 * Win rule: first candidate whose parse has ok && commands.length > 0;
 * selection-only candidates never win; no winner → primary's result.
 */

const ac = (callSign) => ({
  callSign,
  controlSeat: 5,
  position: { x: 0, y: 0, z: 0 },
  noseDirection: { x: 0, y: 0, z: 1 },
  airSpeedKnot: 200,
});

const AIRCRAFT = [ac('DAL3401'), ac('DAL304'), ac('CSC6918'), ac('UAL1111')];

describe('parseVoiceCandidates', () => {
  it('primary wins when it parses commands', () => {
    const { result, matchedText, candidateIndex } = parseVoiceCandidates(
      ['CSC6918: turn left heading 360', 'garbage'],
      AIRCRAFT
    );
    expect(candidateIndex).toBe(0);
    expect(matchedText).toBe('CSC6918: turn left heading 360');
    expect(result.commands.map((c) => c.label)).toEqual(['Fly Heading 360']);
  });

  it('alternate rescues a failing primary (out-of-range value)', () => {
    const { result, matchedText, candidateIndex } = parseVoiceCandidates(
      ['CSC6918: climb to ninety', 'CSC6918: climb to 9000'],
      AIRCRAFT
    );
    expect(candidateIndex).toBe(1);
    expect(matchedText).toBe('CSC6918: climb to 9000');
    expect(result.commands.map((c) => c.label)).toEqual(['Fly Altitude 9000']);
  });

  it('alternate rescues an out-of-range primary with the correct NOTICES gone', () => {
    const { result } = parseVoiceCandidates(
      ['CSC6918: climb to ninety', 'CSC6918: climb to 9000'],
      AIRCRAFT
    );
    // The winner's parse is clean — no out-of-range notice leaks in.
    expect(result.notices).toEqual([]);
  });

  it('selection-only alternate never wins over a failing primary', () => {
    const { result, candidateIndex } = parseVoiceCandidates(
      ['CSC6918: climb to ninety', 'delta 3401'],
      AIRCRAFT
    );
    // Primary (ok, 0 commands) is preserved; the bare-callsign alternate
    // must not trigger a selection.
    expect(candidateIndex).toBe(0);
    expect(result.callsign).toBe('CSC6918');
    expect(result.commands).toEqual([]);
  });

  it('selection-only alternate with commands wins (command-bearing beats selection)', () => {
    const { result, candidateIndex } = parseVoiceCandidates(
      ['delta 3401', 'delta 3401, turn left heading 360'],
      AIRCRAFT
    );
    expect(candidateIndex).toBe(1);
    expect(result.callsign).toBe('DAL3401');
    expect(result.commands.map((c) => c.label)).toEqual(['Fly Heading 360']);
  });

  it('primary with commands beats a different alternate', () => {
    const { result, candidateIndex } = parseVoiceCandidates(
      ['CSC6918: turn left heading 360', 'CSC6918: climb to 9000'],
      AIRCRAFT
    );
    expect(candidateIndex).toBe(0);
    expect(result.commands.map((c) => c.label)).toEqual(['Fly Heading 360']);
  });

  it('no winner → primary parse result returned unchanged', () => {
    const { result, matchedText, candidateIndex } = parseVoiceCandidates(
      ['CSC6918: climb to ninety', 'CSC6918: fly heading banana'],
      AIRCRAFT
    );
    expect(candidateIndex).toBe(0);
    expect(matchedText).toBe('CSC6918: climb to ninety');
    expect(result.commands).toEqual([]);
    expect(result.notices.some((n) => n.includes('out of range'))).toBe(true);
  });

  it('case-insensitive dedupe keeps the primary first', () => {
    const { result, candidateIndex } = parseVoiceCandidates(
      ['CSC6918: turn left heading 360', 'CSC6918: TURN LEFT HEADING 360', 'CSC6918: turn left heading 360'],
      AIRCRAFT
    );
    expect(candidateIndex).toBe(0);
    expect(result.commands.map((c) => c.label)).toEqual(['Fly Heading 360']);
  });

  it('all-empty texts → empty-transcript failure', () => {
    for (const texts of [[], ['', '   '], [null, undefined]]) {
      const { result, candidateIndex } = parseVoiceCandidates(texts, AIRCRAFT);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('empty transcript');
      expect(candidateIndex).toBe(0);
    }
  });

  it('single text is identical to parseVoiceTranscript plus metadata', () => {
    const direct = parseVoiceTranscript('CSC6918: turn left heading 360', AIRCRAFT);
    const { result, matchedText, candidateIndex } = parseVoiceCandidates(
      ['CSC6918: turn left heading 360'],
      AIRCRAFT
    );
    expect(result).toEqual(direct);
    expect(matchedText).toBe('CSC6918: turn left heading 360');
    expect(candidateIndex).toBe(0);
  });
});
