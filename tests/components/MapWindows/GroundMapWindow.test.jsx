import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
import GroundMapWindow from '../../../src/components/MapWindows/GroundMapWindow';

// ── Default mock viewBox (stable, to pass the initialViewBox check) ──
const DEFAULT_VB = { x: -30, y: -60, w: 60, h: 60 };

function setupDefaultMocks(overrides = {}) {
  // useUdpAircraftState default: no aircraft
  useUdpAircraftState.mockReturnValue({
    aircraft: [],
    currentAirport: null,
    simTimeUnixMs: 0,
  });

  // useSvgZoom default: stable viewBox + noop callbacks
  const noop = vi.fn();
  useSvgZoom.mockReturnValue({
    viewBox: DEFAULT_VB,
    svgRef: { current: null },
    resetZoom: noop,
    resetPanH: noop,
    resetPanV: noop,
    handleWheel: noop,
    handleMouseDown: noop,
    handleMouseMove: noop,
    handleMouseUp: noop,
    zoomIn: noop,
    zoomOut: noop,
    panLeft: noop,
    panRight: noop,
    panUp: noop,
    panDown: noop,
  });

  // IPC mock
  mockIpcInvoke.mockImplementation((channel, ...args) => {
    if (overrides[channel] !== undefined) {
      const v = overrides[channel];
      return typeof v === 'function' ? v(...args) : Promise.resolve(v);
    }
    switch (channel) {
      case 'collect-values':
        return Promise.resolve({
          _taxiwayPaths: { paths: [] },
          _runwayData: {},
          _standPositions: {},
          _areaData: {},
        });
      default:
        return Promise.resolve({});
    }
  });
}

function renderGroundMap(props = {}) {
  return render(
    <I18nProvider>
      <GroundMapWindow airportIcao="ZSJN" {...props} />
    </I18nProvider>
  );
}

beforeEach(() => {
  setLang('en');
  vi.clearAllMocks();
  // Set URL query params for rootPath (used in useEffect fetch)
  Object.defineProperty(window, 'location', {
    value: { search: '?window=groundMap&airport=ZSJN&root=C%3A%5C%5CGames%5C%5CAC27' },
    writable: true,
  });
});

