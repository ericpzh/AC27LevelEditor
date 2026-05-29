// ─── Constants ──────────────────────────────────────────
const FIELDS = [
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
  ['Voice', 'string'],
  ['Language', 'string'],
];

const FIELD_LABELS = {
  CallSign: '呼号', DepartureAirport: '出发', ArrivalAirport: '到达',
  Stand: '停机位', Runway: '跑道', OffBlockTime: '推出', TakeoffTime: '起飞',
  LandingTime: '落地', InBlockTime: '入位', AirlineName: '航司',
  AircraftType: '机型', Voice: '语音', Language: '语言',
};

const DROPDOWN_FIELDS = new Set([
  'AircraftType', 'AirlineName', 'Voice', 'Language',
  'Stand', 'Runway', 'DepartureAirport', 'ArrivalAirport',
]);

const COL_CLASSES = {
  '#': 'col-num', CallSign: 'col-callsign', DepartureAirport: 'col-dep',
  ArrivalAirport: 'col-arr', Stand: 'col-stand', Runway: 'col-runway',
  OffBlockTime: 'col-time', TakeoffTime: 'col-time', LandingTime: 'col-time',
  InBlockTime: 'col-time', AirlineName: 'col-airline', AircraftType: 'col-ac',
  Voice: 'col-voice', Language: 'col-lang',
};

// ─── App State ──────────────────────────────────────────
let appState = {
  screen: 'setup',       // 'setup' | 'browser' | 'editor'
  rootPath: null,
  airports: [],
  airportValues: {},     // { [icao]: { AircraftType: [...], Voice: [...], ... } }
  // Editor state
  currentPath: null,
  currentAirport: null,  // ICAO of airport for dropdowns
  flights: [],
  before: '', after: '', arrayContent: '', originalBlocks: [],
  modified: false,
  selectedRows: new Set(),
  editingWidget: null,   // { td, col, idx, widget }
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
    document.getElementById('setup-error').textContent = '❌ ' + result.error;
    document.getElementById('setup-error').classList.remove('hidden');
    return;
  }

  document.getElementById('setup-error').classList.add('hidden');
  appState.rootPath = result.rootPath;
  appState.airports = result.airports || [];
  await window.electronAPI.saveLastRoot(result.rootPath);
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

  // If no airports loaded yet, scan
  if (appState.airports.length === 0 && appState.rootPath) {
    const scan = await window.electronAPI.scanAcls(appState.rootPath);
    if (!scan.error) appState.airports = scan.airports || [];
  }

  // Get file info for all airports (with flight counts)
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
    const totalFlights = infos.reduce((s, i) => s + (i.flightCount || 0), 0);

    const rows = infos.map(info => {
      if (info.error) {
        return `<div class="level-row" style="opacity:0.5">
          <span class="level-name">${info.filename}</span>
          <span class="level-stats" style="color:var(--red)">${info.error}</span>
        </div>`;
      }
      const sizeMB = (info.size / 1048576).toFixed(1);
      return `<div class="level-row" data-path="${escapeHtml(info.path)}" data-airport="${escapeHtml(airport.icao)}">
        <span class="level-name">${info.filename}</span>
        <span class="level-stats">
          <span class="level-stat"><span class="level-stat-dot arrival"></span>进港 ${info.arrivals || 0}</span>
          <span class="level-stat"><span class="level-stat-dot departure"></span>离港 ${info.departures || 0}</span>
          <span class="level-stat">✈ ${info.flightCount || 0}</span>
        </span>
        <span class="level-size">${sizeMB} MB</span>
        <span class="level-arrow">→</span>
      </div>`;
    }).join('');

    return `<div class="airport-card">
      <div class="airport-card-header">
        <span class="airport-icao">${airport.icao}</span>
        <span class="airport-file-count">${infos.length} 关卡 · ${totalFlights} 航班</span>
      </div>
      ${rows}
    </div>`;
  }).join('');

  // Click handlers on level rows
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

// ═══════════ SCREEN 2: EDITOR ══════════════════════════

