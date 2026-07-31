import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../../../../src/hooks/useTranslation';
import { useAppStore } from '../../../../src/store/appStore';
import StarMap from '../../../../src/components/EditorScreen/StarMap/StarMap';

const MOCK_STAR_PATHS = {
  'STAR1A': [
    { runway: '01', points: [{ x: 0, z: 5 }, { x: 1, z: 4 }, { x: 2, z: 3 }] },
    { runway: '19', points: [{ x: 0, z: -5 }, { x: -1, z: -4 }, { x: -2, z: -3 }] },
  ],
  'STAR2B': [
    { runway: '01', points: [{ x: 0, z: 8 }, { x: 1, z: 7 }] },
  ],
};

const MOCK_RUNWAY_THRESHOLDS = {
  '01/19': { a: { x: 2, z: 3 }, b: { x: -2, z: -3 } },
};

const MOCK_STAR_RUNWAY_MAP = {
  'STAR1A': ['01', '19'],
  'STAR2B': ['01'],
};

function makeButtonRef() {
  const el = document.createElement('button');
  el.getBoundingClientRect = () => ({ left: 10, right: 100, top: 520, bottom: 552, width: 90, height: 32 });
  return { current: el };
}

function renderMap(props = {}) {
  const onSelect = vi.fn();
  return {
    onSelect,
    ...render(
      <I18nProvider>
        <StarMap
          starPaths={MOCK_STAR_PATHS}
          selectedStar={null}
          selectedRunway={null}
          starRunwayMap={MOCK_STAR_RUNWAY_MAP}
          runwayThresholds={MOCK_RUNWAY_THRESHOLDS}
          onSelect={onSelect}
          onShrink={vi.fn()}
          buttonRef={makeButtonRef()}
          airportIcao="ZSJN"
          callsign="CCA1234"
          isDeparture={false}
          arrivalFlights={[]}
          saveSec={0}
          {...props}
        />
      </I18nProvider>
    ),
  };
}

describe('StarMap', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it('renders the panel portal when there is no star data (isV4: false)', () => {
    renderMap({ starPaths: {} });
    const panel = document.querySelector('.star-map-panel');
    expect(panel).not.toBeNull();
    expect(document.body.contains(panel)).toBe(true);
    expect(document.querySelector('.star-map-svg')).toBeNull();
    expect(document.querySelector('.star-map-empty')).not.toBeNull();
  });

  it('renders the panel portal with no star data (isV4: true)', () => {
    useAppStore.setState({ isV4: true });
    renderMap({ starPaths: {} });
    expect(document.querySelector('.star-map-panel')).not.toBeNull();
    expect(document.querySelector('.star-map-empty')).not.toBeNull();
  });

  it('renders runway threshold lines', () => {
    renderMap();
    const rwyLines = document.querySelectorAll('.star-map-runway');
    expect(rwyLines.length).toBe(Object.keys(MOCK_RUNWAY_THRESHOLDS).length);
  });

  it('renders STAR polylines for all variants', () => {
    renderMap();
    // 3 variants total across both STARs
    const lines = document.querySelectorAll('.star-map-line');
    expect(lines.length).toBe(3);
  });

  it('renders STAR labels', () => {
    renderMap();
    const labels = document.querySelectorAll('.star-map-label');
    const labelTexts = [...labels].map(l => l.textContent);
    expect(labelTexts).toEqual(expect.arrayContaining(['STAR1A', 'STAR2B']));
  });

  it('renders the legend', () => {
    renderMap();
    expect(document.querySelector('.star-map-legend')).not.toBeNull();
    expect(document.querySelectorAll('.star-map-legend-item').length).toBeGreaterThan(0);
  });

  it('renders the shrink button', () => {
    renderMap();
    expect(document.querySelector('.star-map-shrink')).not.toBeNull();
  });

  it('v4: filters STAR variants to the selected runway only', () => {
    useAppStore.setState({ isV4: true });
    renderMap({ selectedRunway: '01' });
    // STAR1A's '19' variant is filtered out; only '01' variants remain (STAR1A + STAR2B)
    const lines = document.querySelectorAll('.star-map-line');
    expect(lines.length).toBe(2);
  });

  it('v2/v3: keeps all STAR variants when a runway is selected', () => {
    useAppStore.setState({ isV4: false });
    renderMap({ selectedRunway: '01' });
    const lines = document.querySelectorAll('.star-map-line');
    expect(lines.length).toBe(3);
  });

  it('clicking a STAR polyline calls onSelect', () => {
    const { onSelect } = renderMap();
    // The <g> holding a STAR's polylines carries the click handler.
    const firstGroup = document.querySelector('.star-map-line').parentElement;
    expect(firstGroup.tagName).toBe('g');
    fireEvent.click(firstGroup);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('hovering a STAR highlights it with the hovered class', () => {
    renderMap();
    const firstGroup = document.querySelector('.star-map-line').parentElement;
    fireEvent.mouseEnter(firstGroup);
    const hovered = document.querySelector('.star-map-line.hovered');
    expect(hovered).not.toBeNull();
  });
});