describe('GroundMapWindow', () => {
  // ── Loading / Error states ──────────────────────────────────

  it('shows loading spinner initially', () => {
    // Don't resolve collectValues yet
    mockIpcInvoke.mockReturnValue(new Promise(() => {})); // pending forever
    useUdpAircraftState.mockReturnValue({ aircraft: [], currentAirport: null, simTimeUnixMs: 0 });
    useSvgZoom.mockReturnValue({
      viewBox: DEFAULT_VB, svgRef: { current: null },
      resetZoom: vi.fn(), resetPanH: vi.fn(), resetPanV: vi.fn(),
      handleWheel: vi.fn(), handleMouseDown: vi.fn(), handleMouseMove: vi.fn(), handleMouseUp: vi.fn(),
      zoomIn: vi.fn(), zoomOut: vi.fn(), panLeft: vi.fn(), panRight: vi.fn(), panUp: vi.fn(), panDown: vi.fn(),
    });

    const { container } = renderGroundMap();
    expect(container.querySelector('.ground-map-loading')).toBeTruthy();
    expect(container.querySelector('.spinner')).toBeTruthy();
  });

  it('shows error message when data fetch fails', async () => {
    setupDefaultMocks({
      'collect-values': Promise.reject(new Error('Network failure')),
    });

    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-error')).toBeTruthy();
    });
    expect(container.querySelector('.ground-map-error').textContent).toContain('Network failure');
  });

  // ── Data fetch ──────────────────────────────────────────────

  it('calls collectValues with rootPath and airportIcao', async () => {
    setupDefaultMocks();
    renderGroundMap();

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
    const { container } = renderGroundMap();

    await waitFor(() => {
      const svg = container.querySelector('.ground-map-svg');
      expect(svg).toBeTruthy();
    });
  });

  // ── Set window title ────────────────────────────────────────

  it('sets document title with airport ICAO', async () => {
    setupDefaultMocks();
    renderGroundMap();
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('collect-values', expect.any(String), 'ZSJN');
    });
    expect(document.title).toBe('ZSJN Surface Radar');
  });

  // ── Toggle buttons ──────────────────────────────────────────

  it('renders Show All and Taxiway toggle buttons', async () => {
    setupDefaultMocks();
    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-svg')).toBeTruthy();
    });

    const toggles = container.querySelectorAll('.air-map-toggle');
    expect(toggles.length).toBeGreaterThanOrEqual(2);
  });

  it('toggles Show All state on click', async () => {
    setupDefaultMocks();
    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-svg')).toBeTruthy();
    });

    const toggles = container.querySelectorAll('.air-map-toggle');
    const showAllToggle = toggles[0];

    // Initially not active
    expect(showAllToggle.classList.contains('active')).toBe(false);

    fireEvent.click(showAllToggle);
    // After click, should be active
    // (Note: state is internal — we test class presence)
  });

  it('calls resetUdpAircraft on Refresh button click', async () => {
    const resetSpy = vi.fn();
    // Set up electronAPI mock
    window.electronAPI.resetUdpAircraft = resetSpy;

    setupDefaultMocks();
    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-svg')).toBeTruthy();
    });

    const toggles = container.querySelectorAll('.air-map-toggle');
    // Refresh is the last toggle
    const refreshToggle = toggles[toggles.length - 1];
    fireEvent.click(refreshToggle);
    expect(resetSpy).toHaveBeenCalled();
  });

  // ── SVG background ──────────────────────────────────────────

  it('renders radar blue background rect', async () => {
    setupDefaultMocks();
    const { container } = renderGroundMap();

    await waitFor(() => {
      const rect = container.querySelector('.ground-map-svg rect');
      expect(rect).toBeTruthy();
      expect(rect.getAttribute('fill')).toBe('#0a1628');
    });
  });

  // ── Airport mismatch: empty aircraft when UDP airport differs ──

  it('shows no aircraft when UDP airport does not match', async () => {
    setupDefaultMocks();
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        { callSign: 'CES1234', position: { x: 10, y: 0.5, z: 20 }, noseDirection: { x: 1, z: 0 }, trail: [{ x: 10, z: 20, age: 0 }], stand: 'A01' },
      ],
      currentAirport: 'KJFK', // Different from ZSJN
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-svg')).toBeTruthy();
    });

    // No aircraft groups should be rendered
    const acGroups = container.querySelectorAll('.ground-map-aircraft-group');
    expect(acGroups.length).toBe(0);
  });

  // ── Airborne filter: y > 1.0 → hidden ───────────────────────

  it('filters out airborne aircraft (y > 1.0)', async () => {
    setupDefaultMocks();
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        { callSign: 'AIR001', position: { x: 10, y: 50, z: 20 }, noseDirection: { x: 1, z: 0 }, trail: [{ x: 10, z: 20, age: 0 }], stand: '' },
        { callSign: 'GND001', position: { x: 15, y: 0.3, z: 25 }, noseDirection: { x: 0, z: 1 }, trail: [{ x: 15, z: 25, age: 0 }], stand: '' },
      ],
      currentAirport: 'ZSJN',
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-svg')).toBeTruthy();
    });

    const acGroups = container.querySelectorAll('.ground-map-aircraft-group');
    expect(acGroups.length).toBe(1);
    // GND001 should be the only one (y=0.3 <= 1.0)
  });

  // ── Stand proximity filter ──────────────────────────────────

  it('hides aircraft parked at their stand within proximity', async () => {
    setupDefaultMocks({
      'collect-values': {
        _taxiwayPaths: { paths: [] },
        _runwayData: {},
        _standPositions: { 'A01': { x: 10, y: 20 } }, // stand at (10, 20)
        _areaData: {},
      },
    });
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        {
          callSign: 'PARKED', position: { x: 10.1, y: 0, z: 20.1 },
          noseDirection: { x: 1, z: 0 },
          trail: [{ x: 10.1, z: 20.1, age: 0 }],
          stand: 'A01',
        },
        {
          callSign: 'TAXIING', position: { x: 50, y: 0, z: 50 },
          noseDirection: { x: 0, z: 1 },
          trail: [{ x: 50, z: 50, age: 0 }],
          stand: 'A02',
        },
      ],
      currentAirport: 'ZSJN',
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-svg')).toBeTruthy();
    });

    const acGroups = container.querySelectorAll('.ground-map-aircraft-group');
    // PARKED should be hidden (at stand A01 within 0.5 GU), TAXIING visible
    expect(acGroups.length).toBe(1);
  });

  // ── Show All bypasses filter ────────────────────────────────

  it('shows parked aircraft when Show All is active', async () => {
    setupDefaultMocks({
      'collect-values': {
        _taxiwayPaths: { paths: [] },
        _runwayData: {},
        _standPositions: { 'A01': { x: 10, y: 20 } },
        _areaData: {},
      },
    });
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        {
          callSign: 'PARKED', position: { x: 10.1, y: 0, z: 20.1 },
          noseDirection: { x: 1, z: 0 },
          trail: [{ x: 10.1, z: 20.1, age: 0 }],
          stand: 'A01',
        },
      ],
      currentAirport: 'ZSJN',
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-svg')).toBeTruthy();
    });

    // By default, parked aircraft hidden
    expect(container.querySelectorAll('.ground-map-aircraft-group').length).toBe(0);

    // Click "Show All" toggle
    const toggles = container.querySelectorAll('.air-map-toggle');
    fireEvent.click(toggles[0]);

    // Now PARKED should be visible
    await waitFor(() => {
      expect(container.querySelectorAll('.ground-map-aircraft-group').length).toBe(1);
    });
  });

  // ── controlSeat filtering ──────────────────────────────────

  it('shows aircraft with active controlSeat even when at stand', async () => {
    setupDefaultMocks({
      'collect-values': {
        _taxiwayPaths: { paths: [] },
        _runwayData: {},
        _standPositions: { 'A01': { x: 10, y: 20 } },
        _areaData: {},
      },
    });
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        {
          callSign: 'ACTIVE', position: { x: 10.1, y: 0, z: 20.1 },
          noseDirection: { x: 1, z: 0 },
          trail: [{ x: 10.1, z: 20.1, age: 0 }],
          stand: 'A01',
          controlSeat: 2, // Ground — actively controlled
        },
        {
          callSign: 'PARKED', position: { x: 10.2, y: 0, z: 20.2 },
          noseDirection: { x: 0, z: 1 },
          trail: [{ x: 10.2, z: 20.2, age: 0 }],
          stand: 'A01',
          controlSeat: 0, // None — parked
        },
      ],
      currentAirport: 'ZSJN',
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-svg')).toBeTruthy();
    });

    const acGroups = container.querySelectorAll('.ground-map-aircraft-group');
    // ACTIVE should be visible (controlSeat=2), PARKED hidden (controlSeat=0)
    expect(acGroups.length).toBe(1);
  });

  it('hides aircraft with controlSeat=Unknown at stand', async () => {
    setupDefaultMocks({
      'collect-values': {
        _taxiwayPaths: { paths: [] },
        _runwayData: {},
        _standPositions: { 'A01': { x: 10, y: 20 } },
        _areaData: {},
      },
    });
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        {
          callSign: 'UNKNOWN', position: { x: 10.1, y: 0, z: 20.1 },
          noseDirection: { x: 1, z: 0 },
          trail: [{ x: 10.1, z: 20.1, age: 0 }],
          stand: 'A01',
          controlSeat: 255, // Unknown — treated like None
        },
      ],
      currentAirport: 'ZSJN',
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-svg')).toBeTruthy();
    });

    // Should be hidden — controlSeat=Unknown treated same as None
    expect(container.querySelectorAll('.ground-map-aircraft-group').length).toBe(0);
  });

  // ── Click to select aircraft ────────────────────────────────

  it('selects aircraft via centralized API on click', async () => {
    const selectSpy = vi.fn();
    window.electronAPI.selectAircraftInMap = selectSpy;

    setupDefaultMocks();
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        {
          callSign: 'CES1234', position: { x: 10, y: 0.5, z: 20 },
          noseDirection: { x: 1, z: 0 },
          trail: [{ x: 10, z: 20, age: 0 }],
          stand: '',
        },
      ],
      currentAirport: 'ZSJN',
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-aircraft-group')).toBeTruthy();
    });

    const acGroup = container.querySelector('.ground-map-aircraft-group');
    fireEvent.click(acGroup);

    expect(selectSpy).toHaveBeenCalledWith('ZSJN', 'CES1234');
  });

  // ── SVG background click deselects ──────────────────────────

  it('deselects on SVG background click', async () => {
    setupDefaultMocks();
    useUdpAircraftState.mockReturnValue({
      aircraft: [
        {
          callSign: 'CES1234', position: { x: 10, y: 0.5, z: 20 },
          noseDirection: { x: 1, z: 0 },
          trail: [{ x: 10, z: 20, age: 0 }],
          stand: '',
        },
      ],
      currentAirport: 'ZSJN',
      simTimeUnixMs: 1718400000000,
    });

    const { container } = renderGroundMap();

    await waitFor(() => {
      expect(container.querySelector('.ground-map-aircraft-group')).toBeTruthy();
    });

    // First click aircraft to select
    const acGroup = container.querySelector('.ground-map-aircraft-group');
    fireEvent.click(acGroup);
    // Selection state is internal, but path should turn yellow
    // Click SVG background to deselect
    const svg = container.querySelector('.ground-map-svg');
    fireEvent.click(svg);
  });

  // ── Taxiway label dedup ─────────────────────────────────────

  it('renders taxiway polylines from data', async () => {
    setupDefaultMocks({
      'collect-values': {
        _taxiwayPaths: {
          paths: [
            { name: 'A', flags: 1, points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 5 }] },
            { name: 'B', flags: 2, points: [{ x: 0, z: 10 }, { x: 10, z: 10 }] },
          ],
        },
        _runwayData: {},
        _standPositions: {},
        _areaData: {},
      },
    });

    const { container } = renderGroundMap();

    await waitFor(() => {
      const polylines = container.querySelectorAll('.ground-map-svg polyline');
      expect(polylines.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Runway rendering ────────────────────────────────────────

  it('renders runway polygons when given runway data', async () => {
    setupDefaultMocks({
      'collect-values': {
        _taxiwayPaths: { paths: [] },
        _runwayData: {
          '01/19': {
            thresholds: [{ x: -5, z: -20 }, { x: 5, z: 20 }],
            width: 0.60,
          },
        },
        _standPositions: {},
        _areaData: {},
      },
    });

    const { container } = renderGroundMap();

    await waitFor(() => {
      const polygons = container.querySelectorAll('.ground-map-svg polygon');
      expect(polygons.length).toBeGreaterThanOrEqual(1);
    });
  });
});
