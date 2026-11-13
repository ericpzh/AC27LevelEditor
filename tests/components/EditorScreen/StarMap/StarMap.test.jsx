import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../../../src/hooks/useTranslation';
import { useAppStore } from '../../../../src/store/appStore';
import StarMap from '../../../../src/components/EditorScreen/StarMap/StarMap';

const { getAircraftPositions } = vi.hoisted(() => ({ getAircraftPositions: vi.fn() }));
vi.mock('../../../../src/hooks/useElectronAPI', () => ({
  useElectronAPI: () => ({ getAircraftPositions }),
}));

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

  it('renders the panel portal when there is no star data', () => {
    renderMap({ starPaths: {} });
    const panel = document.querySelector('.star-map-panel');
    expect(panel).not.toBeNull();
    expect(document.body.contains(panel)).toBe(true);
    expect(document.querySelector('.star-map-svg')).toBeNull();
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

  it('filters STAR variants to the selected runway only', () => {
    renderMap({ selectedRunway: '01' });
    // STAR1A's '19' variant is filtered out; only '01' variants remain (STAR1A + STAR2B)
    const lines = document.querySelectorAll('.star-map-line');
    expect(lines.length).toBe(2);
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

  it('keeps each aircraft at its computed position when selection changes', async () => {
    getAircraftPositions.mockResolvedValue({
      success: true,
      totalApproachTimes: { STAR1A: 300, STAR2B: 300 },
      positions: [
        { callsign: 'CCA1234', x: 1, z: 4, headingDeg: 45 },
        { callsign: 'DKH6071', x: 0, z: 7, headingDeg: 90 },
      ],
    });
    const arrivalFlights = [
      { CallSign: 'CCA1234', Airway: 'STAR1A', Runway: '01', _landingSec: 180 },
      { CallSign: 'DKH6071', Airway: 'STAR2B', Runway: '01', _landingSec: 200 },
    ];
    const chart = (callsign, selectedStar) => (
      <I18nProvider>
        <StarMap starPaths={MOCK_STAR_PATHS} starRunwayMap={MOCK_STAR_RUNWAY_MAP}
          selectedRunway="01" callsign={callsign} selectedStar={selectedStar}
          arrivalFlights={arrivalFlights} airportIcao="ZSJN" saveSec={100}
          buttonRef={makeButtonRef()} />
      </I18nProvider>
    );
    const marker = (callsign) => [...document.querySelectorAll('.star-map-ac-label')]
      .find(label => label.textContent === callsign)?.previousElementSibling;
    const { rerender } = render(chart('CCA1234', 'STAR1A'));

    await waitFor(() => expect(marker('DKH6071')).toBeTruthy());
    const transforms = arrivalFlights.map(flight => marker(flight.CallSign).style.transform);
    expect(marker('CCA1234').classList.contains('editing')).toBe(true);

    rerender(chart('DKH6071', 'STAR2B'));

    expect(arrivalFlights.map(flight => marker(flight.CallSign).style.transform)).toEqual(transforms);
    expect(marker('DKH6071').classList.contains('editing')).toBe(true);
  });
});
