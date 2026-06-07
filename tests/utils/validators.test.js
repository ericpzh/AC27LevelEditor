import { describe, it, expect } from 'vitest';
import { validateCallsigns } from '../../src/utils/validators';

describe('validateCallsigns', () => {
  it('returns empty array when no duplicates', () => {
    const flights = [
      { CallSign: 'CES1234' },
      { CallSign: 'CAL5678' },
      { CallSign: 'CSN9012' },
    ];
    expect(validateCallsigns(flights)).toEqual([]);
  });

  it('returns duplicate callsigns', () => {
    const flights = [
      { CallSign: 'CES1234' },
      { CallSign: 'CES1234' },
      { CallSign: 'CAL5678' },
      { CallSign: 'CAL5678' },
    ];
    const dupes = validateCallsigns(flights);
    expect(dupes).toHaveLength(2);
    expect(dupes).toContain('CES1234');
    expect(dupes).toContain('CAL5678');
  });

  it('ignores empty callsigns', () => {
    const flights = [
      { CallSign: '' },
      { CallSign: '  ' },
      { CallSign: 'CES1234' },
    ];
    expect(validateCallsigns(flights)).toEqual([]);
  });

  it('returns each duplicate only once', () => {
    const flights = [
      { CallSign: 'CES1234' },
      { CallSign: 'CES1234' },
      { CallSign: 'CES1234' },
    ];
    const dupes = validateCallsigns(flights);
    expect(dupes).toEqual(['CES1234']);
  });

  it('handles empty flight array', () => {
    expect(validateCallsigns([])).toEqual([]);
  });
});
