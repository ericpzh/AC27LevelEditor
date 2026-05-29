// ─── Airport Hardcoded Display Names & Sort Order ──────────
const AIRPORT_META = {
  ZSJN: { id: 1, name: '济南遥墙机场' },
  KJFK: { id: 2, name: '约翰·肯尼迪国际机场' },
};

// ─── Airline Name → Airline Code mapping ──────────────
// AirlineName in the game files stores ICAO 3-letter codes;
// this mapping handles cases where the name differs from the code.
const AIRLINE_CODE_MAP = {
  // Chinese airlines
  'Air China': 'CCA',
  '中国国航': 'CCA',
  'China Eastern': 'CES',
  '中国东方航空': 'CES',
  'China Southern': 'CSN',
  '中国南方航空': 'CSN',
  'Hainan Airlines': 'CHH',
  '海南航空': 'CHH',
  'Shenzhen Airlines': 'CSZ',
  '深圳航空': 'CSZ',
  'Sichuan Airlines': 'CSC',
  '四川航空': 'CSC',
  'Xiamen Airlines': 'CXA',
  '厦门航空': 'CXA',
  'Shandong Airlines': 'CDG',
  '山东航空': 'CDG',
  'Spring Airlines': 'CQH',
  '春秋航空': 'CQH',
  'Okay Airways': 'CJX',
  '奥凯航空': 'CJX',
  'Tibet Airlines': 'UEA',
  '西藏航空': 'UEA',
  // International airlines (full names → codes)
  'American Airlines': 'AAL',
  'Delta Air Lines': 'DAL',
  'United Airlines': 'UAL',
  'JetBlue': 'JBU',
  'British Airways': 'BAW',
  'Air France': 'AFR',
  'Lufthansa': 'DLH',
  'Qantas': 'QFA',
  'Qatar Airways': 'QTR',
  'Cathay Pacific': 'CPA',
  'Singapore Airlines': 'SIA',
  'Air New Zealand': 'ANZ',
  'Alaska Airlines': 'ASA',
  'Etihad Airways': 'ETD',
  'Gulf Air': 'GFA',
  'Air Arabia': 'AAR',
  'Virgin Atlantic': 'VIR',
  'Avianca': 'AVA',
  'Asiana Airlines': 'AAR',
  'Korean Air': 'AAR',
  'Emirates': 'UAE',
  'Turkish Airlines': 'THY',
  'Air Canada': 'ACA',
  'Japan Airlines': 'JAL',
  'All Nippon Airways': 'ANA',
  'Ethiopian Airlines': 'ETH',
  'KLM': 'KLM',
  'Swiss': 'SWR',
  'Aeroflot': 'AFL',
  'China Airlines': 'CAL',
  'EVA Air': 'EVA',
};

function getAirlineCode(airlineName) {
  if (!airlineName) return 'NEW';
  // If AirlineName is already a 3-letter ICAO code (e.g. "DAL"), use it directly
  if (/^[A-Z]{3}$/.test(airlineName)) return airlineName;
  // Look up in the mapping
  const code = AIRLINE_CODE_MAP[airlineName];
  if (code) return code;
  // Fallback: first 3 chars uppercased
  return airlineName.substring(0, 3).toUpperCase();
}

function airportDisplayName(icao) {
  const meta = AIRPORT_META[icao];
  return meta ? `${icao} — ${meta.name}` : icao;
}

function airportSortOrder(icao) {
  const meta = AIRPORT_META[icao];
  return meta ? meta.id : 9999;
}

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

// ─── Field Definitions (no Voice/Language) ────────────────
const ALL_FIELDS = [
  ['CallSign', 'string'],
  ['DepartureAirport', 'string'],
  ['ArrivalAirport', 'string'],
  ['Stand', 'string'],
  ['Runway', 'string'],
  ['OffBlockTime', 'time'],
  ['TakeoffTime', 'time'],
  ['LandingTime', 'time'],
  ['InBlockTime', 'time'],
  ['AirlineName', 'string'],
  ['AircraftType', 'string'],
];

const FIELD_LABELS = {
  AirlineCode: '航司代码', FlightNum: '航班号',
  CallSign: '呼号', DepartureAirport: '出发', ArrivalAirport: '到达',
  Stand: '停机位', Runway: '跑道', OffBlockTime: '推出', TakeoffTime: '起飞',
  LandingTime: '落地', InBlockTime: '入位', AirlineName: '航司',
  AircraftType: '机型',
};

// Fields that get clock popover
const TIME_FIELDS = new Set(['LandingTime', 'InBlockTime', 'OffBlockTime', 'TakeoffTime']);

// Fields that get dropdown menus
const DROPDOWN_FIELDS = new Set([
  'AircraftType', 'AirlineCode',
  'Stand', 'Runway', 'DepartureAirport', 'ArrivalAirport',
]);

const COL_CLASSES = {
  AirlineCode: 'col-airline-code', FlightNum: 'col-flight-num',
  CallSign: 'col-callsign', DepartureAirport: 'col-dep',
  ArrivalAirport: 'col-arr', Stand: 'col-stand', Runway: 'col-runway',
  OffBlockTime: 'col-time', TakeoffTime: 'col-time', LandingTime: 'col-time',
  InBlockTime: 'col-time', AirlineName: 'col-airline', AircraftType: 'col-ac',
};

// Fields per section (arrivals always ArrivalAirport=this airport, departures always DepartureAirport=this airport)
// Arrivals show origin (DepartureAirport), departures show destination (ArrivalAirport)
const ARRIVAL_FIELDS = ['AirlineCode', 'FlightNum', 'DepartureAirport', 'Stand', 'Runway', 'LandingTime', 'InBlockTime', 'AircraftType'];
const DEPARTURE_FIELDS = ['AirlineCode', 'FlightNum', 'ArrivalAirport', 'Stand', 'Runway', 'OffBlockTime', 'TakeoffTime', 'AircraftType'];

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
};

// ─── Screen Navigation ──────────────────────────────────
function showScreen(name) {
  appState.screen = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById(`screen-${name}`);
  if (target) target.classList.remove('hidden');
}

// ─── Toast ──────────────────────────────────────────────
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = type; t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ─── Modal ──────────────────────────────────────────────
function showModal(title, bodyHtml, actionsHtml) {
  const o = document.getElementById('modal-overlay');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-actions').innerHTML = actionsHtml;
  o.classList.remove('hidden');
}
function hideModal() { document.getElementById('modal-overlay').classList.add('hidden'); }

function showAlert(title, msg) {
  showModal(title, `<p>${msg}</p>`, `<button class="btn-confirm" id="modal-ok">确定</button>`);
  document.getElementById('modal-ok').onclick = hideModal;
}

// ═══════════ SCREEN 0: SETUP ═══════════════════════════

document.getElementById('btn-select-root').addEventListener('click', async () => {
  const result = await window.electronAPI.selectGameRoot();
  if (result.canceled) return;

  if (result.error) {
    document.getElementById('setup-error').textContent = result.error;
    document.getElementById('setup-error').classList.remove('hidden');
    return;
  }

  document.getElementById('setup-error').classList.add('hidden');
  appState.rootPath = result.rootPath;
  appState.airports = result.airports || [];
  saveLastRootLocal(result.rootPath);
  showBrowser();
});

// ═══════════ SCREEN 1: BROWSER ═════════════════════════

