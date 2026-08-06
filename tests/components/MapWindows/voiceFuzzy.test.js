import { describe, it, expect } from 'vitest';
import {
  damerauLevenshtein,
  maxDistForWord,
  isFuzzyEligible,
  MIN_FUZZY_LEN,
  NON_FUZZY_WORDS,
  CURATED_EXCLUDE,
  CURATED_CONFUSABLES,
  resolveCuratedPhrase,
  fuzzyMatch,
  fuzzyLookupKey,
} from '../../../src/components/MapWindows/voiceFuzzy';

// ─── Damerau-Levenshtein ───────────────────────────────────────────────

describe('damerauLevenshtein', () => {
  it('identical strings → 0', () => {
    expect(damerauLevenshtein('heading', 'heading')).toBe(0);
  });

  it('single substitution → 1', () => {
    expect(damerauLevenshtein('heading', 'heeding')).toBe(1);
    expect(damerauLevenshtein('tree', 'three')).toBe(1); // insert h
  });

  it('adjacent transposition → 1', () => {
    expect(damerauLevenshtein('redcue', 'reduce')).toBe(1);
    expect(damerauLevenshtein('ab', 'ba')).toBe(1);
  });

  it('"won" vs "one" → 2 (the D-L boundary — phonetics are not covered by distance alone)', () => {
    expect(damerauLevenshtein('won', 'one')).toBe(2);
  });

  it('"reduce" vs "descend" ≥ 3', () => {
    expect(damerauLevenshtein('reduce', 'descend')).toBeGreaterThanOrEqual(3);
  });

  it('empty vs non-empty → length', () => {
    expect(damerauLevenshtein('', 'a')).toBe(1);
  });

  it('is case-sensitive (callers lowercase first)', () => {
    expect(damerauLevenshtein('Heading', 'heading')).toBe(1);
  });
});

// ─── Thresholds ────────────────────────────────────────────────────────

describe('maxDistForWord', () => {
  it('≤5 chars → 1', () => {
    expect(maxDistForWord('left')).toBe(1);
    expect(maxDistForWord('right')).toBe(1);
    expect(maxDistForWord('climb')).toBe(1);
  });

  it('≥6 chars → 2', () => {
    expect(maxDistForWord('heading')).toBe(2);
    expect(maxDistForWord('maintain')).toBe(2);
    expect(maxDistForWord('descend')).toBe(2);
  });
});

describe('isFuzzyEligible', () => {
  it('tokens ≥ MIN_FUZZY_LEN are eligible', () => {
    expect(MIN_FUZZY_LEN).toBe(3);
    expect(isFuzzyEligible('heading')).toBe(true);
  });

  it('short-token allowlist: to/an/on/of (real SAPI artifacts)', () => {
    expect(isFuzzyEligible('to')).toBe(true);
    expect(isFuzzyEligible('an')).toBe(true);
    expect(isFuzzyEligible('on')).toBe(true);
    expect(isFuzzyEligible('of')).toBe(true);
  });

  it('shorter tokens are exact-only', () => {
    expect(isFuzzyEligible('fl')).toBe(false);
    expect(isFuzzyEligible('at')).toBe(false);
    expect(isFuzzyEligible('ho')).toBe(false);
    expect(isFuzzyEligible('m')).toBe(false);
    expect(isFuzzyEligible('wo')).toBe(false);
  });
});

// ─── Non-fuzzy words ───────────────────────────────────────────────────

describe('NON_FUZZY_WORDS', () => {
  it('covers the fillers', () => {
    expect(NON_FUZZY_WORDS).toContain('uh');
    expect(NON_FUZZY_WORDS).toContain('um');
    expect(NON_FUZZY_WORDS).toContain('okay');
    expect(NON_FUZZY_WORDS).toContain('sir');
    expect(NON_FUZZY_WORDS).toContain('please');
  });
});

// ─── Semantic-inversion blacklist ──────────────────────────────────────

describe('CURATED_EXCLUDE', () => {
  it('blocks ascend → descend even at distance 2', () => {
    expect(fuzzyMatch('ascend', ['descend'], 2)).toBeNull();
  });

  it('blocks decrease → increase even at distance 2', () => {
    expect(fuzzyMatch('decrease', ['increase'], 2)).toBeNull();
  });

  it('still allows the intended distance-2 accepts', () => {
    expect(fuzzyMatch('decent', ['descend'], 2)?.candidate).toBe('descend');
  });

  it('exact match of an excluded word still hits (maps to itself)', () => {
    expect(fuzzyMatch('ascend', ['ascend', 'descend'], 2)).toEqual({ candidate: 'ascend', dist: 0 });
  });
});

