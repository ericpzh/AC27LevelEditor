// @vitest-environment node

/**
 * Tests for src/utils/gameCallsigns.js — the install-global flight-number pool.
 *
 * The pool is the union of every airport's `_flightNums` (callsigns the game's
 * own levels ship). `catalog.bin` is deliberately NOT used: it lists callsigns
 * that the game cannot allocate (verified in-game) and is voice/bundle-scoped.
 */

import { describe, it, expect } from 'vitest';

const { unionFlightNums } = require('../../src/utils/gameCallsigns');

describe('unionFlightNums', () => {
  it('unions per-airport maps and numeric-sorts', () => {
    const out = unionFlightNums([
      { CES: ['9197', '42'] },
      { CES: ['1111'], MAS: ['2719'] },
    ]);
    expect(out.CES).toEqual(['42', '1111', '9197']);
    expect(out.MAS).toEqual(['2719']);
  });

  it('dedupes across airports', () => {
    const out = unionFlightNums([{ AAL: ['100', '200'] }, { AAL: ['200', '300'] }]);
    expect(out.AAL).toEqual(['100', '200', '300']);
  });

  it('returns airline keys sorted', () => {
    const out = unionFlightNums([{ CSN: ['1'], AAL: ['2'], CES: ['3'] }]);
    expect(Object.keys(out)).toEqual(['AAL', 'CES', 'CSN']);
  });

  it('tolerates null / undefined entries', () => {
    expect(unionFlightNums([null, undefined, { A: ['1'] }]).A).toEqual(['1']);
    expect(unionFlightNums([])).toEqual({});
    expect(unionFlightNums(null)).toEqual({});
  });
});