async function showBrowser() {
  showScreen('browser');
  document.getElementById('browser-root-path').textContent = appState.rootPath || '';

  const loading = document.getElementById('browser-loading');
  const list = document.getElementById('browser-list');
  loading.classList.remove('hidden');
  list.innerHTML = '';

  if (appState.airports.length === 0 && appState.rootPath) {
    const scan = await window.electronAPI.scanAcls(appState.rootPath);
    if (!scan.error) appState.airports = scan.airports || [];
  }

  // Sort by hardcode ID, unknown airports go last
  appState.airports.sort((a, b) => airportSortOrder(a.icao) - airportSortOrder(b.icao));

  for (const airport of appState.airports) {
    const infos = await window.electronAPI.getAirportFilesInfo(airport.icao, appState.rootPath);
    airport._fileInfos = infos || [];
  }

  loading.classList.add('hidden');

  if (appState.airports.length === 0) {
    list.innerHTML = '<div class="browser-empty">未找到任何 .acl 关卡文件</div>';
    return;
  }

  list.innerHTML = appState.airports.map(airport => {
    const infos = airport._fileInfos || [];
    const dispName = airportDisplayName(airport.icao);

    const rows = infos.map(info => {
      if (info.error) {
        return `<div class="level-row" style="opacity:0.5">
          <span class="level-name">${info.filename}</span>
          <span class="level-stats" style="color:var(--red)">${info.error}</span>
          <span class="level-arrow">&rarr;</span>
        </div>`;
      }
      const displayName = stripSuffixes(info.filename);
      const tags = parseTags(displayName);
      const tagsHtml = tags.length > 0
        ? `<span class="level-tags">${tags.map(t => `<span class="level-tag tag-${t.type}">${escapeHtml(t.label)}</span>`).join('')}</span>`
        : '';
      return `<div class="level-row" data-path="${escapeHtml(info.path)}" data-airport="${escapeHtml(airport.icao)}">
        <span class="level-name">${displayName}</span>
        ${tagsHtml}
        <span class="level-stats">
          <span class="level-stat"><span class="level-stat-dot arrival"></span>进港 ${info.arrivals || 0}</span>
          <span class="level-stat"><span class="level-stat-dot departure"></span>离港 ${info.departures || 0}</span>
        </span>
        <span class="level-arrow">&rarr;</span>
      </div>`;
    }).join('');

    return `<div class="airport-card">
      <div class="airport-card-header">
        <span class="airport-icao">${dispName}</span>
      </div>
      ${rows}
    </div>`;
  }).join('');

  list.querySelectorAll('.level-row[data-path]').forEach(row => {
    row.addEventListener('click', async () => {
      const filePath = row.dataset.path;
      const airportIcao = row.dataset.airport;
      await openEditor(filePath, airportIcao);
    });
  });
}

document.getElementById('btn-change-root').addEventListener('click', () => {
  showScreen('setup');
});

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Strip .Prod.acl, .Stage.Prod.acl etc. to show clean filename
function stripSuffixes(name) {
  return name.replace(/(\.[a-zA-Z0-9]+)+\.acl$/i, '.acl');
}

// ─── Filename Tag Parser ─────────────────────────────────
function parseTags(filename) {
  // strip .acl extension and ICAO prefix (e.g. KJFK_ / ZSJN-)
  let base = filename.replace(/\.acl$/i, '');
  base = base.replace(/^[A-Z]{4}[-_]?/, '');
  // Replace _ with - so \b works correctly (JS treats _ as \w)
  base = base.replace(/_/g, '-');

  const tags = [];

  // 1. Time range: 07-09 → "07:00~09:00", also infer time-of-day
  const timeMatch = base.match(/(\d{2})-(\d{2})/);
  if (timeMatch) {
    const startH = parseInt(timeMatch[1]);
    tags.push({ label: `${timeMatch[1]}:00\u2013${timeMatch[2]}:00`, type: 'time' });
    // Infer time-of-day from start hour
    if (startH >= 5 && startH < 12) {
      tags.push({ label: '上午', type: 'tod' });
    } else if (startH >= 12 && startH < 17) {
      tags.push({ label: '下午', type: 'tod' });
    } else if (startH >= 17 && startH < 20) {
      tags.push({ label: '傍晚', type: 'tod' });
    } else if (startH >= 20 || startH < 5) {
      tags.push({ label: '夜间', type: 'tod' });
    }
  }

  // 2. Tutorial
  if (/Tutorial/i.test(base)) {
    tags.push({ label: '教程', type: 'tutorial' });
  }

  // 3. Time of day: Day / Morning / Evening / Night (explicit keyword)
  const todMatch = base.match(/\b(Day|Morning|Evening|Night)\b/i);
  if (todMatch) {
    const labelMap = { Day: '白天', Morning: '上午', Evening: '傍晚', Night: '夜间' };
    // Avoid duplicate if already inferred from time range
    if (!tags.some(t => t.type === 'tod' && t.label === labelMap[todMatch[1]])) {
      tags.push({ label: labelMap[todMatch[1]], type: 'tod' });
    }
  }

  return tags;
}

// ═══════════ SCREEN 2: EDITOR ══════════════════════════

