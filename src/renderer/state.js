// ─── Flight Number Counter (persistent across delete-all) ──
let nextFlightNumber = 1;

function initFlightNumberCounter() {
  let maxNum = 0;
  for (const fl of appState.flights) {
    const match = (fl.CallSign || '').match(/(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    }
  }
  nextFlightNumber = maxNum + 1;
}

// ─── App State ──────────────────────────────────────────
let appState = {
  screen: 'setup',
  rootPath: null,
  airports: [],
  airportValues: {},
  // Editor
  currentPath: null,
  currentAirport: null,
  flights: [],
  before: '', after: '', arrayContent: '', originalBlocks: [],
  modified: false,
  highlightedIdx: -1,           // single highlighted row for copy
  selectedIndices: new Set(),   // checked rows for batch delete
  highlightedCells: new Set(),  // cells with invalid values (e.g. after airline change): "idx:col"
  editingWidget: null,
  // Audio callsigns (available voices per airport, from audio_clips_en.json)
  audioCallsigns: { byAirline: {}, allCallsigns: [], allAirlines: [] },
  // Tabs & Timelines
  activeTab: 'flights',
  // Timeline data
  weatherTimeline: [], weatherPath: null,
  windTimeline: [], windPath: null,
  runwayTimeline: { initialRunways: [], timeline: [] }, runwayTimelinePath: null,
  timelineModified: { weather: false, wind: false, runway: false },
  // Config values for validation
  _configStartTime: null, _configEndTime: null,
};
