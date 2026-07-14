import { create } from 'zustand';
import { TOAST_DURATION_MS, TOAST_ERROR_DURATION_MS, STORAGE_KEY_THEME } from '../utils/constants';
import { createArrivalFlight, createDepartureFlight } from './flightDefaults.js';
import { rebuildCallSign, cascadeAirlineChange, cascadeRunwayChange, clearInternalRegistration } from './flightCascade.js';

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

  // ─── Map visibility (global so maps survive cell-edit lifecycle) ───
  showStandMap: false,
  showStarMap: false,
  mapFlightIdx: -1,   // which flight row the map currently shows
  activeMap: null,     // 'stand' | 'star' | null — which map overlay is on top

  // ─── Audio callsigns ───
  audioCallsigns: { byAirline: {}, allCallsigns: [], allAirlines: [] },

  // ─── Timelines ───
  weatherTimeline: [], weatherPath: null,
  windTimeline: [], windPath: null,
  runwayTimeline: { initialRunways: [], timeline: [] }, runwayTimelinePath: null,
  timelineModified: { weather: false, wind: false, runway: false },

  // ─── Config ───
  _configStartTime: null, _configEndTime: null,
  _windSpeedUnit: 'knots',
  _runwayPairs: [],
  _earliestTime: null,
  _saveSec: null,
  _currentDateTime: null,
  isDemo: false,

  // ─── Radar window tracking (ICAO codes of open windows) ───
  openGroundRadarAirports: new Set(),
  openAirRadarAirports: new Set(),
  openFlightStripAirports: new Set(),

  // ─── UDP health ───
  udpConnected: false,
  udpCurrentAirport: null,

  // ─── Modal (declarative) ───
  modal: { open: false, title: '', body: null, actions: null, closeable: true, headerRight: null, showLangToggle: false },
  cacheBuildProgress: null, // { current: number, total: number }

  // ─── Theme ───
  theme: (() => {
    try { return localStorage.getItem(STORAGE_KEY_THEME) || 'dark'; }
    catch (_) { return 'dark'; }
  })(),

  // ─── Toast ───
  toast: { message: '', type: '' },

  // ─── Chat (Cloud LLM) ───
  chatPanelOpen: false,
  chatMessages: [],
  chatSending: false,
  chatSetupStep: 'vendors',     // 'vendors' | 'ready'
  chatError: null,
  chatConfig: { deepseekKey: '', geminiKey: '', claudeKey: '', codexKey: '', selectedModel: '' },
  chatConfigPath: '',
  chatAvailableModels: [],
  chatTotalRamGB: 0,

  // ─── Actions: Legacy sync ───
  setLegacyState: (updates) => set(updates),

  // ─── Actions: Screen ───
  setScreen: (screen) => set({ screen, ...(screen !== 'editor' ? { showStandMap: false, showStarMap: false, activeMap: null } : {}) }),
  setRootPath: (rootPath, airports) => set({ rootPath, airports }),

  // ─── Actions: Editor Data ───
  initializeEditor: (data) => set({
    chatPanelOpen: false,
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
    _currentDateTime: data._currentDateTime || null,
    isDemo: data.isDemo || false,
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
    const airportValuesForNum = state.airportValues[state.currentAirport] || {};

    const newFlight = createArrivalFlight(state._configEndTime, values, audioData, state.currentAirport, airportValuesForNum, state.flights);

    const flights = [...state.flights, newFlight];
    set({ flights, modified: true, selectedIndices: new Set([flights.length - 1]) });
  },

  addDepartureFlight: () => {
    const state = get();
    const values = state.airportValues[state.currentAirport] || {};
    const audioData = state.audioCallsigns;
    const airportValuesForNum = state.airportValues[state.currentAirport] || {};

    const newFlight = createDepartureFlight(state._configEndTime, values, audioData, state.currentAirport, airportValuesForNum, state.flights);

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

  // ─── Actions: Map visibility ───
  toggleStandMap: () => {
    const s = get();
    const next = !s.showStandMap;
    set({
      showStandMap: next,
      mapFlightIdx: next && s.mapFlightIdx < 0 ? s.highlightedIdx : s.mapFlightIdx,
      activeMap: next ? 'stand' : null,
    });
  },
  toggleStarMap: () => {
    const s = get();
    const next = !s.showStarMap;
    set({
      showStarMap: next,
      mapFlightIdx: next && s.mapFlightIdx < 0 ? s.highlightedIdx : s.mapFlightIdx,
      activeMap: next ? 'star' : null,
    });
  },
  openStandMap: (idx) => set({ showStandMap: true, mapFlightIdx: idx, activeMap: 'stand' }),
  openStarMap: (idx) => set({ showStarMap: true, mapFlightIdx: idx, activeMap: 'star' }),
  closeStandMap: () => set((state) => ({
    showStandMap: false,
    activeMap: state.activeMap === 'stand' ? null : state.activeMap,
  })),
  closeStarMap: () => set((state) => ({
    showStarMap: false,
    activeMap: state.activeMap === 'star' ? null : state.activeMap,
  })),
  setActiveMap: (map) => set({ activeMap: map }),

  updateFlight: (idx, updates) => {
    const state = get();
    const flights = [...state.flights];
    const oldFlight = flights[idx];
    const flight = { ...oldFlight, ...updates };
    const airportValues = state.airportValues[state.currentAirport] || {};

    // Cascade 1: Rebuild CallSign when FlightNum or AirlineCode changes
    if ('FlightNum' in updates || 'AirlineCode' in updates) {
      flight.CallSign = rebuildCallSign(oldFlight, updates, airportValues);

      // Cascade 2: AirlineCode change → aircraft type + registration
      if ('AirlineCode' in updates) {
        const acUpdates = cascadeAirlineChange(updates.AirlineCode, flight, airportValues);
        Object.assign(flight, acUpdates);
      }
    }

    // Cascade 3: Runway change → reset Airway to first valid STAR
    if ('Runway' in updates) {
      const rwyUpdates = cascadeRunwayChange(updates.Runway, flight, airportValues);
      Object.assign(flight, rwyUpdates);
    }

    // Cleanup: explicit Registration edit clears internal _Registration
    if ('Registration' in updates) {
      clearInternalRegistration(flight);
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
  setMapFlightIdx: (idx) => set({ mapFlightIdx: idx }),
  setSearchMatches: (indices) => set({ searchMatches: new Set(indices) }),

  // ─── Actions: Timeline ───
  setTimelineModified: (key, val) => set(state => ({
    timelineModified: { ...state.timelineModified, [key]: val },
  })),

  // ─── Actions: Modal ───
  showModal: (title, body, actions, closeable = true, headerRight = null, showLangToggle = false) => set({
    modal: { open: true, title, body, actions, closeable, headerRight, showLangToggle },
  }),
  hideModal: () => set({
    modal: { open: false, title: '', body: null, actions: null, closeable: true, headerRight: null, showLangToggle: false },
    cacheBuildProgress: null,
  }),
  setCacheBuildProgress: (progress) => set({ cacheBuildProgress: progress }),

  // ─── Actions: Radar windows ───
  setGroundRadarOpen: (icao, open) => set((s) => {
    const next = new Set(s.openGroundRadarAirports);
    if (open) next.add(icao); else next.delete(icao);
    return { openGroundRadarAirports: next };
  }),
  setAirRadarOpen: (icao, open) => set((s) => {
    const next = new Set(s.openAirRadarAirports);
    if (open) next.add(icao); else next.delete(icao);
    return { openAirRadarAirports: next };
  }),
  isGroundRadarOpen: (icao) => get().openGroundRadarAirports.has(icao),
  isAirRadarOpen: (icao) => get().openAirRadarAirports.has(icao),
  setFlightStripOpen: (icao, open) => set((s) => {
    const next = new Set(s.openFlightStripAirports);
    if (open) next.add(icao); else next.delete(icao);
    return { openFlightStripAirports: next };
  }),
  isFlightStripOpen: (icao) => get().openFlightStripAirports.has(icao),

  // ─── Actions: UDP ───
  setUdpStatus: (connected, currentAirport) => set({ udpConnected: connected, udpCurrentAirport: currentAirport }),

  // ─── Actions: Theme ───
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(STORAGE_KEY_THEME, next); } catch (_) {}
    set({ theme: next });
  },

  // ─── Actions: Toast ───
  showToast: (message, type) => {
    set({ toast: { message, type } });
    clearTimeout(get()._toastTimer);
    const dur = type === 'error' ? TOAST_ERROR_DURATION_MS : TOAST_DURATION_MS;
    const timer = setTimeout(() => set({ toast: { message: '', type: '' } }), dur);
    set({ _toastTimer: timer });
  },

  // ─── Actions: Chat (Cloud LLM) ───
  toggleChatPanel: () => set(state => ({ chatPanelOpen: !state.chatPanelOpen })),
  setChatSending: (val) => set({ chatSending: val }),
  setChatSetupStep: (step) => set({ chatSetupStep: step }),
  setChatError: (error) => set({ chatError: error }),
  clearChatError: () => set({ chatError: null }),
  clearChatMessages: () => set({ chatMessages: [] }),
  setChatConfig: (config) => set({ chatConfig: config }),
  setChatConfigPath: (p) => set({ chatConfigPath: p }),
  setChatAvailableModels: (models) => set({ chatAvailableModels: models }),
  addChatMessage: (msg) => set(state => ({
    chatMessages: [...state.chatMessages, msg],
  })),
}));