async function openEditor(filePath, airportIcao) {
  showScreen('editor');
  document.getElementById('editor-filename').textContent = '加载中…';

  const data = await window.electronAPI.loadAcl(filePath);
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
  appState._rawText = data._rawText || '';
  appState.modified = false;
  appState.highlightedIdx = -1;
  appState.selectedIndices = new Set();
  appState.editingWidget = null;
  appState.timelineModified = { weather: false, wind: false, runway: false };

  if (appState.rootPath && airportIcao && !appState.airportValues[airportIcao]) {
    appState.airportValues[airportIcao] = await window.electronAPI.collectValues(appState.rootPath, airportIcao);
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

  autoSort();
  renderAllSections();

  document.getElementById('editor-filename').textContent = stripSuffixes(filePath.split(/[/\\]/).pop());
  document.getElementById('editor-airport').textContent = airportIcao || '';
  showToast(`已加载 ${data.flights.length} 个航班`, 'success');
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
  const active = [];
  for (const col of fieldList) {
    const hasData = flights.some(fl => (fl[col] || '').trim() !== '');
    if (hasData || col === 'CallSign' || col === 'FlightNum' || col === 'AirlineCode') active.push(col); // always show these
  }
  return active;
}

// ─── Build section table ─────────────────────────────────
function buildSectionTable(sectionId, title, flights, fieldList, typeClass) {
  const container = document.getElementById('sections-container');
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
      return fl[col] || '';
    }
    tbody.innerHTML = flights.map(fl => {
      const globalIdx = appState.flights.indexOf(fl);
      const checked = appState.selectedIndices.has(globalIdx) ? ' checked' : '';
      const selClass = appState.highlightedIdx === globalIdx ? ' selected' : '';
      return `<tr class="${typeClass}${selClass}" data-idx="${globalIdx}">
        <td class="chk-cell"><input type="checkbox" class="chk-row" data-idx="${globalIdx}"${checked}></td>
        ${activeCols.map(col => {
          const val = getCellValue(fl, col);
          const baseCls = col === 'AirlineCode' ? 'airline-code-cell' : col === 'FlightNum' ? 'flight-num-cell' : '';
          const nullCls = val ? '' : ' cell-null';
          return `<td class="${baseCls}${nullCls}" data-col="${col}" data-idx="${globalIdx}">${val}</td>`;
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

  // Render embedded timelines
  renderWeatherEditor();
  renderWindEditor();
  renderRunwayEditor();

  updateStatusBar();
}

// ─── Cell Click → Edit + highlight row ────────────────────
// Bind to the sections container (event delegation)
document.getElementById('sections-container').addEventListener('click', (e) => {
  if (appState.editingWidget) return;

  const td = e.target.closest('td');
  const tr = e.target.closest('tr');

  // Set row highlight regardless of where exactly was clicked
  if (tr) {
    const idx = parseInt(tr.dataset.idx);
    if (!isNaN(idx)) appState.highlightedIdx = idx;
  }

  // Click on checkbox → let the change event handle it
  if (e.target.closest('input[type="checkbox"]')) {
    renderAllSections();
    return;
  }

  // Click on td → start editing
  if (td) {
    const col = td.dataset.col;
    const idx = parseInt(td.dataset.idx);
    startCellEdit(td, col, idx);
  } else {
    // Click on row background (outside any td) → re-render to show highlight
    renderAllSections();
  }
});

// ─── Checkbox handlers ───────────────────────────────────
document.getElementById('sections-container').addEventListener('change', function(e) {
  // Individual row checkbox
  if (e.target.classList.contains('chk-row')) {
    const idx = parseInt(e.target.dataset.idx);
    if (e.target.checked) {
      appState.selectedIndices.add(idx);
    } else {
      appState.selectedIndices.delete(idx);
    }
    return;
  }

});

// ─── Time Clock Popover (with optional onCommit for timeline use) ──
function openTimeClockPopover(anchorEl, col, idx, currentVal, onCommit) {
  // When onCommit is provided:
  //   anchorEl is used ONLY for positioning
  //   commit/cancel call onCommit which handles data & re-render
  // When onCommit is omitted:
  //   anchorEl is a <td> cell, commit writes to appState.flights[idx][col]

  const parsed = (currentVal || '00:00:00').split(':');
  let hour = parseInt(parsed[0]) || 0;
  let minute = parseInt(parsed[1]) || 0;
  let second = parseInt(parsed[2]) || 0;

  const SIZE = 220;
  const CX = SIZE / 2, CY = SIZE / 2;
  const R = 95;

  // ── Build popover DOM ──
  const overlay = document.createElement('div');
  overlay.className = 'time-clock-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { commit(); }
  });

  const popover = document.createElement('div');
  popover.className = 'time-clock-popover';
  overlay.appendChild(popover);

  popover.innerHTML = `
    <div class="clock-title">${FIELD_LABELS[col] || col} 时间</div>
    <svg class="clock-svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
      <circle class="clock-face-bg" cx="${CX}" cy="${CY}" r="${R}" />
      ${buildTickMarks(CX, CY, R)}
      <line class="clock-hand clock-hand-hour" id="clock-hand-hour" />
      <line class="clock-hand clock-hand-minute" id="clock-hand-minute" />
      <line class="clock-hand clock-hand-second" id="clock-hand-second" />
      <circle class="clock-center-dot" cx="${CX}" cy="${CY}" r="4" />
    </svg>
    <div class="clock-input-row">
      <input class="clock-time-input" type="text" id="clock-time-input"
             placeholder="HH:MM:SS" maxlength="8" />
      <button class="clock-btn clock-btn-ok" id="clock-btn-ok">&#10003;</button>
      <button class="clock-btn clock-btn-cancel" id="clock-btn-cancel">&#10005;</button>
    </div>
  `;

  const svg = popover.querySelector('.clock-svg');
  const hourHand = popover.querySelector('#clock-hand-hour');
  const minuteHand = popover.querySelector('#clock-hand-minute');
  const secondHand = popover.querySelector('#clock-hand-second');
  const input = popover.querySelector('#clock-time-input');

  function _updateClockHands() {
    const hAngle = ((hour % 12) + minute / 60 + second / 3600) * 30;
    const mAngle = (minute + second / 60) * 6;
    const sAngle = second * 6;
    setHand(hourHand, CX, CY, 42, hAngle);
    setHand(minuteHand, CX, CY, 62, mAngle);
    setHand(secondHand, CX, CY, 70, sAngle);
  }

  function updateDisplay() {
    _updateClockHands();
    input.value = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}`;
  }

  function setHand(el, x, y, len, angleDeg) {
    const rad = (angleDeg - 90) * Math.PI / 180;
    el.setAttribute('x1', x);
    el.setAttribute('y1', y);
    el.setAttribute('x2', x + len * Math.cos(rad));
    el.setAttribute('y2', y + len * Math.sin(rad));
  }

  updateDisplay();

  // ── Drag on clock face ──
  let dragging = false;
  let dragTarget = 'minute';
  const lastDragValues = { hour: hour, minute: minute, second: second };

  function dragStart(e, target) {
    e.preventDefault();
    dragging = true;
    dragTarget = target || 'minute';
    lastDragValues.hour = hour;
    lastDragValues.minute = minute;
    lastDragValues.second = second;
    svg.classList.add('clock-dragging');
  }
  function dragMove(e) {
    if (!dragging) return;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / SIZE;
    const mx = ((e.touches ? e.touches[0].clientX : e.clientX) - rect.left) / scale - CX;
    const my = ((e.touches ? e.touches[0].clientY : e.clientY) - rect.top) / scale - CY;
    let angle = Math.atan2(my, mx) * 180 / Math.PI + 90;
    if (angle < 0) angle += 360;

    if (dragTarget === 'hour') {
      const h12 = Math.round(angle / 30) % 12;
      const baseH = lastDragValues.hour;
      const candidates = [h12, h12 + 12, h12 - 12].filter(h => h >= 0 && h <= 23);
      hour = candidates.reduce((best, h) => Math.abs(h - baseH) < Math.abs(best - baseH) ? h : best, candidates[0]);
    } else if (dragTarget === 'second') {
      const newSecond = Math.round(angle / 6) % 60;
      const lastSec = lastDragValues.second;
      // Detect wrap: 59→0 (forward) = increment minute; 0→59 (backward) = decrement minute
      if (lastSec > 50 && newSecond < 10) {
        minute = (minute + 1) % 60;
        if (minute === 0) hour = (hour + 1) % 24;
      } else if (lastSec < 10 && newSecond > 50) {
        minute = (minute + 59) % 60;
        if (minute === 59) hour = (hour + 23) % 24;
      }
      second = newSecond;
      lastDragValues.second = second;
    } else { // minute
      const newMinute = Math.round(angle / 6) % 60;
      const lastMin = lastDragValues.minute;
      // Detect wrap: 59→0 (forward) = increment hour; 0→59 (backward) = decrement hour
      if (lastMin > 50 && newMinute < 10) {
        hour = (hour + 1) % 24;
      } else if (lastMin < 10 && newMinute > 50) {
        hour = (hour + 23) % 24;
      }
      minute = newMinute;
      lastDragValues.minute = minute;
    }
    updateDisplay();
  }
  function dragEnd() {
    dragging = false;
    svg.classList.remove('clock-dragging');
  }

  svg.addEventListener('mousedown', dragStart);
  svg.addEventListener('mousemove', dragMove);
  svg.addEventListener('mouseup', dragEnd);
  svg.addEventListener('mouseleave', dragEnd);
  svg.addEventListener('touchstart', dragStart, { passive: false });
  svg.addEventListener('touchmove', dragMove, { passive: false });
  svg.addEventListener('touchend', dragEnd);

  hourHand.addEventListener('mousedown', (e) => { e.stopPropagation(); dragStart(e, 'hour'); });
  hourHand.addEventListener('touchstart', (e) => { e.stopPropagation(); dragStart(e, 'hour'); });
  secondHand.addEventListener('mousedown', (e) => { e.stopPropagation(); dragStart(e, 'second'); });
  secondHand.addEventListener('touchstart', (e) => { e.stopPropagation(); dragStart(e, 'second'); });

  // ── Text input ──
  input.addEventListener('input', () => {
    const val = input.value;
    const m = val.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (m) {
      hour = Math.min(23, parseInt(m[1]) || 0);
      minute = Math.min(59, parseInt(m[2]) || 0);
      second = m[3] ? Math.min(59, parseInt(m[3]) || 0) : 0;
    } else if (/^\d+$/.test(val) && val.length <= 6) {
      // Pure digits: parse as HH[MM[SS]] (left to right)
      hour = Math.min(23, parseInt(val.substring(0, 2)) || 0);
      if (val.length >= 3) minute = Math.min(59, parseInt(val.substring(2, 4)) || 0);
      if (val.length >= 5) second = Math.min(59, parseInt(val.substring(4, 6)) || 0);
    }
    // Only update clock hands — don't touch input.value (keeps cursor intact)
    _updateClockHands();
  });

  // ── Keyboard ──
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    if (e.key === 'Tab' && !onCommit) { e.preventDefault(); commit(); moveToNextCell(anchorEl); }
  });

  popover.querySelector('#clock-btn-ok').addEventListener('click', commit);
  popover.querySelector('#clock-btn-cancel').addEventListener('click', cancel);

  function commit() {
    const newVal = input.value.match(/^(\d{2}):(\d{2}):(\d{2})$/)
      ? input.value
      : `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}`;
    if (newVal !== currentVal) {
      if (onCommit) {
        onCommit(newVal);
      } else {
        appState.flights[idx][col] = newVal;
        appState.modified = true;
        if (col === 'LandingTime' || col === 'OffBlockTime') autoSort();
      }
    }
    closePopover();
  }

  function cancel() {
    closePopover();
  }

  function closePopover() {
    overlay.remove();
    appState.editingWidget = null;
    if (!onCommit) {
      anchorEl.innerHTML = appState.flights[idx][col] || '';
      renderAllSections();
    }
  }

  // ── Position popover ──
  const anchorRect = anchorEl.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const popW = 300, popH = 380;

  let left = anchorRect.left + anchorRect.width / 2 - popW / 2;
  let top = anchorRect.bottom + 6;
  if (top + popH > vh - 20) top = anchorRect.top - popH - 6;
  if (left < 10) left = 10;
  if (left + popW > vw - 10) left = vw - popW - 10;

  popover.style.left = left + 'px';
  popover.style.top = top + 'px';

  appState.editingWidget = { col, idx, widget: overlay, popover: true };

  document.body.appendChild(overlay);
  setTimeout(() => popover.classList.add('show'), 10);
  input.focus();
  input.select();
}