// ─── Curated multi-token confusables ───────────────────────────────────

describe('CURATED_CONFUSABLES', () => {
  it('covers the spelled-out approach types + FL + the direct mishearing', () => {
    expect(Object.keys(CURATED_CONFUSABLES).sort()).toEqual(['direct', 'fl', 'ils', 'loc', 'ndb', 'rnav', 'vor']);
  });
});

describe('resolveCuratedPhrase', () => {
  it('resolves joined phrases to canonical tokens', () => {
    expect(resolveCuratedPhrase('eye el ess')).toBe('ils');
    expect(resolveCuratedPhrase('i l s')).toBe('ils');
    expect(resolveCuratedPhrase('r nav')).toBe('rnav');
    expect(resolveCuratedPhrase('eff el')).toBe('fl');
    expect(resolveCuratedPhrase('vee or')).toBe('vor');
  });

  it('returns null for unknown phrases', () => {
    expect(resolveCuratedPhrase('apple pie')).toBeNull();
  });

  it('supports target restriction', () => {
    expect(resolveCuratedPhrase('eye el ess', 'ils')).toBe('ils');
    expect(resolveCuratedPhrase('eye el ess', 'rnav')).toBeNull();
  });
});

// ─── fuzzyMatch / fuzzyLookupKey ───────────────────────────────────────

describe('fuzzyMatch', () => {
  it('exact match wins immediately', () => {
    expect(fuzzyMatch('heading', ['heeding', 'heading', 'reading'])).toEqual({ candidate: 'heading', dist: 0 });
  });

  it('ties first-wins deterministically', () => {
    // 'tree' is distance 1 from both 'three' and 'trees'
    expect(fuzzyMatch('tree', ['three', 'trees'], 1)?.candidate).toBe('three');
    // array order is the tiebreaker — reversed list flips the winner
    expect(fuzzyMatch('tree', ['trees', 'three'], 1)?.candidate).toBe('trees');
  });

  it('respects maxDist', () => {
    expect(fuzzyMatch('tree', ['three'], 1)?.candidate).toBe('three');
    expect(fuzzyMatch('tree', ['three'], 0)).toBeNull();
  });

  it('returns null beyond maxDist', () => {
    expect(fuzzyMatch('won', ['one'], 1)).toBeNull(); // distance 2
    expect(fuzzyMatch('tom', ['turn'], 1)).toBeNull();
  });

  it('repeated calls are identical (deterministic)', () => {
    const a = fuzzyMatch('heeding', ['heading', 'heeding', 'reading']);
    const b = fuzzyMatch('heeding', ['heading', 'heeding', 'reading']);
    expect(a).toEqual(b);
  });

  it('fillers never fuzzy-map (even when close)', () => {
    expect(fuzzyMatch('sir', ['air'], 1)).toBeNull(); // distance 1, but 'sir' is a filler
    expect(fuzzyMatch('uh', ['oh'], 1)).toBeNull();   // distance 1, but 'uh' is a filler
  });

  it('short tokens are exact-only (eligibility)', () => {
    expect(fuzzyMatch('ho', ['oh'], 1)).toBeNull();   // distance 1, but 2 chars
    expect(fuzzyMatch('to', ['two'], 1)?.candidate).toBe('two'); // 'to' carve-out
  });

  it('default maxDist follows maxDistForWord', () => {
    expect(fuzzyMatch('heeding', ['heading'])?.candidate).toBe('heading');  // 7-char → cap 2
    expect(fuzzyMatch('flying', ['fly'])).toBeNull();                       // length diff 3 > cap 2
  });
});

describe('fuzzyLookupKey', () => {
  it('exact-first on table keys', () => {
    expect(fuzzyLookupKey('two', ['one', 'two', 'three'], 1)).toBe('two');
  });

  it('D-L ≤ 1 over the key list (number/unit rule)', () => {
    expect(fuzzyLookupKey('tree', ['one', 'two', 'three'], 1)).toBe('three');
    expect(fuzzyLookupKey('to', ['one', 'two'], 1)).toBe('two');
    expect(fuzzyLookupKey('nots', ['knots', 'knot'], 1)).toBe('knots');
  });

  it('filler + exclusion rules apply', () => {
    expect(fuzzyLookupKey('uh', ['oh', 'zero'], 1)).toBeNull();
    expect(fuzzyLookupKey('ascend', ['descend'], 2)).toBeNull();
  });
});
