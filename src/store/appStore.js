import { create } from 'zustand';
import { getAirlineCode, TOAST_DURATION_MS, FALLBACK_BASE_MINUTES, DEFAULT_TIME_OFFSET_MIN, DEFAULT_TAXI_MINUTES, STORAGE_KEY_THEME } from '../utils/constants';

// Pick the first valid flight number for an airline from the canonical set
// (_flightNums is collected during root scan from audio clips + ALL .acl files)
function pickFirstFlightNumber(state, airlineCode) {
  const vals = state.airportValues[state.currentAirport] || {};
  const canonNums = vals._flightNums || {};
  const nums = canonNums[airlineCode];
  if (nums && nums.length > 0) return nums[0];
  return '1'; // fallback
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

  // ─── Actions: Legacy sync ───
  setLegacyState: (updates) => set(updates),

  // ─── Actions: Screen ───
  setScreen: (screen) => set({ screen, ...(screen !== 'editor' ? { showStandMap: false, showStarMap: false, activeMap: null } : {}) }),
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

    // ── compute default times from config end ──
    let baseMin = FALLBACK_BASE_MINUTES; // fallback 06:00
    if (state._configEndTime) {
      const p = String(state._configEndTime).split(':');
      baseMin = parseInt(p[0]) * 60 + parseInt(p[1]) - DEFAULT_TIME_OFFSET_MIN;
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
      CallSign: airlineCode + pickFirstFlightNumber(get(), airlineCode),
      ArrivalAirport: state.currentAirport || '',
      LandingTime: pad(baseMin),
      InBlockTime: pad(baseMin + DEFAULT_TAXI_MINUTES),
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
    let baseMin = FALLBACK_BASE_MINUTES; // fallback 06:00
    if (state._configEndTime) {
      const p = String(state._configEndTime).split(':');
      baseMin = parseInt(p[0]) * 60 + parseInt(p[1]) - DEFAULT_TIME_OFFSET_MIN;
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
      CallSign: airlineCode + pickFirstFlightNumber(get(), airlineCode),
      DepartureAirport: state.currentAirport || '',
      OffBlockTime: pad(baseMin),
      TakeoffTime: pad(baseMin + DEFAULT_TAXI_MINUTES),
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
        // AirlineCode changed — auto-pick first valid number from canonical set
        num = pickFirstFlightNumber(get(), code);
        if (!num || num === '1') num = (old.CallSign || '').substring(3);
      }
      flight.CallSign = code + num;

      // AirlineCode changed — cascade AircraftType + Registration to first valid option
      if ('AirlineCode' in updates) {
        const state = get();
        const vals = state.airportValues[state.currentAirport] || {};
        const compat = vals._compat || {};

        // AircraftType: reset to first valid type for the new airline
        const validTypes = compat.airlineToAircraft?.[code];
        if (validTypes && validTypes.length > 0) {
          const curType = flight.AircraftType || '';
          if (!curType || !validTypes.includes(curType)) {
            flight.AircraftType = validTypes[0];
          }
        }

        // Registration: reset to first valid reg for airline + aircraft type
        const acType = flight.AircraftType || '';
        const regKey = code + '|' + acType;
        const validRegs = vals._registrationMap?.[regKey];
        if (validRegs && validRegs.length > 0) {
          const curReg = flight.Registration || flight._Registration || '';
          if (!curReg || !validRegs.includes(curReg)) {
            flight.Registration = validRegs[0];
            delete flight._Registration;
          }
        }
      }
    }
    // Runway changed — cascade Airway to first valid STAR for the new runway.
    // If the new runway has no approach data (e.g. 31L at KJFK), clear the Airway
    // so it doesn't stay on a STAR that isn't valid for this runway.
    if ('Runway' in updates) {
      const state = get();
      const vals = state.airportValues[state.currentAirport] || {};
      const runwayStarMap = vals._runwayStarMap || {};
      const validStars = runwayStarMap[updates.Runway] || [];
      const curAirway = flight.Airway || '';
      if (validStars.length > 0) {
        if (!curAirway || !validStars.includes(curAirway)) {
          flight.Airway = validStars[0];
        }
      } else {
        // No STAR is valid for this runway — clear the stale value
        flight.Airway = '';
      }
    }

    // When user explicitly edits Registration, clear the parsed _Registration
    // so it doesn't shadow the new value (display reads _Registration first)
    if ('Registration' in updates) {
      delete flight._Registration;
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
    const timer = setTimeout(() => set({ toast: { message: '', type: '' } }), TOAST_DURATION_MS);
    set({ _toastTimer: timer });
  },
}));