function buildTickMarks(cx, cy, r) {
  let html = '';
  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 - 90) * Math.PI / 180;
    const inner = r - 10;
    const x1 = cx + inner * Math.cos(angle);
    const y1 = cy + inner * Math.sin(angle);
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    html += `<line class="clock-tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    // Number
    const numR = r - 22;
    const nx = cx + numR * Math.cos(angle);
    const ny = cy + numR * Math.sin(angle) + 5;
    const num = i === 0 ? 12 : i;
    html += `<text class="clock-num" x="${nx}" y="${ny}">${num}</text>`;
  }
  // Minor ticks (each minute)
  for (let i = 0; i < 60; i++) {
    if (i % 5 === 0) continue;
    const angle = (i * 6 - 90) * Math.PI / 180;
    const inner = r - 5;
    const x1 = cx + inner * Math.cos(angle);
    const y1 = cy + inner * Math.sin(angle);
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    html += `<line class="clock-tick-minor" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
  }
  return html;
}

function startCellEdit(td, col, idx) {
  let currentVal;
  // Derived fields: AirlineCode & FlightNum are stored in CallSign
  if (col === 'AirlineCode') {
    currentVal = (appState.flights[idx].CallSign || '').substring(0, 3);
  } else if (col === 'FlightNum') {
    currentVal = (appState.flights[idx].CallSign || '').substring(3);
  } else {
    currentVal = appState.flights[idx][col] || '';
  }

  // ── Time fields → clock popover ──
  if (TIME_FIELDS.has(col)) {
    openTimeClockPopover(td, col, idx, currentVal);
    return;
  }

  const values = appState.airportValues[appState.currentAirport] || {};
  const compat = values._compat || { airlineToAircraft: {}, aircraftToAirline: {} };
  const audioData = appState.audioCallsigns;
  const currentAirlineCode = (appState.flights[idx].CallSign || '').substring(0, 3);
  let widget;
  let dropdownValues;

  if (col === 'FlightNum' && audioData.allAirlines.length > 0) {
    // ── FlightNum with audio: show dropdown of available numbers for current airline ──
    const availNums = audioData.byAirline[currentAirlineCode] || [];
    if (availNums.length > 0) {
      dropdownValues = [...availNums];
      // Include current value if it's valid and not already in the list
      if (currentVal && !dropdownValues.includes(currentVal)) {
        dropdownValues.push(currentVal);
      }
      widget = document.createElement('select');
      widget.className = 'cell-widget';
      widget.innerHTML = dropdownValues.map(v =>
        `<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${v}</option>`
      ).join('');
    } else {
      // Current airline has no audio → text input
      widget = document.createElement('input');
      widget.type = 'text';
      widget.className = 'cell-widget';
      widget.value = currentVal;
    }
  } else if (col === 'AirlineCode') {
    // ── AirlineCode: show all codes from ACL, mark ones with audio ──
    const aclCodes = values['AirlineCode'] || [];
    const hasAudio = audioData.allAirlines.length > 0;
    if (hasAudio) {
      // Sort: airlines with audio first, then rest alphabetically
      const withAudio = new Set(audioData.allAirlines);
      aclCodes.sort((a, b) => {
        const aHas = withAudio.has(a) ? 0 : 1;
        const bHas = withAudio.has(b) ? 0 : 1;
        if (aHas !== bHas) return aHas - bHas;
        return a.localeCompare(b);
      });
    }
    dropdownValues = aclCodes;
    widget = document.createElement('select');
    widget.className = 'cell-widget';
    widget.innerHTML = dropdownValues.map(v => {
      const audioMark = audioData.allAirlines.includes(v) ? ' \u{1F399}' : ''; // 🎙 for airlines with audio
      return `<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${v}${audioMark}</option>`;
    }).join('');
    if (currentVal && !dropdownValues.includes(currentVal)) {
      const audioMark = audioData.allAirlines.includes(currentVal) ? ' \u{1F399}' : '';
      widget.innerHTML += `<option value="${escapeHtml(currentVal)}" selected>${currentVal}${audioMark}</option>`;
    }
  } else if (col === 'AircraftType') {
    const acCode = (appState.flights[idx].CallSign || '').substring(0, 3);
    const validTypes = acCode ? (compat.airlineToAircraft[acCode] || null) : null;
    dropdownValues = validTypes
      ? validTypes.filter(t => (values['AircraftType'] || []).includes(t))
      : (values['AircraftType'] || []);
  } else {
    dropdownValues = values[col] || [];
  }

  if (widget) {
    // widget already created above (FlightNum with audio or AirlineCode)
  } else if (DROPDOWN_FIELDS.has(col) && dropdownValues.length > 0) {
    widget = document.createElement('select');
    widget.className = 'cell-widget';
    widget.innerHTML = dropdownValues.map(v =>
      `<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${v}</option>`
    ).join('');
    if (currentVal && !dropdownValues.includes(currentVal)) {
      widget.innerHTML += `<option value="${escapeHtml(currentVal)}" selected>${currentVal}</option>`;
    }
  } else {
    widget = document.createElement('input');
    widget.type = 'text';
    widget.className = 'cell-widget';
    widget.value = currentVal;
  }

  td.innerHTML = '';
  td.appendChild(widget);
  appState.editingWidget = { td, col, idx, widget };
  widget.focus();
  if (widget.tagName === 'INPUT') widget.select();

  const finish = (commit) => {
    const newVal = (widget.tagName === 'SELECT') ? widget.value : widget.value.trim();
    if (commit && newVal !== currentVal) {
      if (col === 'AirlineCode') {
        // Update both AirlineName (data field) and CallSign prefix
        appState.flights[idx].AirlineName = newVal;
        const oldCs = appState.flights[idx].CallSign || '';
        const oldNum = oldCs.substring(3);
        const audioData = appState.audioCallsigns;
        appState.flights[idx].CallSign = newVal.substring(0, 3) + oldNum;
        // If audio data exists: if old flight number not valid for new airline, auto-pick first available
        if (audioData.allAirlines.length > 0) {
          const availNums = audioData.byAirline[newVal];
          if (availNums && availNums.length > 0 && !availNums.includes(oldNum)) {
            appState.flights[idx].CallSign = newVal.substring(0, 3) + availNums[0];
          }
        }
        // Auto-clear AircraftType to null if no longer compatible with new airline
        const currType = appState.flights[idx].AircraftType || '';
        if (currType) {
          const compatTypes = compat.airlineToAircraft[newVal];
          if (compatTypes && !compatTypes.includes(currType)) {
            appState.flights[idx].AircraftType = null;
          }
        }
      } else if (col === 'FlightNum') {
        const cs = appState.flights[idx].CallSign || '';
        appState.flights[idx].CallSign = cs.substring(0, 3) + newVal;
      } else {
        appState.flights[idx][col] = newVal;
      }
      appState.modified = true;
      if (col === 'LandingTime' || col === 'OffBlockTime') autoSort();
    }
    // For derived fields, show the updated CallSign-derived value
    if (col === 'AirlineCode') {
      td.innerHTML = (appState.flights[idx].CallSign || '').substring(0, 3);
    } else if (col === 'FlightNum') {
      td.innerHTML = (appState.flights[idx].CallSign || '').substring(3);
    } else {
      td.innerHTML = appState.flights[idx][col] || '';
    }
    appState.editingWidget = null;
    renderAllSections();
  };

  widget.addEventListener('change', () => finish(true));
  widget.addEventListener('blur', () => finish(true));
  widget.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    if (e.key === 'Tab') { e.preventDefault(); finish(true); moveToNextCell(td); }
  });
}

