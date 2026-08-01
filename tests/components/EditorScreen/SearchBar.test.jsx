import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import SearchBar from '../../../src/components/EditorScreen/SearchBar';
import { useAppStore } from '../../../src/store/appStore';
import { I18nProvider } from '../../../src/hooks/useTranslation';

// Use the real store — inject state directly
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

function setupStore(flights) {
  useAppStore.getState().initializeEditor({
    currentPath: '/test/file.acl',
    airportIcao: 'KJFK',
    flights,
    before: '', after: '', arrayContent: '', originalBlocks: [],
    configStartTime: '06:00', configEndTime: '18:00',
    _saveSec: 36000,
  });
}

function renderBar() {
  return render(
    <I18nProvider>
      <SearchBar />
    </I18nProvider>
  );
}

function type(term) {
  fireEvent.change(document.querySelector('#search-input'), { target: { value: term } });
}

// Repro for the save-error jump bug: clicking the "VIR3" link in the issues
// modal searched "VIR3" and highlighted VIR3046 (arrival, substring match)
// instead of the clicked flight VIR3 (departure, exact match).
describe('SearchBar — match ranking', () => {
  it('prioritizes exact callsign over substring match', () => {
    setupStore([
      { CallSign: 'VIR3046', ArrivalAirport: 'KJFK', LandingTime: '10:00:00', InBlockTime: '10:05:00' },
      { CallSign: 'VIR3', ArrivalAirport: 'KJFK', OffBlockTime: '11:00:00' },
    ]);
    renderBar();
    type('VIR3');

    const st = useAppStore.getState();
    expect(st.highlightedIdx).toBe(1);          // VIR3, not VIR3046
    expect([...st.searchMatches]).toEqual([1, 0]);
  });

  it('exact match outranks prefix and substring matches', () => {
    setupStore([
      { CallSign: 'BAW5601', ArrivalAirport: 'KJFK', LandingTime: '10:00:00', FlightNum: '5601' },
      { CallSign: 'BAW56', ArrivalAirport: 'KJFK', LandingTime: '11:00:00', FlightNum: '56' },
      { CallSign: 'BAW056', ArrivalAirport: 'KJFK', LandingTime: '12:00:00', FlightNum: '056' },
    ]);
    renderBar();
    type('56');

    const st = useAppStore.getState();
    expect(st.highlightedIdx).toBe(1);          // FlightNum "56" exact
    expect([...st.searchMatches]).toEqual([1, 0, 2]); // exact, prefix("5601"), substring("056")
  });

  it('no matches leaves search cleared and no highlight', () => {
    setupStore([
      { CallSign: 'VIR3046', ArrivalAirport: 'KJFK', LandingTime: '10:00:00' },
    ]);
    renderBar();
    type('ZZZ999');

    const st = useAppStore.getState();
    expect(st.highlightedIdx).toBe(-1);
    expect(st.searchMatches.size).toBe(0);
  });
});
