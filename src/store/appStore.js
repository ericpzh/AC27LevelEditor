import { create } from 'zustand';
import { getAirlineCode } from '../utils/constants';

let nextFlightNumber = 1;

export function initFlightNumberCounter(flights) {
  let maxNum = 0;
  for (const fl of flights) {
    const match = (fl.CallSign || '').match(/(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    }
  }
  nextFlightNumber = maxNum + 1;
}

export const useAppStore = create((set, get) => ({
  // ─── Screen ───
  screen: 'setup',
  rootPath: null,
  airports: [],
  airportValues: {},

  // ─── Editor ───
  currentPath: null,
  currentAirport: null,
  flights: [],
  before: '', after: '', arrayContent: '', originalBlocks: [],
  modified: false,
  highlightedIdx: -1,
  selectedIndices: new Set(),
  highlightedCells: new Set(),
  editingWidget: null,

  // ─── Audio callsigns ───
  audioCallsigns: { byAirline: {}, allCallsigns: [], allAirlines: [] },

  // ─── Timelines ───
  weatherTimeline: [], weatherPath: null,
  windTimeline: [], windPath: null,
  runwayTimeline: { initialRunways: [], timeline: [] }, runwayTimelinePath: null,
  timelineModified: { weather: false, wind: false, runway: false },

  // ─── Config ───
  _configStartTime: null, _configEndTime: null,
  _runwayPairs: [],
  _earliestTime: null,

  // ─── Modal (declarative) ───
  modal: { open: false, title: '', body: null, actions: null },

  // ─── Toast ───
  toast: { message: '', type: '' },

  // ─── Actions: Legacy sync ───
  setLegacyState: (updates) => set(updates),

  // ─── Actions: Screen ───
  setScreen: (screen) => set({ screen }),
  setRootPath: (rootPath, airports) => set({ rootPath, airports }),

  // ─── Actions: Editor Data ───
  initializeEditor: (data) => set({
    currentPath: data.currentPath,
    currentAirport: data.airportIcao,
    flights: data.flights,
    before: data.before,
    after: data.after,
    arrayContent: data.arrayContent,
    originalBlocks: data.originalBlocks,
    modified: false,
    highlightedIdx: -1,
    selectedIndices: new Set(),
    highlightedCells: new Set(),
    editingWidget: null,
    _configStartTime: data.configStartTime,
    _configEndTime: data.configEndTime,
    _earliestTime: data.earliestTime,
  }),
  setAuxData: (values, audio, tl, rp) => set({
    airportValues: values,
    audioCallsigns: audio,
    weatherTimeline: tl.weatherTimeline || [],
    weatherPath: tl.weatherPath,
    windTimeline: tl.windTimeline || [],
    windPath: tl.windPath,
    runwayTimeline: tl.runwayTimeline || { initialRunways: [], timeline: [] },
    runwayTimelinePath: tl.runwayTimelinePath,
    _runwayPairs: rp || [],
  }),

  // ─── Actions: Flights ───
  addArrivalFlight: () => {
    const state = get();
    const values = state.airportValues[state.currentAirport] || {};
    const audioData = state.audioCallsigns;
    const newFlight = {};
    // Initialize empty fields
    for (const [fn] of []) newFlight[fn] = ''; // will be filled below

    let airlineCode = 'NEW';
    if (audioData.allAirlines && audioData.allAirlines.length > 0) airlineCode = audioData.allAirlines[0];
    else if (values.AirlineName && values.AirlineName.length > 0) airlineCode = getAirlineCode(values.AirlineName[0]);

    Object.assign(newFlight, {
      CallSign: airlineCode + String(nextFlightNumber++),
      ArrivalAirport: state.currentAirport || '',
      LandingTime: '06:00:00',
      InBlockTime: '06:05:00',
      Language: 'en',
      AircraftType: (values.AircraftType && values.AircraftType[0]) || '',
      AirlineName: (values.AirlineName && values.AirlineName[0]) || '',
      Stand: (values.Stand && values.Stand[0]) || '',
      Runway: (values.Runway && values.Runway[0]) || '',
    });

    const flights = [...state.flights, newFlight];
    set({ flights, modified: true, selectedIndices: new Set([flights.length - 1]) });
  },

  addDepartureFlight: () => {
    const state = get();
    const values = state.airportValues[state.currentAirport] || {};
    const audioData = state.audioCallsigns;

    let airlineCode = 'NEW';
    if (audioData.allAirlines && audioData.allAirlines.length > 0) airlineCode = audioData.allAirlines[0];
    else if (values.AirlineName && values.AirlineName.length > 0) airlineCode = getAirlineCode(values.AirlineName[0]);

    const newFlight = {
      CallSign: airlineCode + String(nextFlightNumber++),
      DepartureAirport: state.currentAirport || '',
      OffBlockTime: '06:00:00',
      TakeoffTime: '06:05:00',
      Language: 'en',
      AircraftType: (values.AircraftType && values.AircraftType[0]) || '',
      AirlineName: (values.AirlineName && values.AirlineName[0]) || '',
      Stand: (values.Stand && values.Stand[0]) || '',
      Runway: (values.Runway && values.Runway[0]) || '',
    };

    const flights = [...state.flights, newFlight];
    set({ flights, modified: true, selectedIndices: new Set([flights.length - 1]) });
  },

  copySelected: () => {
    const state = get();
    let indices = [...state.selectedIndices].sort((a, b) => a - b);
    if (indices.length === 0) {
      if (state.highlightedIdx < 0) return;
      indices = [state.highlightedIdx];
    }
    const copies = indices.map(i => ({ ...state.flights[i], _isNew: true }));
    const insertAt = indices[indices.length - 1] + 1;
    const flights = [...state.flights];
    flights.splice(insertAt, 0, ...copies);
    const newSet = new Set();
    for (let i = 0; i < copies.length; i++) newSet.add(insertAt + i);
    set({ flights, modified: true, highlightedIdx: -1, selectedIndices: newSet });
  },

  deleteSelected: () => {
    const state = get();
    if (state.selectedIndices.size === 0) return;
    const indices = [...state.selectedIndices].sort((a, b) => b - a);
    const flights = [...state.flights];
    for (const idx of indices) flights.splice(idx, 1);
    set({ flights, modified: true, selectedIndices: new Set(), highlightedIdx: -1 });
  },

  deleteAllFlights: () => {
    const state = get();
    if (state.flights.length === 0) return;
    set({ flights: [], modified: true, selectedIndices: new Set(), highlightedIdx: -1 });
  },

  updateFlight: (idx, updates) => {
    const flights = [...get().flights];
    flights[idx] = { ...flights[idx], ...updates };
    set({ flights, modified: true });
  },

  toggleSelection: (idx) => {
    const state = get();
    const next = new Set(state.selectedIndices);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    set({ selectedIndices: next });
  },

  setHighlightedIdx: (idx) => set({ highlightedIdx: idx }),

  // ─── Actions: Timeline ───
  setTimelineModified: (key, val) => set(state => ({
    timelineModified: { ...state.timelineModified, [key]: val },
  })),

  // ─── Actions: Modal ───
  showModal: (title, body, actions) => set({
    modal: { open: true, title, body, actions },
  }),
  hideModal: () => set({
    modal: { open: false, title: '', body: null, actions: null },
  }),

  // ─── Actions: Toast ───
  showToast: (message, type) => {
    set({ toast: { message, type } });
    clearTimeout(get()._toastTimer);
    const timer = setTimeout(() => set({ toast: { message: '', type: '' } }), 2500);
    set({ _toastTimer: timer });
  },
}));