function moveToNextCell(currentTd) {
  const allTds = [...document.querySelectorAll('#sections-container td')];
  const i = allTds.indexOf(currentTd);
  if (i >= 0 && i < allTds.length - 1) {
    setTimeout(() => {
      const next = allTds[i + 1];
      const col = next.dataset.col;
      const fi = parseInt(next.dataset.idx);
      startCellEdit(next, col, fi);
    }, 50);
  }
}

// ─── Add Arrival Flight ──────────────────────────────────
document.getElementById('btn-add-arrival').addEventListener('click', addArrivalFlight);

function addArrivalFlight() {
  const values = appState.airportValues[appState.currentAirport] || {};
  const audioData = appState.audioCallsigns;
  const newFlight = {};
  for (const [fn] of ALL_FIELDS) newFlight[fn] = '';

  // CallSign = airline code + sequential number (prefer airlines with audio clips)
  let airlineCode = 'NEW';
  if (audioData.allAirlines.length > 0) {
    airlineCode = audioData.allAirlines[0];
  } else if (values.AirlineName && values.AirlineName.length > 0) {
    airlineCode = getAirlineCode(values.AirlineName[0]);
  }
  newFlight.CallSign = airlineCode + String(nextFlightNumber++).padStart(4, '0');
  newFlight.ArrivalAirport = appState.currentAirport || '';

  // Placeholder values for arrivals
  newFlight.LandingTime = '06:00:00';
  newFlight.InBlockTime = '06:05:00';
  if (values.AircraftType && values.AircraftType.length > 0) newFlight.AircraftType = values.AircraftType[0];
  if (values.AirlineName && values.AirlineName.length > 0) newFlight.AirlineName = values.AirlineName[0];
  if (values.Stand && values.Stand.length > 0) newFlight.Stand = values.Stand[0];
  if (values.Runway && values.Runway.length > 0) newFlight.Runway = values.Runway[0];

  appState.flights.push(newFlight);
  appState.modified = true;
  appState.selectedIndices = new Set([appState.flights.length - 1]);
  renderAllSections();
  showToast('已添加进港航班 ' + newFlight.CallSign, 'success');
}

// ─── Add Departure Flight ────────────────────────────────
document.getElementById('btn-add-departure').addEventListener('click', addDepartureFlight);

function addDepartureFlight() {
  const values = appState.airportValues[appState.currentAirport] || {};
  const audioData = appState.audioCallsigns;
  const newFlight = {};
  for (const [fn] of ALL_FIELDS) newFlight[fn] = '';

  // CallSign = airline code + sequential number (prefer airlines with audio clips)
  let airlineCode = 'NEW';
  if (audioData.allAirlines.length > 0) {
    airlineCode = audioData.allAirlines[0];
  } else if (values.AirlineName && values.AirlineName.length > 0) {
    airlineCode = getAirlineCode(values.AirlineName[0]);
  }
  newFlight.CallSign = airlineCode + String(nextFlightNumber++).padStart(4, '0');
  newFlight.DepartureAirport = appState.currentAirport || '';

  // Placeholder values for departures
  newFlight.OffBlockTime = '06:00:00';
  newFlight.TakeoffTime = '06:05:00';
  if (values.AircraftType && values.AircraftType.length > 0) newFlight.AircraftType = values.AircraftType[0];
  if (values.AirlineName && values.AirlineName.length > 0) newFlight.AirlineName = values.AirlineName[0];
  if (values.Stand && values.Stand.length > 0) newFlight.Stand = values.Stand[0];
  if (values.Runway && values.Runway.length > 0) newFlight.Runway = values.Runway[0];

  appState.flights.push(newFlight);
  appState.modified = true;
  appState.selectedIndices = new Set([appState.flights.length - 1]);
  renderAllSections();
  showToast('已添加离港航班 ' + newFlight.CallSign, 'success');
}

// ─── Delete Selected ─────────────────────────────────────
document.getElementById('btn-delete-selected').addEventListener('click', deleteSelected);

function deleteSelected() {
  if (appState.selectedIndices.size === 0) { showToast('请先勾选要删除的航班', 'error'); return; }

  const indices = [...appState.selectedIndices].sort((a, b) => b - a); // reverse order
  const names = indices.map(i => appState.flights[i].CallSign || '#' + (i + 1));

  showModal('确认删除', `<p>确定要删除以下 <strong>${indices.length}</strong> 个航班吗？</p>
    <p style="font-size:12px;color:var(--text-muted);max-height:120px;overflow-y:auto;word-break:break-all">
      ${names.map(n => escapeHtml(n)).join(', ')}
    </p>
    <p style="font-size:11px;color:var(--red)">此操作不可撤销。</p>`,
    `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-danger" id="modal-confirm">删除 ${indices.length} 个</button>`);
  document.getElementById('modal-cancel').onclick = hideModal;
  document.getElementById('modal-confirm').onclick = () => {
    hideModal();
    for (const idx of indices) {
      appState.flights.splice(idx, 1);
    }
    appState.selectedIndices = new Set();
    appState.highlightedIdx = -1;
    autoSort();
    appState.modified = true;
    renderAllSections();
    showToast(`已删除 ${indices.length} 个航班`, 'success');
  };
}

// ─── Delete All ──────────────────────────────────────────
document.getElementById('btn-delete-all').addEventListener('click', deleteAll);

function deleteAll() {
  if (appState.flights.length === 0) { showToast('没有航班可删除', 'error'); return; }
  const count = appState.flights.length;
  showModal('确认全部删除', `<p>确定要删除全部 <strong>${count}</strong> 个航班吗？此操作不可撤销。</p>`,
    `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-danger" id="modal-confirm">全部删除</button>`);
  document.getElementById('modal-cancel').onclick = hideModal;
  document.getElementById('modal-confirm').onclick = () => {
    hideModal();
    appState.flights = [];
    appState.highlightedIdx = -1;
    appState.selectedIndices = new Set();
    appState.modified = true;
    // Expand all sections so the user can see new flights added after delete-all
    document.querySelectorAll('.section-block').forEach(s => {
      s.classList.remove('collapsed');
      const arrow = s.querySelector('.collapse-arrow');
      if (arrow) arrow.textContent = '▾';
    });
    renderAllSections();
    showToast(`已删除全部 ${count} 个航班`, 'success');
  };
}

// ─── Copy Row (highlight → copy → insert below, new row highlighted) ──
document.getElementById('btn-copy').addEventListener('click', copyHighlighted);