async function openEditor(filePath, airportIcao) {
  showScreen('editor');
  document.getElementById('editor-filename').textContent = '加载中…';

  // Load the file
  const data = await window.electronAPI.loadAcl(filePath);
  if (!data.success) { showAlert('加载失败', data.error); return; }

  appState.currentPath = filePath;
  appState.currentAirport = airportIcao;
  appState.flights = data.flights;
  appState.before = data.before;
  appState.after = data.after;
  appState.arrayContent = data.arrayContent;
  appState.originalBlocks = data.originalBlocks;
  appState.modified = false;
  appState.selectedRows = new Set();
  appState.editingWidget = null;
  document.getElementById('search-input').value = '';
  document.getElementById('filter-type').value = 'all';

  // Load dropdown values for this airport if not cached
  if (appState.rootPath && airportIcao && !appState.airportValues[airportIcao]) {
    appState.airportValues[airportIcao] = await window.electronAPI.collectValues(appState.rootPath, airportIcao);
  }

  buildTableHead();
  autoSort();
  renderTable();
  updateStatusBar();

  document.getElementById('editor-filename').textContent = filePath.split(/[/\\]/).pop();
  document.getElementById('editor-airport').textContent = airportIcao || '';

  showToast(`已加载 ${data.flights.length} 个航班`, 'success');
}

// ─── Auto-sort: arrivals by LandingTime, departures by OffBlockTime ───
function autoSort() {
  const arrivals = [];
  const departures = [];
  const others = [];

  for (const fl of appState.flights) {
    if ((fl.LandingTime || '').trim()) {
      arrivals.push(fl);
    } else if ((fl.OffBlockTime || '').trim()) {
      departures.push(fl);
    } else {
      others.push(fl);
    }
  }

  arrivals.sort((a, b) => (a.LandingTime || '').localeCompare(b.LandingTime || ''));
  departures.sort((a, b) => (a.OffBlockTime || '').localeCompare(b.OffBlockTime || ''));

  appState.flights = [...arrivals, ...departures, ...others];
}

// ─── Table Headers ───────────────────────────────────────
function buildTableHead() {
  const thead = document.getElementById('table-head');
  const cols = ['#', ...FIELDS.map(f => f[0])];
  thead.innerHTML = cols.map(col => {
    const label = col === '#' ? '#' : (FIELD_LABELS[col] || col);
    const cls = COL_CLASSES[col] || '';
    return `<th class="${cls}" data-col="${col}">${label}</th>`;
  }).join('');
}

// ─── Render Table ────────────────────────────────────────
let filteredIndices = [];

function renderTable() {
  const tbody = document.getElementById('table-body');
  const emptyEl = document.getElementById('empty-editor');
  const searchTerm = document.getElementById('search-input').value.toLowerCase().trim();
  const filter = document.getElementById('filter-type').value;

  filteredIndices = [];
  appState.flights.forEach((fl, idx) => {
    if (filter === 'arrival' && !(fl.LandingTime || '').trim()) return;
    if (filter === 'departure' && !(fl.OffBlockTime || '').trim()) return;
    if (searchTerm) {
      const match = FIELDS.some(([fn]) => String(fl[fn] || '').toLowerCase().includes(searchTerm));
      if (!match) return;
    }
    filteredIndices.push(idx);
  });

  if (filteredIndices.length === 0) {
    emptyEl.classList.remove('hidden');
    tbody.innerHTML = '';
    updateStatusBar();
    return;
  }
  emptyEl.classList.add('hidden');

  tbody.innerHTML = filteredIndices.map(i => {
    const fl = appState.flights[i];
    const isArrival = !!(fl.LandingTime || '').trim();
    const isDeparture = !!(fl.OffBlockTime || '').trim();
    const rowClass = isArrival ? 'row-arrival' : (isDeparture ? 'row-departure' : '');
    const selClass = appState.selectedRows.has(i) ? ' selected' : '';
    const cells = [i + 1, ...FIELDS.map(([fn]) => fl[fn] || '')];
    return `<tr class="${rowClass}${selClass}" data-idx="${i}">
      ${cells.map((v, ci) => {
        const col = ci === 0 ? '#' : FIELDS[ci - 1][0];
        const cls = ci === 0 ? 'idx-cell' : (col === 'CallSign' ? 'callsign-cell' : '');
        return `<td class="${cls}" data-col="${col}" data-idx="${i}">${v}</td>`;
      }).join('')}
    </tr>`;
  }).join('');

  updateStatusBar();
}

