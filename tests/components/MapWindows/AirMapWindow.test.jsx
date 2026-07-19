import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { mockIpcInvoke } from '../../setup';
import { setLang } from '../../../src/utils/i18n';

// ── Module-level mocks ──────────────────────────────────────────

vi.mock('../../../src/components/MapWindows/useUdpAircraftState', () => ({
  default: vi.fn(),
}));
vi.mock('../../../src/components/MapWindows/useSvgZoom', () => ({
  default: vi.fn(),
}));

import useUdpAircraftState from '../../../src/components/MapWindows/useUdpAircraftState';
import useSvgZoom from '../../../src/components/MapWindows/useSvgZoom';
import AirMapWindow from '../../../src/components/MapWindows/AirMapWindow';

const DEFAULT_VB = { x: -1500, y: -3000, w: 3000, h: 3000 };

function setupDefaultMocks(overrides = {}) {
  useUdpAircraftState.mockReturnValue({
    aircraft: [],
    currentAirport: null,
    simTimeUnixMs: 0,
  });

  const noop = vi.fn();
  useSvgZoom.mockReturnValue({
    viewBox: DEFAULT_VB,
    svgRef: { current: null },
    resetZoom: noop, resetPanH: noop, resetPanV: noop,
    handleWheel: noop, handleMouseDown: noop, handleMouseMove: noop, handleMouseUp: noop,
    zoomIn: noop, zoomOut: noop, panLeft: noop, panRight: noop, panUp: noop, panDown: noop,
  });

  mockIpcInvoke.mockImplementation((channel, ...args) => {
    if (overrides[channel] !== undefined) {
      const v = overrides[channel];
      return typeof v === 'function' ? v(...args) : Promise.resolve(v);
    }
    switch (channel) {
      case 'collect-values':
        return Promise.resolve({
          _starPaths: {},
          _sidPaths: {},
          _missedAppPaths: {},
          _apprPaths: {},
          _runwayThresholds: {},
        });
      default:
        return Promise.resolve({});
    }
  });
}

function renderAirMap(props = {}) {
  return render(
    <I18nProvider>
      <AirMapWindow airportIcao="ZSJN" {...props} />
    </I18nProvider>
  );
}

beforeEach(() => {
  setLang('en');
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', {
    value: { search: '?window=airMap&airport=ZSJN&root=C%3A%5C%5CGames%5C%5CAC27' },
    writable: true,
  });
});