function copyHighlighted() {
  if (appState.highlightedIdx < 0) { showToast('请先点击选择要复制的航班', 'error'); return; }
  const idx = appState.highlightedIdx;
  const source = appState.flights[idx];
  const copy = { ...source };
  copy.CallSign = (source.CallSign || '') + '_CP';
  // Insert right below the highlighted row
  appState.flights.splice(idx + 1, 0, copy);
  appState.highlightedIdx = idx + 1; // highlight the new row
  appState.modified = true;
  renderAllSections();
  showToast('已复制航班，插入到下方', 'success');
}

// ─── SAVE with validation ────────────────────────────────
document.getElementById('btn-save').addEventListener('click', handleSave);

function validateCallsigns() {
  const seen = new Map();
  const dupes = [];
  appState.flights.forEach((fl, i) => {
    const cs = (fl.CallSign || '').trim();
    if (!cs) return;
    if (seen.has(cs)) {
      if (!dupes.includes(cs)) dupes.push(cs);
    } else {
      seen.set(cs, i);
    }
  });
  return dupes;
}

async function handleSave() {
  if (!appState.currentPath) { showToast('没有打开的文件', 'error'); return; }
  if (appState.flights.length === 0) { showToast('没有航班数据可保存', 'error'); return; }

  // Validate callsign uniqueness
  const dupes = validateCallsigns();
  if (dupes.length > 0) {
    showAlert('呼号重复', `以下呼号出现了多次，请修正后再保存：<br><br>
      ${dupes.map(d => `<strong>${escapeHtml(d)}</strong>`).join('<br>')}
      <br><br><span style="color:var(--red)">保存已取消。</span>`);
    return;
  }

  try {
    // 1) Save ACL
    const result = await window.electronAPI.saveAcl({
      filePath: appState.currentPath,
      flights: appState.flights,
      before: appState.before,
      after: appState.after,
      arrayContent: appState.arrayContent,
      originalBlocks: appState.originalBlocks,
      worldStateData: appState.worldStateData,
      sceneryMaps: appState.sceneryMaps,
      _fromWorldState: appState._fromWorldState,
      _rawText: appState._rawText,
    });

    if (!result.success) {
      showAlert('保存失败', result.error || '未知错误');
      return;
    }

    // 2) Save timelines (weather, wind, runway)
    const tlErrors = [];
    if (appState.weatherPath && appState.timelineModified.weather) {
      const wr = await window.electronAPI.saveWeatherTimeline({ filePath: appState.weatherPath, data: appState.weatherTimeline });
      if (!wr.success) tlErrors.push('天气: ' + wr.error);
      else appState.timelineModified.weather = false;
    }
    if (appState.windPath && appState.timelineModified.wind) {
      const wr = await window.electronAPI.saveWindTimeline({ filePath: appState.windPath, data: appState.windTimeline });
      if (!wr.success) tlErrors.push('风力: ' + wr.error);
      else appState.timelineModified.wind = false;
    }
    if (appState.runwayTimelinePath && appState.timelineModified.runway) {
      const rr = await window.electronAPI.saveRunwayTimeline({ filePath: appState.runwayTimelinePath, data: appState.runwayTimeline });
      if (!rr.success) tlErrors.push('跑道: ' + rr.error);
      else appState.timelineModified.runway = false;
    }

    appState.modified = false;
    updateStatusBar();
    renderAllSections();

    const tlMsg = tlErrors.length > 0
      ? `<br><br><span style="color:var(--orange)">时间线保存警告：${tlErrors.join(', ')}</span>`
      : '';
    const csvMsg = result.csvSynced
      ? `<p style="font-size:12px;color:var(--green)">CSV 航班表已同步更新（游戏将读取最新数据）</p>`
      : '';
    showModal('保存成功', `
      <p>文件已成功保存。</p>
      ${tlMsg}
      ${csvMsg}
      <p style="font-size:12px;color:var(--text-muted)">自动备份已生成在相同目录下：</p>
      <code>${result.backupPath}</code>
    `, `<button class="btn-confirm" id="modal-ok">确定</button>`);
    document.getElementById('modal-ok').onclick = hideModal;
  } catch (err) {
    showAlert('保存失败', err.message);
  }
}

// ─── SAVE AS ─────────────────────────────────────────────
document.getElementById('btn-save-as').addEventListener('click', handleSaveAs);

async function handleSaveAs() {
  if (appState.flights.length === 0) { showToast('没有航班数据', 'error'); return; }

  const result = await window.electronAPI.saveAsAcl({
    flights: appState.flights,
    before: appState.before,
    after: appState.after,
    arrayContent: appState.arrayContent,
    originalBlocks: appState.originalBlocks,
    worldStateData: appState.worldStateData,
    sceneryMaps: appState.sceneryMaps,
    _fromWorldState: appState._fromWorldState,
    _rawText: appState._rawText,
    suggestedName: appState.currentPath ? appState.currentPath.split(/[/\\]/).pop() : 'edited_level.acl',
  });

  if (result.canceled) return;
  if (result.error) { showAlert('保存失败', result.error); return; }

  appState.currentPath = result.path;
  appState.modified = false;
  updateStatusBar();
  renderAllSections();
  showToast('已另存为: ' + result.path.split(/[/\\]/).pop(), 'success');
}

// ─── MANUAL BACKUP ───────────────────────────────────────
document.getElementById('btn-backup-only').addEventListener('click', handleManualBackup);

async function handleManualBackup() {
  if (!appState.currentPath) { showToast('没有打开的文件', 'error'); return; }

  const result = await window.electronAPI.manualBackup(appState.currentPath);
  if (result.canceled) return;
  if (result.error) { showAlert('备份失败', result.error); return; }

  showToast('备份已保存: ' + result.path.split(/[/\\]/).pop(), 'success');
}

// ─── EXPORT CSV ──────────────────────────────────────────
document.getElementById('btn-export-csv').addEventListener('click', handleExportCsv);

async function handleExportCsv() {
  if (appState.flights.length === 0) { showToast('没有航班数据可导出', 'error'); return; }

  const defaultPath = appState.currentPath
    ? appState.currentPath.replace(/\.acl$/i, '.csv')
    : 'flights.csv';

  const result = await window.electronAPI.exportCSV({
    flights: appState.flights,
    defaultPath,
  });
  if (result.success) {
    showToast('CSV 已导出', 'success');
  } else if (result.success === false) {
    showAlert('导出失败', result.error || '未知错误');
  }
}

// ─── CSV → ACL ──────────────────────────────────────────
document.getElementById('btn-csv-to-acl').addEventListener('click', handleCsvToAcl);

async function handleCsvToAcl() {
  const suggestedAclName = appState.currentPath
    ? appState.currentPath.split(/[/\\]/).pop()
    : 'generated_level.acl';

  const result = await window.electronAPI.csvToAcl({
    suggestedAclName,
    templatePath: appState.currentPath,  // optional: use current file's header as template
  });

  if (result.canceled) return;
  if (!result.success) { showAlert('生成失败', result.error); return; }

  showToast('ACL 已生成: ' + result.path.split(/[/\\]/).pop(), 'success');
}

// ─── IMPORT EXTERNAL ACL ─────────────────────────────────
document.getElementById('btn-import-acl').addEventListener('click', handleImportAcl);

async function handleImportAcl() {
  const result = await window.electronAPI.importAcl();
  if (result.canceled) return;
  if (result.error) { showAlert('导入失败', result.error); return; }

  appState.currentPath = result.path;
  appState.flights = result.flights;
  initFlightNumberCounter();
  appState.before = result.before;
  appState.after = result.after;
  appState.arrayContent = result.arrayContent;
  appState.originalBlocks = result.originalBlocks;
  appState.worldStateData = result.worldStateData || null;
  appState.sceneryMaps = result.sceneryMaps || null;
  appState._fromWorldState = result._fromWorldState || false;
  appState._rawText = result._rawText || '';
  appState.modified = true;
  appState.highlightedIdx = -1;
  appState.selectedIndices = new Set();
  appState.editingWidget = null;

  const parts = result.path.split(/[/\\]/);
  const levelsIdx = parts.indexOf('Levels');
  if (levelsIdx > 1) appState.currentAirport = parts[levelsIdx - 1];

  autoSort();
  renderAllSections();
  updateStatusBar();
  showToast(`已导入 ${result.flights.length} 个航班`, 'success');
}