function updateStatusBar() {
  const fp = appState.currentPath;
  document.getElementById('editor-filename').textContent = fp ? fp.split(/[/\\]/).pop() : '—';
  document.getElementById('editor-airport').textContent = appState.currentAirport || '';
  document.getElementById('modified-dot').classList.toggle('hidden', !appState.modified);

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

// ─── Cell Click → Edit ───────────────────────────────────
document.getElementById('table-body').addEventListener('click', (e) => {
  const td = e.target.closest('td');
  if (!td) return;
  if (appState.editingWidget) return; // already editing

  const col = td.dataset.col;
  const idx = parseInt(td.dataset.idx);
  if (col === '#') return;

  startCellEdit(td, col, idx);
});

function startCellEdit(td, col, idx) {
  const currentVal = appState.flights[idx][col] || '';
  const values = appState.airportValues[appState.currentAirport] || {};

  let widget;
  if (DROPDOWN_FIELDS.has(col) && values[col] && values[col].length > 0) {
    // Dropdown with custom value support
    widget = document.createElement('select');
    widget.className = 'cell-widget';
    widget.innerHTML = values[col].map(v =>
      `<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${v}</option>`
    ).join('');
    // Add the current value if it's not in the list
    if (currentVal && !values[col].includes(currentVal)) {
      widget.innerHTML += `<option value="${escapeHtml(currentVal)}" selected>${currentVal}</option>`;
    }
  } else {
    // Text input for times and other fields
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
      appState.flights[idx][col] = newVal;
      appState.modified = true;
      // Auto-sort if a time field changed
      if (col === 'LandingTime' || col === 'OffBlockTime') {
        autoSort();
      }
    }
    td.innerHTML = appState.flights[idx][col] || '';
    appState.editingWidget = null;
    renderTable();
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
  // Find next editable cell
  const allTds = [...document.querySelectorAll('#table-body td:not(.idx-cell)')];
  const idx = allTds.indexOf(currentTd);
  if (idx >= 0 && idx < allTds.length - 1) {
    const next = allTds[idx + 1];
    // Small delay to let render finish
    setTimeout(() => {
      const col = next.dataset.col;
      const fi = parseInt(next.dataset.idx);
      startCellEdit(next, col, fi);
    }, 50);
  }
}

// ─── Add / Delete / Duplicate ────────────────────────────
document.getElementById('btn-add').addEventListener('click', addFlight);
document.getElementById('btn-delete').addEventListener('click', deleteSelected);
document.getElementById('btn-duplicate').addEventListener('click', duplicateSelected);

function addFlight() {
  const values = appState.airportValues[appState.currentAirport] || {};
  const newFlight = {};
  for (const [fn] of FIELDS) newFlight[fn] = '';

  // Smart defaults from collected values
  newFlight.CallSign = 'NEW' + String(appState.flights.length + 1).padStart(4, '0');
  if (values.AircraftType && values.AircraftType.length > 0) newFlight.AircraftType = values.AircraftType[0];
  if (values.AirlineName && values.AirlineName.length > 0) newFlight.AirlineName = values.AirlineName[0];
  if (values.Voice && values.Voice.length > 0) newFlight.Voice = values.Voice[0];
  if (values.Language && values.Language.length > 0) newFlight.Language = values.Language[0];
  if (appState.currentAirport) {
    newFlight.ArrivalAirport = appState.currentAirport;
    newFlight.DepartureAirport = appState.currentAirport;
  }

  appState.flights.push(newFlight);
  appState.modified = true;
  renderTable();
  showToast('已添加航班', 'success');
}

function deleteSelected() {
  if (appState.selectedRows.size === 0) { showToast('请先选择要删除的航班', 'error'); return; }
  const count = appState.selectedRows.size;
  showModal('确认删除', `<p>确定要删除 ${count} 个航班吗？此操作不可撤销。</p>`,
    `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-danger" id="modal-confirm">删除</button>`);
  document.getElementById('modal-cancel').onclick = hideModal;
  document.getElementById('modal-confirm').onclick = () => {
    hideModal();
    const indices = [...appState.selectedRows].sort((a, b) => b - a);
    indices.forEach(i => appState.flights.splice(i, 1));
    appState.selectedRows.clear();
    appState.modified = true;
    renderTable();
    showToast(`已删除 ${count} 个航班`, 'success');
  };
}

function duplicateSelected() {
  if (appState.selectedRows.size === 0) { showToast('请先选择要复制的航班', 'error'); return; }
  const newFlights = [];
  [...appState.selectedRows].sort((a, b) => a - b).forEach(i => {
    const copy = { ...appState.flights[i] };
    copy.CallSign = (copy.CallSign || '') + '_CP';
    newFlights.push(copy);
  });
  appState.flights.push(...newFlights);
  appState.modified = true;
  renderTable();
  showToast(`已复制 ${appState.selectedRows.size} 个航班`, 'success');
}

// ─── Batch Operations ────────────────────────────────────
document.getElementById('btn-batch-callsign').addEventListener('click', batchCallsign);
document.getElementById('btn-batch-voice').addEventListener('click', batchVoice);
document.getElementById('btn-batch-lang').addEventListener('click', batchLanguage);

function batchCallsign() {
  showModal('批量生成呼号', `
    <label for="bm-prefix">前缀 (如 CCA)</label><input id="bm-prefix" value="CCA">
    <label for="bm-start">起始编号</label><input id="bm-start" type="number" value="1" min="1">
  `, `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-confirm" id="modal-confirm">确定</button>`);
  document.getElementById('modal-cancel').onclick = hideModal;
  document.getElementById('modal-confirm').onclick = () => {
    const prefix = document.getElementById('bm-prefix').value.trim();
    const start = parseInt(document.getElementById('bm-start').value) || 1;
    appState.flights.forEach((fl, i) => {
      fl.CallSign = `${prefix}${String(start + i).padStart(4, '0')}`;
    });
    appState.modified = true;
    hideModal();
    renderTable();
    showToast(`呼号: ${prefix}${String(start).padStart(4, '0')} ~ ${prefix}${String(start + appState.flights.length - 1).padStart(4, '0')}`, 'success');
  };
}

function batchVoice() {
  const values = appState.airportValues[appState.currentAirport] || {};
  const voices = values.Voice || [];
  const options = voices.map(v => `<option value="${escapeHtml(v)}">${v}</option>`).join('');
  showModal('批量设置语音', `
    <label for="bm-voice">语音包</label>
    <select id="bm-voice">${options}${!voices.length ? '<option>Yeager</option>' : ''}</select>
  `, `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-confirm" id="modal-confirm">确定</button>`);
  document.getElementById('modal-cancel').onclick = hideModal;
  document.getElementById('modal-confirm').onclick = () => {
    const voice = document.getElementById('bm-voice').value;
    appState.flights.forEach(fl => fl.Voice = voice);
    appState.modified = true;
    hideModal();
    renderTable();
    showToast(`已设置语音: ${voice}`, 'success');
  };
}

function batchLanguage() {
  const values = appState.airportValues[appState.currentAirport] || {};
  const langs = values.Language || ['en', 'zh'];
  const options = langs.map(l => `<option value="${escapeHtml(l)}">${l}</option>`).join('');
  showModal('批量设置语言', `
    <label for="bm-lang">语言代码</label>
    <select id="bm-lang">${options}</select>
  `, `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-confirm" id="modal-confirm">确定</button>`);
  document.getElementById('modal-cancel').onclick = hideModal;
  document.getElementById('modal-confirm').onclick = () => {
    const lang = document.getElementById('bm-lang').value;
    appState.flights.forEach(fl => fl.Language = lang);
    appState.modified = true;
    hideModal();
    renderTable();
    showToast(`已设置语言: ${lang}`, 'success');
  };
}

// ─── Search & Filter ─────────────────────────────────────
document.getElementById('search-input').addEventListener('input', () => renderTable());
document.getElementById('filter-type').addEventListener('change', () => renderTable());

// ─── SAVE ────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', handleSave);

async function handleSave() {
  if (!appState.currentPath) { showToast('没有打开的文件', 'error'); return; }
  if (appState.flights.length === 0) { showToast('没有航班数据可保存', 'error'); return; }

  try {
    const result = await window.electronAPI.saveAcl({
      filePath: appState.currentPath,
      flights: appState.flights,
      before: appState.before,
      after: appState.after,
      arrayContent: appState.arrayContent,
      originalBlocks: appState.originalBlocks,
    });

    if (result.success) {
      appState.modified = false;
      updateStatusBar();
      renderTable();

      // Show success with backup info
      showModal('保存成功', `
        <p>✅ 文件已成功保存。</p>
        <p style="font-size:12px;color:var(--text-muted)">自动备份已生成在相同目录下：</p>
        <code>${result.backupPath}</code>
      `, `<button class="btn-confirm" id="modal-ok">确定</button>`);
      document.getElementById('modal-ok').onclick = hideModal;
    } else {
      showAlert('保存失败', result.error || '未知错误');
    }
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
    suggestedName: appState.currentPath ? appState.currentPath.split(/[/\\]/).pop() : 'edited_level.acl',
  });

  if (result.canceled) return;
  if (result.error) { showAlert('保存失败', result.error); return; }

  appState.currentPath = result.path;
  appState.modified = false;
  updateStatusBar();
  renderTable();
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

// ─── IMPORT EXTERNAL ACL ─────────────────────────────────
document.getElementById('btn-import-acl').addEventListener('click', handleImportAcl);

async function handleImportAcl() {
  const result = await window.electronAPI.importAcl();
  if (result.canceled) return;
  if (result.error) { showAlert('导入失败', result.error); return; }

  // Override current data with imported
  appState.currentPath = result.path;
  appState.flights = result.flights;
  appState.before = result.before;
  appState.after = result.after;
  appState.arrayContent = result.arrayContent;
  appState.originalBlocks = result.originalBlocks;
  appState.modified = true;
  appState.selectedRows = new Set();
  appState.editingWidget = null;
  document.getElementById('search-input').value = '';
  document.getElementById('filter-type').value = 'all';

  // Try to determine airport from parent folder path
  const parts = result.path.split(/[/\\]/);
  const levelsIdx = parts.indexOf('Levels');
  if (levelsIdx > 1) appState.currentAirport = parts[levelsIdx - 1];

  autoSort();
  renderTable();
  updateStatusBar();
  showToast(`已导入 ${result.flights.length} 个航班`, 'success');
}

// ─── BACK button ─────────────────────────────────────────
document.getElementById('btn-back').addEventListener('click', () => {
  if (appState.modified) {
    showModal('未保存的更改', '<p>当前文件有未保存的更改，确定要返回关卡列表吗？</p>',
      `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-confirm" id="modal-confirm">放弃更改</button>`);
    document.getElementById('modal-cancel').onclick = hideModal;
    document.getElementById('modal-confirm').onclick = () => {
      hideModal();
      appState.modified = false;
      showBrowser();
    };
  } else {
    showBrowser();
  }
});

window.electronAPI.onNavBrowser(() => {
  if (appState.screen === 'editor' && appState.modified) {
    showModal('未保存的更改', '<p>当前文件有未保存的更改，确定要返回吗？</p>',
      `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-confirm" id="modal-confirm">放弃更改</button>`);
    document.getElementById('modal-cancel').onclick = hideModal;
    document.getElementById('modal-confirm').onclick = () => { hideModal(); appState.modified = false; showBrowser(); };
  } else if (appState.screen === 'editor') {
    showBrowser();
  }
});

// ─── Keyboard Shortcuts ──────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (appState.screen !== 'editor') return;
  if (appState.editingWidget) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 's') { e.preventDefault(); handleSave(); }
  if (mod && e.key === 'n') { e.preventDefault(); addFlight(); }
  if (mod && e.key === 'b') { e.preventDefault(); showBrowser(); }
  if (e.key === 'Delete') { e.preventDefault(); deleteSelected(); }
  if (e.key === 'Escape') {
    appState.selectedRows.clear();
    renderTable();
  }
});

// ─── Click outside to deselect ───────────────────────────
document.getElementById('table-body').addEventListener('click', function(e) {
  if (appState.editingWidget) return;
  const tr = e.target.closest('tr');
  if (!tr) return;
  const idx = parseInt(tr.dataset.idx);

  if (e.ctrlKey || e.metaKey) {
    if (appState.selectedRows.has(idx)) appState.selectedRows.delete(idx);
    else appState.selectedRows.add(idx);
  } else if (e.shiftKey && appState.selectedRows.size > 0) {
    const last = Math.max(...appState.selectedRows);
    const [from, to] = [Math.min(last, idx), Math.max(last, idx)];
    for (let i = from; i <= to; i++) {
      if (filteredIndices.includes(i)) appState.selectedRows.add(i);
    }
  } else {
    appState.selectedRows = new Set([idx]);
  }
  renderTable();
});

// ─── Init ────────────────────────────────────────────────
(async function init() {
  // Try to restore last game root
  const lastRoot = await window.electronAPI.getLastRoot();
  if (lastRoot) {
    // Try scanning it
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
