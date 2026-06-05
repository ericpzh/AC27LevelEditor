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
  searchMatches: new Set(),
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
  _saveSec: null,

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
    searchMatches: new Set(),
    highlightedCells: new Set(),
    editingWidget: null,
    _configStartTime: data.configStartTime,
    _configEndTime: data.configEndTime,
    _earliestTime: data.earliestTime,
    _saveSec: data._saveSec,
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

    // ── compute default times from config end ──
    let baseMin = 360; // fallback 06:00
    if (state._configEndTime) {
      const p = String(state._configEndTime).split(':');
      baseMin = parseInt(p[0]) * 60 + parseInt(p[1]) - 10;
      if (baseMin < 0) baseMin = 0;
    }
    const pad = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':00';

    let airlineCode = 'NEW';
    if (audioData.allAirlines && audioData.allAirlines.length > 0) airlineCode = audioData.allAirlines[0];
    else if (values.AirlineName && values.AirlineName.length > 0) airlineCode = getAirlineCode(values.AirlineName[0]);

    const newFlight = {
      // Initialize all possible fields so getActiveColumns sees them
      CallSign: '', DepartureAirport: '', ArrivalAirport: '',
      Stand: '', Runway: '',
      OffBlockTime: '', TakeoffTime: '', LandingTime: '', InBlockTime: '',
      AirlineName: '', AircraftType: '', Airway: '',
      Registration: '', Voice: '', Language: '',
      // ── arrival-specific defaults ──
      CallSign: airlineCode + String(nextFlightNumber++),
      ArrivalAirport: state.currentAirport || '',
      LandingTime: pad(baseMin),
      InBlockTime: pad(baseMin + 5),
      Language: 'en',
      AircraftType: (values.AircraftType && values.AircraftType[0]) || '',
      AirlineName: (values.AirlineName && values.AirlineName[0]) || '',
      Stand: (values.Stand && values.Stand[0]) || '',
      Runway: (values.Runway && values.Runway[0]) || '',
      Airway: (values.Airway && values.Airway[0]) || '',
      Registration: (values.Registration && values.Registration[0]) || '',
      Voice: (values.Voice && values.Voice[0]) || '',
    };

    const flights = [...state.flights, newFlight];
    set({ flights, modified: true, selectedIndices: new Set([flights.length - 1]) });
  },

  addDepartureFlight: () => {
    const state = get();
    const values = state.airportValues[state.currentAirport] || {};
    const audioData = state.audioCallsigns;

    // ── compute default times from config end ──
    let baseMin = 360; // fallback 06:00
    if (state._configEndTime) {
      const p = String(state._configEndTime).split(':');
      baseMin = parseInt(p[0]) * 60 + parseInt(p[1]) - 10;
      if (baseMin < 0) baseMin = 0;
    }
    const pad = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':00';

    let airlineCode = 'NEW';
    if (audioData.allAirlines && audioData.allAirlines.length > 0) airlineCode = audioData.allAirlines[0];
    else if (values.AirlineName && values.AirlineName.length > 0) airlineCode = getAirlineCode(values.AirlineName[0]);

    const newFlight = {
      // Initialize all possible fields so getActiveColumns sees them
      CallSign: '', DepartureAirport: '', ArrivalAirport: '',
      Stand: '', Runway: '',
      OffBlockTime: '', TakeoffTime: '', LandingTime: '', InBlockTime: '',
      AirlineName: '', AircraftType: '', Airway: '',
      Registration: '', Voice: '', Language: '',
      // ── departure-specific defaults ──
      CallSign: airlineCode + String(nextFlightNumber++),
      DepartureAirport: state.currentAirport || '',
      OffBlockTime: pad(baseMin),
      TakeoffTime: pad(baseMin + 5),
      Language: 'en',
      AircraftType: (values.AircraftType && values.AircraftType[0]) || '',
      AirlineName: (values.AirlineName && values.AirlineName[0]) || '',
      Stand: (values.Stand && values.Stand[0]) || '',
      Runway: (values.Runway && values.Runway[0]) || '',
      Airway: (values.Airway && values.Airway[0]) || '',
      Registration: (values.Registration && values.Registration[0]) || '',
      Voice: (values.Voice && values.Voice[0]) || '',
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

  toggleSelectAll: () => {
    const state = get();
    if (state.flights.length === 0) return;
    const allSelected = state.selectedIndices.size === state.flights.length;
    if (allSelected) {
      set({ selectedIndices: new Set(), highlightedIdx: -1 });
    } else {
      set({ selectedIndices: new Set(state.flights.map((_, i) => i)), highlightedIdx: -1 });
    }
  },

  updateFlight: (idx, updates) => {
    const flights = [...get().flights];
    const flight = { ...flights[idx], ...updates };
    // Rebuild CallSign when FlightNum or AirlineCode changes
    if ('FlightNum' in updates || 'AirlineCode' in updates) {
      const old = flights[idx];
      const code = flight.AirlineCode || (old.CallSign || '').substring(0, 3);
      let num;
      if ('FlightNum' in updates) {
        // User explicitly picked a flight number — use their choice
        num = flight.FlightNum;
      } else {
        // AirlineCode changed — auto-pick first valid number for new airline
        const audioData = get().audioCallsigns;
        const validNums = audioData?.byAirline?.[code];
        num = (validNums && validNums.length > 0) ? validNums[0] : (old.CallSign || '').substring(3);
      }
      flight.CallSign = code + num;
    }
    flights[idx] = flight;
    set({ flights, modified: true });
  },

  toggleSelection: (idx) => {
    const state = get();
    const next = new Set(state.selectedIndices);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    set({ selectedIndices: next });
  },

  setHighlightedIdx: (idx) => set({ highlightedIdx: idx }),
  setSearchMatches: (indices) => set({ searchMatches: new Set(indices) }),

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