describe('AirMapWindow', () => {
  // ── Loading / Error states ──────────────────────────────────

  it('shows loading spinner initially', () => {
    mockIpcInvoke.mockReturnValue(new Promise(() => {}));
    useUdpAircraftState.mockReturnValue({ aircraft: [], currentAirport: null, simTimeUnixMs: 0 });
    useSvgZoom.mockReturnValue({
      viewBox: DEFAULT_VB, svgRef: { current: null },
      resetZoom: vi.fn(), resetPanH: vi.fn(), resetPanV: vi.fn(),
      handleWheel: vi.fn(), handleMouseDown: vi.fn(), handleMouseMove: vi.fn(), handleMouseUp: vi.fn(),
      zoomIn: vi.fn(), zoomOut: vi.fn(), panLeft: vi.fn(), panRight: vi.fn(), panUp: vi.fn(), panDown: vi.fn(),
    });

    const { container } = renderAirMap();
    expect(container.querySelector('.air-map-loading')).toBeTruthy();
    expect(container.querySelector('.spinner')).toBeTruthy();
  });

  it('shows error message when data fetch fails', async () => {
    setupDefaultMocks({ 'collect-values': Promise.reject(new Error('Fetch error')) });
    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-error')).toBeTruthy();
    });
    expect(container.querySelector('.air-map-error').textContent).toContain('Fetch error');
  });

  // ── Data fetch ──────────────────────────────────────────────

  it('calls collectValues with rootPath and airportIcao', async () => {
    setupDefaultMocks();
    renderAirMap();

    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith(
        'collect-values',
        expect.stringContaining('AC27'),
        'ZSJN'
      );
    });
  });

  it('renders SVG after data loads', async () => {
    setupDefaultMocks();
    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-svg')).toBeTruthy();
    });
  });

  // ── Window title ────────────────────────────────────────────

  it('sets document title with airport ICAO', async () => {
    setupDefaultMocks();
    renderAirMap();
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('collect-values', expect.any(String), 'ZSJN');
    });
    expect(document.title).toBe('ZSJN Approach Radar');
  });

  // ── Border overlay ──────────────────────────────────────────

  it('renders the border overlay SVG', async () => {
    setupDefaultMocks();
    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-border-overlay')).toBeTruthy();
    });
    const borderSvg = container.querySelector('.air-map-border-overlay svg');
    expect(borderSvg).toBeTruthy();
  });

  // ── Airport mismatch filter (airAircraft) ───────────────────

  it('shows no aircraft when UDP airport does not match', async () => {
    setupDefaultMocks();
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        {
          callSign: 'CES1234', position: { x: 100, y: 500, z: 200 },
          noseDirection: { x: 1, z: 0 }, trail: [{ x: 100, z: 200, age: 0 }],
          flightDirection: 1, airSpeedKnot: 240, aircraftType: 'B738',
        },
      ],
      currentAirport: 'KJFK', // Different airport
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-svg')).toBeTruthy();
    });

    const acGroups = container.querySelectorAll('.air-map-aircraft-group');
    expect(acGroups.length).toBe(0);
  });

  // ── Airborne filter: y <= 1.0 → hidden ─────────────────────

  it('filters out ground-level aircraft (y <= 1.0)', async () => {
    setupDefaultMocks();
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        { callSign: 'GND001', position: { x: 10, y: 0.5, z: 20 }, noseDirection: { x: 1, z: 0 }, trail: [{ x: 10, z: 20, age: 0 }], flightDirection: 0, airSpeedKnot: 0, aircraftType: 'A320' },
        { callSign: 'AIR001', position: { x: 100, y: 500, z: 200 }, noseDirection: { x: 0, z: 1 }, trail: [{ x: 100, z: 200, age: 0 }], flightDirection: 1, airSpeedKnot: 240, aircraftType: 'B738' },
      ],
      currentAirport: 'ZSJN',
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-svg')).toBeTruthy();
    });

    const acGroups = container.querySelectorAll('.air-map-aircraft-group');
    expect(acGroups.length).toBe(1); // Only AIR001 visible (y > 1.0)
  });

  // ── Click to select aircraft ────────────────────────────────

  it('selects aircraft via centralized API on click', async () => {
    const selectSpy = vi.fn();
    window.electronAPI.selectAircraftInMap = selectSpy;

    setupDefaultMocks();
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        {
          callSign: 'CES1234', position: { x: 100, y: 500, z: 200 },
          noseDirection: { x: 1, z: 0 },
          trail: [{ x: 100, z: 200, age: 0 }],
          flightDirection: 1, airSpeedKnot: 240, aircraftType: 'B738',
        },
      ],
      currentAirport: 'ZSJN',
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-aircraft-group')).toBeTruthy();
    });

    const acGroup = container.querySelector('.air-map-aircraft-group');
    fireEvent.click(acGroup);

    expect(selectSpy).toHaveBeenCalledWith('ZSJN', 'CES1234');
  });

  // ── Background image toggle ─────────────────────────────────

  it('shows background image when toggle is on', async () => {
    setupDefaultMocks();
    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-svg')).toBeTruthy();
    });

    // Initially no background image
    let images = container.querySelectorAll('.air-map-svg image');
    expect(images.length).toBe(0);

    // Find and click the bg toggle (last toggle button before refresh)
    const toggles = container.querySelectorAll('.air-map-toggle');
    const bgToggle = toggles[5]; // 6th toggle: STAR, SID, APPR, labels, runway ext, bg, refresh
    fireEvent.click(bgToggle);

    // After click, background image should appear
    await waitFor(() => {
      images = container.querySelectorAll('.air-map-svg image');
      expect(images.length).toBe(1);
    });
  });

  // ── Toggle buttons ──────────────────────────────────────────

  it('renders STAR toggle active by default', async () => {
    setupDefaultMocks();
    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-svg')).toBeTruthy();
    });

    const toggles = container.querySelectorAll('.air-map-toggle');
    // First toggle = STAR, should be active
    expect(toggles[0].classList.contains('active')).toBe(true);
  });

  it('renders SID toggle inactive by default', async () => {
    setupDefaultMocks();
    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-svg')).toBeTruthy();
    });

    const toggles = container.querySelectorAll('.air-map-toggle');
    // Second toggle = SID, should NOT be active
    expect(toggles[1].classList.contains('active')).toBe(false);
  });

  it('renders Refresh button', async () => {
    setupDefaultMocks();
    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-svg')).toBeTruthy();
    });

    const toggles = container.querySelectorAll('.air-map-toggle');
    // Last toggle = Refresh
    expect(toggles.length).toBeGreaterThanOrEqual(6);
  });

  // ── Route polylines from data ───────────────────────────────

  it('renders route polylines when paths are provided', async () => {
    setupDefaultMocks({
      'collect-values': {
        _starPaths: {
          'UBSS6W': [{ runway: '19', points: [{ x: 0, z: 0 }, { x: 50, z: -100 }, { x: 100, z: -200 }] }],
        },
        _sidPaths: {},
        _missedAppPaths: {},
        _apprPaths: {},
        _runwayThresholds: {},
      },
    });

    const { container } = renderAirMap();

    await waitFor(() => {
      const polylines = container.querySelectorAll('.air-map-svg polyline');
      expect(polylines.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders only active-runway variants for v4 files', async () => {
    setupDefaultMocks({
      'collect-values': {
        _starPaths: {
          'UBSS6W': [
            { runway: '19', points: [{ x: 0, z: 0 }, { x: 50, z: -100 }, { x: 100, z: -200 }] },
            { runway: '01', points: [{ x: 0, z: 0 }, { x: -50, z: 100 }, { x: -100, z: 200 }] },
          ],
        },
        _sidPaths: {},
        _missedAppPaths: {},
        _apprPaths: {},
        _runwayThresholds: {},
        _runwayList: ['19'],
        _isV4: true,
      },
    });

    const { container } = renderAirMap();

    await waitFor(() => {
      const polylines = container.querySelectorAll('.air-map-svg polyline');
      // Only runway 19 variant should render (1 line), not runway 01 variant
      expect(polylines.length).toBe(1);
    });
  });

  // ── Range rings ─────────────────────────────────────────────

  it('renders range rings when runway thresholds exist', async () => {
    setupDefaultMocks({
      'collect-values': {
        _starPaths: {},
        _sidPaths: {},
        _missedAppPaths: {},
        _apprPaths: {},
        _runwayThresholds: {
          '01/19': { a: { x: -100, z: -500 }, b: { x: 100, z: 500 } },
        },
      },
    });

    const { container } = renderAirMap();

    await waitFor(() => {
      // Range rings are circles with r based on NM_TO_GU
      const circles = container.querySelectorAll('.air-map-svg circle');
      expect(circles.length).toBeGreaterThan(0);
    });
  });

  // ── Runway threshold lines ──────────────────────────────────

  it('renders runway threshold lines', async () => {
    setupDefaultMocks({
      'collect-values': {
        _starPaths: {},
        _sidPaths: {},
        _missedAppPaths: {},
        _apprPaths: {},
        _runwayThresholds: {
          '01/19': { a: { x: -100, z: -500 }, b: { x: 100, z: 500 } },
        },
      },
    });

    const { container } = renderAirMap();

    await waitFor(() => {
      // Runway thresholds are line elements
      const lines = container.querySelectorAll('.air-map-svg line');
      // There are range ring circles too, but lines should include threshold lines
      expect(lines.length).toBeGreaterThan(0);
    });
  });

  // ── Refresh double-click → emergency callsign ───────────────

  it('sets emergency call sign on double-click refresh', async () => {
    const resetSpy = vi.fn();
    window.electronAPI.resetUdpAircraft = resetSpy;

    setupDefaultMocks();
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        {
          callSign: 'CES1234', position: { x: 100, y: 500, z: 200 },
          noseDirection: { x: 1, z: 0 },
          trail: [{ x: 100, z: 200, age: 0 }],
          flightDirection: 1, airSpeedKnot: 240, aircraftType: 'B738',
        },
      ],
      currentAirport: 'ZSJN',
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-svg')).toBeTruthy();
    });

    const toggles = container.querySelectorAll('.air-map-toggle');
    const refreshToggle = toggles[toggles.length - 1];

    // Double click the refresh button
    fireEvent.click(refreshToggle);
    fireEvent.click(refreshToggle);

    expect(resetSpy).toHaveBeenCalled();
  });

  // ── Airspace SpinKnob rendered ─────────────────────────────

  it('renders the AIRSPACE SpinKnob', async () => {
    setupDefaultMocks();
    const { container } = renderAirMap();

    await waitFor(() => {
      expect(container.querySelector('.air-map-svg')).toBeTruthy();
    });

    // AirMapWindow passes airspaceKnob prop to ControlSidebar
    // It's a SpinKnob — rendered within the sidebar
    const knobs = container.querySelectorAll('.spin-knob');
    expect(knobs.length).toBe(4); // zoom + panH + panV + airspace
  });
});
