import { describe, it, expect } from 'vitest';
import { enSkeleton, skeletonMatch } from '../../../src/components/MapWindows/voiceFuzzy';
import { parseVoiceTranscript } from '../../../src/components/MapWindows/voiceTranscriptParser';

/**
 * Phonetic consonant-skeleton stage (2026-08-06) — the closed-set fallback
 * for sound-alikes the letter-D-L caps can't catch ("cafe"→cathay cf/cθ,
 * "ethiopian"→"three one" θpn/θrn). Encoder + guards pinned here; the
 * end-to-end rows live in voiceDeviationMatrix.test.js (group 6b/8c).
 */

const AIRCRAFT = [{
  callSign: 'CSC6918', controlSeat: 5,
  position: { x: 0, y: 0, z: 0 }, noseDirection: { x: 0, y: 0, z: 1 },
  airSpeedKnot: 200,
}];

describe('enSkeleton (deterministic consonant skeleton)', () => {
  it('digraph + vowel/glide-drop pipeline', () => {
    expect(enSkeleton('cafe')).toBe('cf');
    expect(enSkeleton('cathay')).toBe('cθ');          // th → θ
    expect(enSkeleton('china')).toBe('xn');           // ch → x
    expect(enSkeleton('eight')).toBe('t');            // silent gh dropped
    expect(enSkeleton('ethiopian')).toBe('θpn');
    expect(enSkeleton('three one')).toBe('θrn');      // non-letters dropped, space gone
    expect(enSkeleton('Thirty One')).toBe('θrtn');    // lowercase first — deterministic
  });

  it('skeleton D-L exactly 1 — exact-skeleton homophones reject (hannah vs hainan → nn)', () => {
    expect(enSkeleton('hannah')).toBe('nn');
    expect(enSkeleton('hainan')).toBe('nn');
    expect(skeletonMatch('hannah', ['hainan'])).toBeNull();   // d0 ≠ 1 — raw D-L covers near-identical words
  });

  it('guards: min skeleton 2, first symbol, raw-length diff ≤ 2', () => {
    expect(skeletonMatch('one', ['cathay'])).toBeNull();         // token skeleton 'n' < 2
    expect(skeletonMatch('air', ['cathay'])).toBeNull();         // 'r' < 2
    expect(skeletonMatch('banana', ['three', 'four'])).toBeNull();   // b never reaches θ/f-initial forms
    expect(skeletonMatch('cafeteria', ['cathay'])).toBeNull();   // raw diff |6-9| = 3 > 2
  });

  it('ties fail; unique best wins', () => {
    expect(skeletonMatch('cafe', ['cathay', 'cpa'])).toBeNull(); // cf vs cθ AND cp both d1
    expect(skeletonMatch('cafe', ['cathay'])).toBe('cathay');
    expect(skeletonMatch('ethiopian', ['three one'])).toBe('three one');
  });
});

describe('runway phonetic fallback (integration)', () => {
  it('"runway ethiopian right" → 31R consumed, no notice (ethiopian ≈ three one)', () => {
    const r = parseVoiceTranscript('CSC6918: clear for approach runway ethiopian right', AIRCRAFT);
    expect(r.ok).toBe(true);
    expect(r.commands.map(c => c.type)).toEqual(['clear_for_appr']);
    expect(r.notices).toEqual([]);
  });

  it('"runway banana" stays an unsupported notice (no phonetic runway match)', () => {
    const r = parseVoiceTranscript('CSC6918: clear for approach runway banana', AIRCRAFT);
    expect(r.notices.join(' ')).toContain('runway banana');
  });
});
