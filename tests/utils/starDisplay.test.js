import { describe, it, expect } from 'vitest';
import {
  stripStarRunwaySuffix,
  hasStarRunwaySuffix,
  dedupeStarPathsForDisplay,
  filterDedupedStarPathsByRunway,
} from '../../src/utils/starDisplay';

describe('stripStarRunwaySuffix', () => {
  it('strips ZGSZ-style runway suffix from STAR names', () => {
    expect(stripStarRunwaySuffix('SAREX4.34L')).toBe('SAREX4');
    expect(stripStarRunwaySuffix('SAREX4.34R')).toBe('SAREX4');
    expect(stripStarRunwaySuffix('SAREX4.33')).toBe('SAREX4');
    expect(stripStarRunwaySuffix('BEKOL3.16L')).toBe('BEKOL3');
    expect(stripStarRunwaySuffix('SAREX4.15')).toBe('SAREX4');
  });

  it('leaves non-suffixed STAR names untouched', () => {
    expect(stripStarRunwaySuffix('ABTU6W')).toBe('ABTU6W');
    expect(stripStarRunwaySuffix('WFG91A')).toBe('WFG91A');
    expect(stripStarRunwaySuffix('UBSS6W')).toBe('UBSS6W');
  });

  it('handles non-string input', () => {
    expect(stripStarRunwaySuffix(null)).toBeNull();
    expect(stripStarRunwaySuffix(undefined)).toBeUndefined();
  });
});

describe('hasStarRunwaySuffix', () => {
  it('detects runway-suffixed names', () => {
    expect(hasStarRunwaySuffix('SAREX4.34L')).toBe(true);
    expect(hasStarRunwaySuffix('OVGOT3.15')).toBe(true);
  });

  it('rejects plain names', () => {
    expect(hasStarRunwaySuffix('ABTU6W')).toBe(false);
    expect(hasStarRunwaySuffix('')).toBe(false);
    expect(hasStarRunwaySuffix(null)).toBe(false);
  });
});

describe('dedupeStarPathsForDisplay', () => {
  const mk = (x, z) => ({ x, z });
  const pts = n => Array.from({ length: n }, (_, i) => mk(i * 10, i * 10));

  it('merges runway-suffixed variants into one base STAR group', () => {
    const starPaths = {
      'SAREX4.34L': [{ runway: '34L', points: pts(14) }],
      'SAREX4.34R': [{ runway: '34R', points: pts(14) }],
      'SAREX4.33':  [{ runway: '33',  points: pts(14) }],
      'SAREX4.15':  [{ runway: '15',  points: pts(13) }],
    };
    const out = dedupeStarPathsForDisplay(starPaths);
    expect(Object.keys(out)).toEqual(['SAREX4']);
    expect(out['SAREX4']).toHaveLength(1);
    const group = out['SAREX4'][0];
    expect(group.name).toBe('SAREX4');
    expect(group.runways).toEqual(expect.arrayContaining(['34L', '34R', '33', '15']));
    expect(group.points).toHaveLength(14);
  });

  it('preserves non-suffixed STARs per-runway variants', () => {
    const starPaths = {
      'UBSS6W': [
        { runway: '19', points: pts(3) },
        { runway: '01', points: pts(4) },
      ],
      'ABTU6W': [{ runway: '19', points: pts(2) }],
    };
    const out = dedupeStarPathsForDisplay(starPaths);
    expect(Object.keys(out).sort()).toEqual(['ABTU6W', 'UBSS6W']);
    expect(out['UBSS6W']).toHaveLength(2);
    expect(out['UBSS6W'].map(v => v.runway).sort()).toEqual(['01', '19']);
    expect(out['ABTU6W']).toHaveLength(1);
  });

  it('returns empty object for null/empty input', () => {
    expect(dedupeStarPathsForDisplay(null)).toEqual({});
    expect(dedupeStarPathsForDisplay({})).toEqual({});
  });
});

describe('filterDedupedStarPathsByRunway', () => {
  it('keeps a group when any of its runways is active', () => {
    const paths = {
      'SAREX4': [{ name: 'SAREX4', runways: ['34L', '34R', '33'], points: [{ x: 0, z: 0 }] }],
    };
    const out = filterDedupedStarPathsByRunway(paths, new Set(['34R', '16L']));
    expect(Object.keys(out)).toEqual(['SAREX4']);
  });

  it('drops a group when no runway is active', () => {
    const paths = {
      'SAREX4': [{ name: 'SAREX4', runways: ['34L', '34R'], points: [{ x: 0, z: 0 }] }],
      'SAREX5': [{ name: 'SAREX5', runways: ['15'], points: [{ x: 0, z: 0 }] }],
    };
    const out = filterDedupedStarPathsByRunway(paths, new Set(['99']));
    expect(Object.keys(out)).toEqual([]);
  });

  it('filters preserved per-runway variants by singular runway field', () => {
    const paths = {
      'UBSS6W': [
        { runway: '19', points: [{ x: 0, z: 0 }] },
        { runway: '01', points: [{ x: 0, z: 0 }] },
      ],
    };
    const out = filterDedupedStarPathsByRunway(paths, new Set(['19']));
    expect(out['UBSS6W']).toHaveLength(1);
    expect(out['UBSS6W'][0].runway).toBe('19');
  });
});

describe('SID dedup (same helper, ZGSZ-style suffixed SID names)', () => {
  const mk = (x, z) => ({ x, z });
  const pts = n => Array.from({ length: n }, (_, i) => mk(i * 10, i * 10));

  it('collapses runway-suffixed SID variants into base SID groups', () => {
    const sidPaths = {
      'OVGOT1.34R': [{ runway: '34R', points: pts(10) }],
      'OVGOT1.34L': [{ runway: '34L', points: pts(10) }],
      'OVGOT1.33':  [{ runway: '33',  points: pts(9) }],
      'OVGOT2.16L': [{ runway: '16L', points: pts(12) }],
    };
    const out = dedupeStarPathsForDisplay(sidPaths);
    // Distinct SID versions stay separate; runway variants merge per version
    expect(Object.keys(out).sort()).toEqual(['OVGOT1', 'OVGOT2']);
    expect(out['OVGOT1']).toHaveLength(1);
    expect(out['OVGOT1'][0].runways).toEqual(expect.arrayContaining(['34R', '34L', '33']));
    expect(out['OVGOT1'][0].points).toHaveLength(10);
    expect(out['OVGOT2'][0].runways).toEqual(['16L']);
  });

  it('filters deduped SID groups by active runway', () => {
    const sidPaths = {
      'OVGOT1.34R': [{ runway: '34R', points: pts(5) }],
      'OVGOT1.34L': [{ runway: '34L', points: pts(5) }],
    };
    const deduped = dedupeStarPathsForDisplay(sidPaths);
    const out = filterDedupedStarPathsByRunway(deduped, new Set(['34L']));
    expect(Object.keys(out)).toEqual(['OVGOT1']);
  });
});