window.electronAPI.onNavBrowser(() => {
  const hasAnyMod = appState.modified || appState.timelineModified.weather
    || appState.timelineModified.wind || appState.timelineModified.runway;
  if (appState.screen === 'editor' && hasAnyMod) {
    showModal('未保存的更改', '<p>当前文件有未保存的更改，确定要返回吗？</p>',
      `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-confirm" id="modal-confirm">放弃更改</button>`);
    document.getElementById('modal-cancel').onclick = hideModal;
    document.getElementById('modal-confirm').onclick = () => {
      hideModal();
      appState.modified = false;
      appState.timelineModified = { weather: false, wind: false, runway: false };
      appState.selectedIndices = new Set();
      showBrowser();
    };
  } else if (appState.screen === 'editor') {
    appState.selectedIndices = new Set();
    showBrowser();
  }
});

// ─── Collapsible Sections & Timeline Blocks ──────────────

document.getElementById('table-container').addEventListener('click', (e) => {
  // Timeline block collapse
  const embHdr = e.target.closest('.tl-embed-header');
  if (embHdr) {
    const block = embHdr.closest('.tl-embed-block');
    block.classList.toggle('collapsed');
    const arrow = embHdr.querySelector('.tl-embed-arrow');
    arrow.textContent = block.classList.contains('collapsed') ? '▸' : '▾';
    return;
  }

  // Flight section collapse
  const secHdr = e.target.closest('.collapse-header');
  if (secHdr) {
    const section = secHdr.closest('.section-block');
    section.classList.toggle('collapsed');
    const arrow = secHdr.querySelector('.collapse-arrow');
    arrow.textContent = section.classList.contains('collapsed') ? '▸' : '▾';
    return;
  }
});

// ─── Weather Editor ──────────────────────────────────────

const WEATHER_PRESETS = ['Sunny', 'FewCloudy', 'MidCloudy', 'PartlyCloudy', 'OvercastSky', 'AfterRain'];

function renderWeatherEditor() {
  const list = document.getElementById('weather-list');
  if (!list) return;

  list.innerHTML = appState.weatherTimeline.map((entry, i) => `
    <div class="tl-row" data-idx="${i}">
      <span class="tl-idx">${i + 1}</span>
      <select class="tl-select" data-field="preset" data-idx="${i}">
        ${WEATHER_PRESETS.map(p => `<option value="${p}" ${entry.preset === p ? 'selected' : ''}>${p}</option>`).join('')}
        ${!WEATHER_PRESETS.includes(entry.preset) ? `<option value="${entry.preset}" selected>${entry.preset}</option>` : ''}
      </select>
      <input class="tl-input tl-time-click" type="text" data-field="time" data-idx="${i}" value="${entry.time || ''}" placeholder="HH:MM:SS" readonly>
      <button class="tl-btn-del" data-idx="${i}" title="删除">X</button>
    </div>
  `).join('');

  // Event: preset change
  list.querySelectorAll('.tl-select').forEach(el => {
    el.addEventListener('change', () => {
      const i = parseInt(el.dataset.idx);
      appState.weatherTimeline[i].preset = el.value;
      appState.timelineModified.weather = true;
      updateTimelineStatus();
    });
  });

  // Weather time → clock popover
  list.querySelectorAll('.tl-time-click').forEach(el => {
    el.addEventListener('click', (e) => {
      if (appState.editingWidget) return;
      const i = parseInt(el.dataset.idx);
      openTimeClockPopover(el, '天气', i, el.value, (newVal) => {
        appState.weatherTimeline[i].time = newVal;
        appState.timelineModified.weather = true;
        updateTimelineStatus();
        renderWeatherEditor();
      });
    });
  });

  // Event: delete
  list.querySelectorAll('.tl-btn-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      appState.weatherTimeline.splice(i, 1);
      appState.timelineModified.weather = true;
      updateTimelineStatus();
      renderWeatherEditor();
    });
  });

  updateTimelineStatus();
}

document.getElementById('btn-weather-add').addEventListener('click', () => {
  // Add after last or at 06:00
  const lastTime = appState.weatherTimeline.length > 0
    ? appState.weatherTimeline[appState.weatherTimeline.length - 1].time : '06:00:00';
  appState.weatherTimeline.push({ preset: 'Sunny', time: lastTime });
  appState.timelineModified.weather = true;
  updateTimelineStatus();
  renderWeatherEditor();
});

// ─── Wind Editor ─────────────────────────────────────────

function renderWindEditor() {
  const list = document.getElementById('wind-list');
  if (!list) return;

  list.innerHTML = appState.windTimeline.map((entry, i) => `
    <div class="tl-row" data-idx="${i}">
      <span class="tl-idx">${i + 1}</span>
      <input class="tl-input tl-int" type="text" inputmode="numeric" data-field="direction" data-idx="${i}" value="${entry.direction || 0}">
      <span class="tl-label-sm">deg</span>
      <input class="tl-input tl-int" type="text" inputmode="numeric" data-field="speed" data-idx="${i}" value="${entry.speed || 0}">
      <span class="tl-label-sm">kt</span>
      <input class="tl-input tl-time-click" type="text" data-field="time" data-idx="${i}" value="${entry.time || ''}" placeholder="HH:MM:SS" readonly>
      <button class="tl-btn-del" data-idx="${i}" title="删除">X</button>
    </div>
  `).join('');

  list.querySelectorAll('.tl-input[data-field="direction"], .tl-input[data-field="speed"]').forEach(el => {
    el.addEventListener('change', () => {
      const i = parseInt(el.dataset.idx);
      const field = el.dataset.field;
      const val = parseInt(el.value) || 0;
      appState.windTimeline[i][field] = val;
      appState.timelineModified.wind = true;
      updateTimelineStatus();
    });
  });

  // Wind time → clock popover
  list.querySelectorAll('.tl-time-click').forEach(el => {
    el.addEventListener('click', (e) => {
      if (appState.editingWidget) return;
      const i = parseInt(el.dataset.idx);
      openTimeClockPopover(el, '风向', i, el.value, (newVal) => {
        appState.windTimeline[i].time = newVal;
        appState.timelineModified.wind = true;
        updateTimelineStatus();
        renderWindEditor();
      });
    });
  });

  list.querySelectorAll('.tl-btn-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      appState.windTimeline.splice(i, 1);
      appState.timelineModified.wind = true;
      updateTimelineStatus();
      renderWindEditor();
    });
  });

  updateTimelineStatus();
}

document.getElementById('btn-wind-add').addEventListener('click', () => {
  const lastTime = appState.windTimeline.length > 0
    ? appState.windTimeline[appState.windTimeline.length - 1].time : '06:00:00';
  appState.windTimeline.push({ direction: 180, speed: 5, time: lastTime });
  appState.timelineModified.wind = true;
  updateTimelineStatus();
  renderWindEditor();
});

// ─── Runway Editor ───────────────────────────────────────

