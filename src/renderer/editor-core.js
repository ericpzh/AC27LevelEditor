// ═══════════ SCREEN 2: EDITOR ══════════════════════════

async function openEditor(filePath, airportIcao) {
  showScreen('editor');
  document.getElementById('editor-filename').textContent = '加载中…';

  console.log('[RENDERER] loadAcl() CALL for:', filePath);
  const data = await window.electronAPI.loadAcl(filePath);
  console.log('[RENDERER] loadAcl() RESULT:', { success: data.success, flights: data.flights ? data.flights.length : 0, error: data.error, _fromFlightPlans: data._fromFlightPlans, _fromWorldState: data._fromWorldState });
  if (!data.success) { showAlert('加载失败', data.error); return; }

  appState.currentPath = filePath;
  appState.currentAirport = airportIcao;
  appState.flights = data.flights;
  initFlightNumberCounter();
  appState.before = data.before;
  appState.after = data.after;
  appState.arrayContent = data.arrayContent;
  appState.originalBlocks = data.originalBlocks;
  appState.worldStateData = data.worldStateData || null;
  appState.sceneryMaps = data.sceneryMaps || null;
  appState._fromWorldState = data._fromWorldState || false;
  appState._fromFlightPlans = data._fromFlightPlans || false;
  appState._rawText = data._rawText || '';
  appState.modified = false;
  appState.highlightedIdx = -1;
  appState.highlightedCells = new Set();
  appState.selectedIndices = new Set();
  appState.editingWidget = null;
  appState.timelineModified = { weather: false, wind: false, runway: false };

  // Populate config info bar and store config for validation
  appState._earliestTime = data.earliestTime || null;
  populateConfigBar(data.config, filePath, airportIcao);
  if (data.config) {
    appState._configStartTime = data.config.startTime || null;
    appState._configEndTime = data.config.endTime || null;
  } else {
    appState._configStartTime = null;
    appState._configEndTime = null;
  }

  if (appState.rootPath && airportIcao && !appState.airportValues[airportIcao]) {
    const vals = await window.electronAPI.collectValues(appState.rootPath, airportIcao);
    window.electronAPI.rendererLog('══════ [REG-IPC] collectValues returned for', airportIcao, '══════');
    window.electronAPI.rendererLog('[REG-IPC] _registrationMap exists:', !!vals._registrationMap);
    window.electronAPI.rendererLog('[REG-IPC] _registrationMap keys:', vals._registrationMap ? Object.keys(vals._registrationMap) : 'NONE');
    if (vals._registrationMap) {
      for (const [k, regs] of Object.entries(vals._registrationMap)) {
        window.electronAPI.rendererLog('[REG-IPC]   ' + k + ' -> ' + JSON.stringify(regs));
      }
    }
    window.electronAPI.rendererLog('[REG-IPC] Registration list length:', (vals.Registration || []).length);
    window.electronAPI.rendererLog('[REG-IPC] _compat exists:', !!vals._compat);
    window.electronAPI.rendererLog('[REG-IPC] _compat airlineToAircraft keys:', vals._compat ? Object.keys(vals._compat.airlineToAircraft) : 'MISSING');
    appState.airportValues[airportIcao] = vals;
  }

  // Load audio callsigns for this airport
  if (appState.rootPath && airportIcao) {
    appState.audioCallsigns = await window.electronAPI.loadAudioCallsigns(appState.rootPath, airportIcao);
  } else {
    appState.audioCallsigns = { byAirline: {}, allCallsigns: [], allAirlines: [] };
  }

  // Load timelines
  const tl = await window.electronAPI.loadTimelines(filePath);
  if (tl.success) {
    appState.weatherTimeline = tl.weatherTimeline || [];
    appState.weatherPath = tl.weatherPath;
    appState.windTimeline = tl.windTimeline || [];
    appState.windPath = tl.windPath;
    appState.runwayTimeline = tl.runwayTimeline || { initialRunways: [], timeline: [] };
    appState.runwayTimelinePath = tl.runwayTimelinePath;
  }

  // Scan runway pairs from all runway_timeline_*.json for this airport
  if (appState.rootPath && airportIcao) {
    const rp = await window.electronAPI.scanRunwayPairs(appState.rootPath, airportIcao);
    appState._runwayPairs = (rp && rp.success) ? (rp.pairs || []) : [];
  }

  autoSort();
  autoFillSingleOptionColumns();
  renderAllSections();

  document.getElementById('editor-filename').textContent = stripSuffixes(filePath.split(/[/\\]/).pop());
  document.getElementById('editor-airport').textContent = airportIcao || '';
  showToast(`已加载 ${data.flights.length} 个航班`, 'success');
}

// ─── Auto-fill single-option dropdown columns ────────────

function autoFillSingleOptionColumns() {
  const values = appState.airportValues[appState.currentAirport] || {};
  const allFieldLists = [ARRIVAL_FIELDS, DEPARTURE_FIELDS];
  for (const fl of appState.flights) {
    for (const fieldList of allFieldLists) {
      for (const col of fieldList) {
        if (!DROPDOWN_FIELDS.has(col)) continue;
        // Registration and Language: never auto-fill, always show dropdown
        if (col === 'Registration' || col === 'Language') continue;
        const hasData = !!(fl[col] || '').trim();
        if (hasData) continue;
        const opts = values[col] || [];
        if (opts.length === 1) {
          fl[col] = opts[0];
        }
      }
    }
  }
}

// ─── Config info bar ────────────────────────────────────

