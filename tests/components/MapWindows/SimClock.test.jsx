import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import SimClock from '../../../src/components/MapWindows/SimClock';

describe('SimClock', () => {
  it('renders nothing when simTimeUnixMs is 0', () => {
    const { container } = render(<SimClock simTimeUnixMs={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when simTimeUnixMs is null', () => {
    const { container } = render(<SimClock simTimeUnixMs={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when simTimeUnixMs is undefined', () => {
    const { container } = render(<SimClock simTimeUnixMs={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders formatted HH:MM:SS UTC for a valid timestamp', () => {
    // 2025-06-15T14:30:45Z = Unix ms
    const ts = new Date('2025-06-15T14:30:45Z').getTime();
    const { container } = render(<SimClock simTimeUnixMs={ts} />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector('.air-map-clock').textContent).toBe('14:30:45');
  });

  it('renders midnight correctly', () => {
    const ts = new Date('2025-01-01T00:00:00Z').getTime();
    const { container } = render(<SimClock simTimeUnixMs={ts} />);
    expect(container.querySelector('.air-map-clock').textContent).toBe('00:00:00');
  });
});