function renderRunwayEditor() {
  const container = document.getElementById('runway-editor');
  if (!container) return;

  const rw = appState.runwayTimeline;
  const initialStr = (rw.initialRunways || []).join(', ');

  // Get known runways from airportValues or fallback to extracting from current flights
  const rwOptions = (appState.airportValues[appState.currentAirport]?.Runway) ||
    [...new Set(appState.flights.map(f => (f.Runway || '').trim()).filter(Boolean))];

  container.innerHTML = `
    <div class="rw-section">
      <div class="rw-section-title">初始跑道</div>
      <div class="rw-initial-row">
        <input id="rw-initial-input" class="tl-input" type="text" value="${escapeHtml(initialStr)}" placeholder="如: 4L, 4R, 31L, 31R">
        <button id="btn-rw-initial-save" class="btn-sm">应用</button>
      </div>
    </div>
    <div class="rw-section">
      <div class="rw-section-title">跑道变更时间线 <button id="btn-rw-change-add" class="btn-sm">+ 添加变更</button></div>
      <div id="rw-changes-list">
        ${(rw.timeline || []).map((tle, i) => `
          <div class="rw-change-card">
            <div class="rw-change-header">
              <span class="tl-idx">变更 ${i + 1}</span>
              <input class="tl-input rw-time-input" type="text" data-idx="${i}" data-field="time" value="${tle.time || ''}" placeholder="HH:MM:SS">
              <button class="tl-btn-del" data-idx="${i}" title="删除此变更">X</button>
            </div>
            <div class="rw-change-pairs">
              ${(tle.changes || []).map((ch, j) => `
                <div class="rw-pair">
                  <span class="rw-pair-label">从</span>
                  <select class="tl-select rw-pair-input" data-tli="${i}" data-idx="${j}" data-field="source">
                    <option value="">—</option>
                    ${rwOptions.map(v => `<option value="${escapeHtml(v)}" ${ch.source === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                  </select>
                  <span>&rarr;</span>
                  <span class="rw-pair-label">到</span>
                  <select class="tl-select rw-pair-input" data-tli="${i}" data-idx="${j}" data-field="dest">
                    <option value="">—</option>
                    ${rwOptions.map(v => `<option value="${escapeHtml(v)}" ${ch.dest === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                  </select>
                  <button class="tl-btn-del-sm" data-tli="${i}" data-idx="${j}" title="删除此对">&times;</button>
                </div>
              `).join('')}
              <button class="btn-sm rw-add-pair" data-tli="${i}">+ 添加跑道对</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Initial runways save
  document.getElementById('btn-rw-initial-save').addEventListener('click', () => {
    const val = document.getElementById('rw-initial-input').value;
    appState.runwayTimeline.initialRunways = val.split(',').map(s => s.trim()).filter(Boolean);
    appState.timelineModified.runway = true;
    updateTimelineStatus();
  });

  // Change time
  container.querySelectorAll('.rw-time-input').forEach(el => {
    el.addEventListener('change', () => {
      const i = parseInt(el.dataset.idx);
      appState.runwayTimeline.timeline[i].time = el.value;
      appState.timelineModified.runway = true;
      updateTimelineStatus();
    });
  });

  // Pair fields
  container.querySelectorAll('.rw-pair-input').forEach(el => {
    el.addEventListener('change', () => {
      const tli = parseInt(el.dataset.tli);
      const idx = parseInt(el.dataset.idx);
      const field = el.dataset.field;
      appState.runwayTimeline.timeline[tli].changes[idx][field] = el.value;
      appState.timelineModified.runway = true;
      updateTimelineStatus();
    });
  });

  // Delete pair
  container.querySelectorAll('.tl-btn-del-sm').forEach(btn => {
    btn.addEventListener('click', () => {
      const tli = parseInt(btn.dataset.tli);
      const idx = parseInt(btn.dataset.idx);
      appState.runwayTimeline.timeline[tli].changes.splice(idx, 1);
      appState.timelineModified.runway = true;
      updateTimelineStatus();
      renderRunwayEditor();
    });
  });

  // Delete change card
  container.querySelectorAll('.rw-change-card .tl-btn-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      appState.runwayTimeline.timeline.splice(i, 1);
      appState.timelineModified.runway = true;
      updateTimelineStatus();
      renderRunwayEditor();
    });
  });

  // Add pair button
  container.querySelectorAll('.rw-add-pair').forEach(btn => {
    btn.addEventListener('click', () => {
      const tli = parseInt(btn.dataset.tli);
      appState.runwayTimeline.timeline[tli].changes.push({ source: '', dest: '' });
      appState.timelineModified.runway = true;
      updateTimelineStatus();
      renderRunwayEditor();
    });
  });

  // Add change button
  document.getElementById('btn-rw-change-add').addEventListener('click', () => {
    appState.runwayTimeline.timeline.push({ time: '12:00:00', changes: [] });
    appState.timelineModified.runway = true;
    updateTimelineStatus();
    renderRunwayEditor();
  });

  updateTimelineStatus();
}

// ─── Timeline Status Dot ─────────────────────────────────

function updateTimelineStatus() {
  // No visual dot indicators — kept as hook for future use
}

// ─── Updated Editor Status Bar ───────────────────────────

function updateStatusBar() {
  const fp = appState.currentPath;
  document.getElementById('editor-filename').textContent = fp ? stripSuffixes(fp.split(/[/\\]/).pop()) : '—';
  document.getElementById('editor-airport').textContent = appState.currentAirport || '';

  let arr = 0, dep = 0;
  appState.flights.forEach(fl => {
    if ((fl.LandingTime || '').trim()) arr++;
    if ((fl.OffBlockTime || '').trim()) dep++;
  });
  document.getElementById('flight-stats').innerHTML = `
    <span class="stat-item"><span class="stat-dot arrival"></span>进港 ${arr}</span>
    <span class="stat-item"><span class="stat-dot departure"></span>离港 ${dep}</span>
    <span>总计 ${appState.flights.length}</span>
  `;
}

// ─── Updated Back (check timeline too) ───────────────────

document.getElementById('btn-back').addEventListener('click', () => {
  const hasAnyMod = appState.modified || appState.timelineModified.weather
    || appState.timelineModified.wind || appState.timelineModified.runway;
  if (hasAnyMod) {
    showModal('未保存的更改', '<p>当前文件有未保存的更改（航班或时间线），确定要返回关卡列表吗？</p>',
      `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-confirm" id="modal-confirm">放弃更改</button>`);
    document.getElementById('modal-cancel').onclick = hideModal;
    document.getElementById('modal-confirm').onclick = () => {
      hideModal();
      appState.modified = false;
      appState.timelineModified = { weather: false, wind: false, runway: false };
      showBrowser();
    };
  } else {
    showBrowser();
  }
});

// ─── Keyboard Shortcuts (no change) ──────────────────────
document.addEventListener('keydown', (e) => {
  if (appState.screen !== 'editor') return;
  if (appState.editingWidget) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && e.key === 'N') { e.preventDefault(); addDepartureFlight(); }
  else if (mod && e.key === 's') { e.preventDefault(); handleSave(); }
  else if (mod && e.key === 'n') { e.preventDefault(); addArrivalFlight(); }
  else if (mod && e.key === 'b') { e.preventDefault(); showBrowser(); }
  else if (mod && e.key === 'd') { e.preventDefault(); copyHighlighted(); }
  else if (e.key === 'Delete') { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'Escape') {
    appState.highlightedIdx = -1;
    appState.selectedIndices = new Set();
    renderAllSections();
  }
});

// ─── Root Path Persistence (via localStorage, no extra file) ──
function getLastRootLocal() {
  try { return localStorage.getItem('ac27_lastRoot'); } catch (_) { return null; }
}
function saveLastRootLocal(rootPath) {
  try { localStorage.setItem('ac27_lastRoot', rootPath); } catch (_) {}
}

// ─── Init ────────────────────────────────────────────────
(async function init() {
  const lastRoot = getLastRootLocal();
  if (lastRoot) {
    const scan = await window.electronAPI.scanAcls(lastRoot);
    if (!scan.error && scan.totalFiles > 0) {
      appState.rootPath = lastRoot;
      appState.airports = scan.airports || [];
      showBrowser();
      return;
    }
  }
  showScreen('setup');
})();