function populateConfigBar(config, filePath, airportIcao) {
  const end = (config && config.endTime) || null;
  // Config startTime has 10-min warmup — add 10 min to match in-game display
  let start = null;
  if (config && config.startTime) {
    const p = String(config.startTime).split(':');
    const m = parseInt(p[0]) * 60 + parseInt(p[1]) + 10;
    start = String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }
  if (start && end) {
    document.getElementById('toolbar-time-range').textContent =
      '时间段：' + start + ' ~ ' + String(end).substring(0, 5);
  } else {
    document.getElementById('toolbar-time-range').textContent = '时间段：-';
  }
}

// ─── Auto-sort: arrivals by LandingTime, departures by OffBlockTime ───
function autoSort() {
  const arrivals = [];
  const departures = [];

  for (const fl of appState.flights) {
    if ((fl.LandingTime || '').trim()) arrivals.push(fl);
    else departures.push(fl);
  }

  arrivals.sort((a, b) => (a.LandingTime || '').localeCompare(b.LandingTime || ''));
  departures.sort((a, b) => (a.OffBlockTime || '').localeCompare(b.OffBlockTime || ''));
  appState.flights = [...arrivals, ...departures];
}

// ─── Determine active columns for a section ─────────────
function getActiveColumns(flights, fieldList) {
  if (flights.length === 0) return fieldList; // show all if empty
  const values = appState.airportValues[appState.currentAirport] || {};
  const active = [];
  for (const col of fieldList) {
    // Mandatory columns always show
    if (col === 'CallSign' || col === 'FlightNum' || col === 'AirlineCode') {
      active.push(col);
      continue;
    }
    // Registration & Language: always show as dropdown (never auto-hide)
    if (col === 'Registration' || col === 'Language') {
      active.push(col);
      continue;
    }
    const hasData = flights.some(fl => (fl[col] || '').trim() !== '');
    // For dropdown fields: if ≤1 option exists across the whole airport, hide & auto-fill
    if (DROPDOWN_FIELDS.has(col)) {
      const opts = values[col] || [];
      // 0 options → no dropdown possible, hide column entirely
      if (opts.length === 0) continue;
      // 1 option → auto-fill all flights and hide column
      if (opts.length === 1) {
        for (const fl of flights) {
          if (col === 'Registration') fl._Registration = opts[0];
          else fl[col] = opts[0];
        }
        continue;
      }
    }
    if (hasData) active.push(col);
  }
  return active;
}

// ─── Build section table ─────────────────────────────────
function buildSectionTable(sectionId, title, flights, fieldList, typeClass) {
  const sectionDiv = document.getElementById(sectionId);
  if (!sectionDiv) return;

  sectionDiv.classList.remove('hidden');

  const activeCols = getActiveColumns(flights, fieldList);
  const thead = sectionDiv.querySelector('thead tr');
  thead.innerHTML = '<th class="col-chk"></th>' +
    activeCols.map(col => {
    const label = FIELD_LABELS[col] || col;
    const cls = COL_CLASSES[col] || '';
    return `<th class="${cls}" data-col="${col}">${label}</th>`;
  }).join('');

  const tbody = sectionDiv.querySelector('tbody');
  if (flights.length === 0) {
    tbody.innerHTML = '';
  } else {
    function getCellValue(fl, col) {
      if (col === 'AirlineCode') return (fl.CallSign || '').substring(0, 3);
      if (col === 'FlightNum') return (fl.CallSign || '').substring(3);
      if (col === 'Registration') return fl._Registration || fl.Registration || '';
      return fl[col] || '';
    }
    tbody.innerHTML = flights.map(fl => {
      const globalIdx = appState.flights.indexOf(fl);
      const checked = appState.selectedIndices.has(globalIdx) ? ' checked' : '';
      const selClass = appState.highlightedIdx === globalIdx ? ' selected' : '';
      const newAttr = fl._isNew ? ' data-new' : '';
      return `<tr class="${typeClass}${selClass}" data-idx="${globalIdx}"${newAttr}>
        <td class="chk-cell"><input type="checkbox" class="chk-row" data-idx="${globalIdx}"${checked}></td>
        ${activeCols.map(col => {
          const val = getCellValue(fl, col);
          const baseCls = col === 'AirlineCode' ? 'airline-code-cell' : col === 'FlightNum' ? 'flight-num-cell' : '';
          const nullCls = val ? '' : ' cell-null';
          const hiCls = appState.highlightedCells.has(`${globalIdx}:${col}`) ? ' highlight-invalid' : '';
          return `<td class="${baseCls}${nullCls}${hiCls}" data-col="${col}" data-idx="${globalIdx}">${val}</td>`;
        }).join('')}
      </tr>`;
    }).join('');
  }
}

function renderAllSections() {
  const arrivals = [], departures = [];
  for (const fl of appState.flights) {
    if ((fl.LandingTime || '').trim()) arrivals.push(fl);
    else departures.push(fl);  // no LandingTime → treat as departure (or pending)
  }

  buildSectionTable('section-arrivals', '进港', arrivals, ARRIVAL_FIELDS, 'row-arrival');
  buildSectionTable('section-departures', '离港', departures, DEPARTURE_FIELDS, 'row-departure');

  // Clean up _isNew flags after render (they trigger flash animation via data-new)
  for (const fl of appState.flights) { delete fl._isNew; }

  // Render embedded timelines
  renderWeatherEditor();
  renderWindEditor();
  renderRunwayEditor();

  updateStatusBar();
}
