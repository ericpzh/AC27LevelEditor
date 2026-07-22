import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import FlightTable from '../../../../src/components/EditorScreen/FlightTable/FlightTable';
import { useAppStore } from '../../../../src/store/appStore';
import { I18nProvider } from '../../../../src/hooks/useTranslation';
import { ARRIVAL_FIELDS, getActiveColumns } from '../../../../src/utils/constants';

// Use the real store — inject state directly
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

const TEST_FLIGHTS = [
  { CallSign: 'CES1234', ArrivalAirport: 'KJFK', LandingTime: '08:00', AircraftType: 'B738', Stand: 'G1' },
  { CallSign: 'CES5678', ArrivalAirport: 'KJFK', LandingTime: '09:00', AircraftType: 'A320', Stand: 'G2' },
  { CallSign: 'CES9012', ArrivalAirport: 'KJFK', LandingTime: '10:00', AircraftType: 'B77W', Stand: 'G3' },
];

function setupStore(flights = TEST_FLIGHTS) {
  useAppStore.getState().initializeEditor({
    currentPath: '/test/file.acl',
    airportIcao: 'KJFK',
    flights,
    before: '', after: '', arrayContent: '', originalBlocks: [],
    configStartTime: '06:00', configEndTime: '18:00',
    _saveSec: 36000,
  });
  useAppStore.getState().setAuxData(
    { KJFK: { AircraftType: ['B738', 'A320', 'B77W'], Stand: ['G1', 'G2', 'G3'] } },
    { byAirline: { CES: ['1234', '5678', '9012'] }, allCallsigns: [], allAirlines: ['CES'] },
    { weatherTimeline: [], windTimeline: [], runwayTimeline: { initialRunways: [], timeline: [] } },
    [],
  );
}

function renderTable(props = {}) {
  const flights = props.flights || TEST_FLIGHTS;
  const columns = getActiveColumns(flights, ARRIVAL_FIELDS);
  return render(
    <I18nProvider>
      <FlightTable type="arrivals" flights={flights} columns={columns} {...props} />
    </I18nProvider>
  );
}

/** Get a specific data cell by column name and global index */
function getCell(col, gi) {
  return document.querySelector(`td[data-col="${col}"][data-idx="${gi}"]`);
}

describe('FlightTable — row selection via click vs drag', () => {
  it('clicking a data cell does NOT toggle selection', () => {
    setupStore();
    renderTable();

    const cell = getCell('AirlineCode', 0);
    expect(cell).not.toBeNull();
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    // Selection should still be empty — single click on data cell does not toggle
    expect(useAppStore.getState().selectedIndices.size).toBe(0);
  });

  it('clicking the checkbox toggles selection', () => {
    setupStore();
    renderTable();

    const checkbox = document.querySelector('input.chk-row[data-idx="0"]');
    expect(checkbox).not.toBeNull();

    // Click the checkbox td area (not the input itself, which has its own onChange)
    const chkCell = checkbox.closest('td');
    act(() => {
      chkCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    expect(useAppStore.getState().selectedIndices.has(0)).toBe(true);
  });

  it('dragging from a data cell across rows range-selects all rows including the start row', () => {
    setupStore();
    renderTable();

    // Mousedown on first row's AirlineCode cell (data cell → pending mode)
    const cell0 = getCell('AirlineCode', 0);
    expect(cell0).not.toBeNull();
    act(() => {
      cell0.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // Drag to row 1 — fire mouseover on the <tr> (mouseover bubbles; React uses it for onMouseEnter)
    act(() => {
      const row1 = document.querySelector('input.chk-row[data-idx="1"]').closest('tr');
      row1.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    // Drag to row 2
    act(() => {
      const row2 = document.querySelector('input.chk-row[data-idx="2"]').closest('tr');
      row2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    // Release
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const sel = useAppStore.getState().selectedIndices;
    expect(sel.has(0)).toBe(true);
    expect(sel.has(1)).toBe(true);
    expect(sel.has(2)).toBe(true);
    expect(sel.size).toBe(3);
  });

  it('clicking on a dropdown cell (AircraftType) does NOT toggle selection', () => {
    setupStore();
    renderTable();

    const cell = getCell('AircraftType', 0);
    expect(cell).not.toBeNull();
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    expect(useAppStore.getState().selectedIndices.size).toBe(0);
  });

  it('clicking on a time cell (LandingTime) does NOT toggle selection', () => {
    setupStore();
    renderTable();

    const cell = getCell('LandingTime', 0);
    expect(cell).not.toBeNull();
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    expect(useAppStore.getState().selectedIndices.size).toBe(0);
  });

  it('clicking on the clock portal overlay does NOT toggle selection', () => {
    setupStore();
    renderTable();

    // Open the clock by clicking on a time cell
    const timeCell = getCell('LandingTime', 0);
    expect(timeCell).not.toBeNull();
    timeCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    act(() => {
      timeCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The clock popover should now be rendered via portal to document.body
    const overlay = document.querySelector('.time-clock-overlay');
    expect(overlay).not.toBeNull();

    // Click on the clock overlay — React portals bubble events through the
    // React tree to the <tr>, but our guard should catch it and return early.
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    // Selection should still be empty
    expect(useAppStore.getState().selectedIndices.size).toBe(0);
  });
});
