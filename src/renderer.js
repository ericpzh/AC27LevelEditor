// ─── State ─────────────────────────────────────────────
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

const COL_CLASSES = {
  '#': 'col-num', CallSign: 'col-callsign', DepartureAirport: 'col-dep',
  ArrivalAirport: 'col-arr', Stand: 'col-stand', Runway: 'col-runway',
  OffBlockTime: 'col-time', TakeoffTime: 'col-time', LandingTime: 'col-time',
  InBlockTime: 'col-time', AirlineName: 'col-airline', AircraftType: 'col-ac',
  Voice: 'col-voice', Language: 'col-lang',
};

let state = {
  aclPath: null,
  flights: [],
  before: '',
  after: '',
  arrayContent: '',
  originalBlocks: [],
  modified: false,
  selectedRows: new Set(),
  sortCol: null,
  sortAsc: true,
  editingCell: null,
};

// ─── Table Headers ──────────────────────────────────────
function buildTableHead() {
  const thead = document.getElementById('table-head');
  const cols = ['#', ...FIELDS.map(f => f[0])];
  thead.innerHTML = cols.map(col => {
    const label = col === '#' ? '#' : (FIELD_LABELS[col] || col);
    const cls = COL_CLASSES[col] || '';
    return `<th class="${cls}" data-col="${col}">${label}</th>`;
  }).join('');

  thead.querySelectorAll('th').forEach(th => {
    th.addEventListener('click', () => sortBy(th.dataset.col));
  });
}

// ─── Render Table ───────────────────────────────────────
let filteredIndices = [];

function renderTable() {
  const tbody = document.getElementById('table-body');
  const emptyState = document.getElementById('empty-state');
  const searchTerm = document.getElementById('search-input').value.toLowerCase().trim();
  const filter = document.getElementById('filter-type').value;

  // Build filtered index list
  filteredIndices = [];
  state.flights.forEach((fl, idx) => {
    if (filter === 'arrival' && !(fl.LandingTime || '').trim()) return;
    if (filter === 'departure' && !(fl.OffBlockTime || '').trim()) return;
    if (searchTerm) {
      const match = FIELDS.some(([fn]) => String(fl[fn] || '').toLowerCase().includes(searchTerm));
      if (!match) return;
    }
    filteredIndices.push(idx);
  });

  if (filteredIndices.length === 0 && !state.aclPath) {
    emptyState.classList.remove('hidden');
    tbody.innerHTML = '';
    return;
  }

  emptyState.classList.add('hidden');

  tbody.innerHTML = filteredIndices.map(i => {
    const fl = state.flights[i];
    const isArrival = !!(fl.LandingTime || '').trim();
    const isDeparture = !!(fl.OffBlockTime || '').trim();
    const rowClass = isArrival ? 'row-arrival' : (isDeparture ? 'row-departure' : '');
    const selClass = state.selectedRows.has(i) ? ' selected' : '';

    const cells = [i + 1, ...FIELDS.map(([fn]) => fl[fn] || '')];
    return `<tr class="${rowClass}${selClass}" data-idx="${i}">
      ${cells.map((v, ci) => {
        const col = ci === 0 ? '#' : FIELDS[ci - 1][0];
        const cls = ci === 0 ? 'idx-cell' : '';
        return `<td class="${cls}" data-col="${col}" data-idx="${i}">${v}</td>`;
      }).join('')}
    </tr>`;
  }).join('');

  updateStatusBar();
}

function updateStatusBar() {
  document.getElementById('file-path').textContent = state.aclPath
    ? state.aclPath.split(/[/\\]/).pop()
    : '未打开文件';

  document.getElementById('modified-dot').classList.toggle('hidden', !state.modified);

  let arrivals = 0, departures = 0;
  state.flights.forEach(fl => {
    if ((fl.LandingTime || '').trim()) arrivals++;
    if ((fl.OffBlockTime || '').trim()) departures++;
  });

  document.getElementById('flight-stats').innerHTML = `
    <span class="stat-item"><span class="stat-dot arrival"></span>进港 ${arrivals}</span>
    <span class="stat-item"><span class="stat-dot departure"></span>离港 ${departures}</span>
    <span>总计 ${state.flights.length}</span>
  `;
}

// ─── Row Selection ──────────────────────────────────────
document.getElementById('table-body').addEventListener('click', (e) => {
  const td = e.target.closest('td');
  if (!td) return;

  const tr = td.closest('tr');
  const idx = parseInt(tr.dataset.idx);

  // Ignore clicks during editing
  if (state.editingCell) return;

  if (e.ctrlKey || e.metaKey) {
    // Toggle selection
    if (state.selectedRows.has(idx)) {
      state.selectedRows.delete(idx);
    } else {
      state.selectedRows.add(idx);
    }
  } else if (e.shiftKey) {
    // Range select
    const indices = [...state.selectedRows];
    if (indices.length > 0) {
      const last = Math.max(...indices);
      const [from, to] = [Math.min(last, idx), Math.max(last, idx)];
      for (let i = from; i <= to; i++) {
        if (filteredIndices.includes(i)) state.selectedRows.add(i);
      }
    } else {
      state.selectedRows.add(idx);
    }
  } else {
    // Single select
    state.selectedRows.clear();
    state.selectedRows.add(idx);
  }

  refreshSelection();
});

// Double-click for inline editing
document.getElementById('table-body').addEventListener('dblclick', (e) => {
  const td = e.target.closest('td');
  if (!td) return;

  const col = td.dataset.col;
  const idx = parseInt(td.dataset.idx);
  if (col === '#') return;

  startInlineEdit(td, col, idx);
});

function refreshSelection() {
  document.querySelectorAll('#table-body tr').forEach(tr => {
    const idx = parseInt(tr.dataset.idx);
    tr.classList.toggle('selected', state.selectedRows.has(idx));
  });
}

// ─── Inline Editing ─────────────────────────────────────
function startInlineEdit(td, col, idx) {
  const fieldName = col;
  const currentVal = state.flights[idx][fieldName] || '';
  state.editingCell = { td, col, idx };

  const isLang = fieldName === 'Language';

  if (isLang) {
    const select = document.createElement('select');
    select.innerHTML = '<option value="en">en</option><option value="zh">zh</option>';
    select.value = ['en', 'zh'].includes(currentVal) ? currentVal : 'en';
    td.classList.add('editing');
    td.innerHTML = '';
    td.appendChild(select);
    select.focus();

    const finish = () => {
      const newVal = select.value;
      if (newVal !== currentVal) {
        state.flights[idx][fieldName] = newVal;
        state.modified = true;
      }
      td.classList.remove('editing');
      state.editingCell = null;
      renderTable();
    };

    select.addEventListener('change', finish);
    select.addEventListener('blur', finish);
    select.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(); });
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentVal;
    td.classList.add('editing');
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();

    const finish = () => {
      const newVal = input.value.trim();
      if (newVal !== currentVal) {
        state.flights[idx][fieldName] = newVal;
        state.modified = true;
      }
      td.classList.remove('editing');
      state.editingCell = null;
      renderTable();
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish();
      if (e.key === 'Escape') {
        input.value = currentVal;
        finish();
      }
    });
  }
}

// ─── Context Menu ───────────────────────────────────────
document.getElementById('table-body').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const tr = e.target.closest('tr');
  const menu = document.getElementById('context-menu');

  // If right-clicked on a row, select it
  if (tr) {
    const idx = parseInt(tr.dataset.idx);
    if (!state.selectedRows.has(idx)) {
      state.selectedRows.clear();
      state.selectedRows.add(idx);
      refreshSelection();
    }
  }

  const hasSelection = state.selectedRows.size > 0;

  let html = '<button id="ctx-add">＋ 添加航班</button>';
  if (hasSelection) {
    html += '<button id="ctx-delete">✕ 删除选中</button>';
    html += '<button id="ctx-duplicate">⧉ 复制选中</button>';
    html += '<div class="menu-sep"></div>';
    html += '<button id="ctx-move-up">↑ 向上移动</button>';
    html += '<button id="ctx-move-down">↓ 向下移动</button>';
  }

  menu.innerHTML = html;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('show');

  // Bind actions
  menu.querySelector('#ctx-add')?.addEventListener('click', () => { hideContextMenu(); addFlight(); });
  menu.querySelector('#ctx-delete')?.addEventListener('click', () => { hideContextMenu(); deleteSelected(); });
  menu.querySelector('#ctx-duplicate')?.addEventListener('click', () => { hideContextMenu(); duplicateSelected(); });
  menu.querySelector('#ctx-move-up')?.addEventListener('click', () => { hideContextMenu(); moveUp(); });
  menu.querySelector('#ctx-move-down')?.addEventListener('click', () => { hideContextMenu(); moveDown(); });
});

function hideContextMenu() {
  document.getElementById('context-menu').classList.remove('show');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#context-menu')) hideContextMenu();
});

// ─── Flight Operations ──────────────────────────────────
function addFlight() {
  const newFlight = {};
  FIELDS.forEach(([fn]) => { newFlight[fn] = ''; });
  newFlight.CallSign = 'NEW0001';
  newFlight.AircraftType = 'AIRBUS A-320neo';
  newFlight.Voice = 'Yeager';
  newFlight.Language = 'en';

  state.flights.push(newFlight);
  state.modified = true;
  renderTable();
  // Scroll to bottom
  const tbody = document.getElementById('table-body');
  tbody.lastElementChild?.scrollIntoView({ block: 'nearest' });
  showToast('已添加航班', 'success');
}

function deleteSelected() {
  if (state.selectedRows.size === 0) return;

  const count = state.selectedRows.size;
  showConfirm(`确定要删除 ${count} 个航班？`, () => {
    const indices = [...state.selectedRows].sort((a, b) => b - a);
    indices.forEach(idx => state.flights.splice(idx, 1));
    state.selectedRows.clear();
    state.modified = true;
    renderTable();
    showToast(`已删除 ${count} 个航班`, 'success');
  });
}

function duplicateSelected() {
  if (state.selectedRows.size === 0) return;

  const newFlights = [];
  [...state.selectedRows].sort((a, b) => a - b).forEach(idx => {
    const copy = { ...state.flights[idx] };
    copy.CallSign = (copy.CallSign || '') + '_COPY';
    newFlights.push(copy);
  });

  state.flights.push(...newFlights);
  state.modified = true;
  renderTable();
  showToast(`已复制 ${state.selectedRows.size} 个航班`, 'success');
}

function moveUp() {
  const indices = [...state.selectedRows].sort((a, b) => a - b);
  if (indices.length === 0 || indices[0] === 0) return;

  indices.forEach(idx => {
    [state.flights[idx], state.flights[idx - 1]] = [state.flights[idx - 1], state.flights[idx]];
  });

  state.selectedRows = new Set(indices.map(i => i - 1));
  state.modified = true;
  renderTable();
}

function moveDown() {
  const indices = [...state.selectedRows].sort((a, b) => b - a);
  if (indices.length === 0 || indices[0] >= state.flights.length - 1) return;

  indices.forEach(idx => {
    [state.flights[idx], state.flights[idx + 1]] = [state.flights[idx + 1], state.flights[idx]];
  });

  state.selectedRows = new Set(indices.map(i => i + 1));
  state.modified = true;
  renderTable();
}

// ─── Sorting ────────────────────────────────────────────
function sortBy(col) {
  if (state.sortCol === col) {
    state.sortAsc = !state.sortAsc;
  } else {
    state.sortCol = col;
    state.sortAsc = true;
  }

  if (col === '#') {
    state.flights.sort((a, b) => {
      const va = (a.CallSign || '').toLowerCase();
      const vb = (b.CallSign || '').toLowerCase();
      return state.sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
  } else {
    state.flights.sort((a, b) => {
      const va = (a[col] || '').toLowerCase();
      const vb = (b[col] || '').toLowerCase();
      return state.sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
  }

  state.modified = true;
  renderTable();
}

// ─── Search & Filter ────────────────────────────────────
document.getElementById('search-input').addEventListener('input', () => renderTable());
document.getElementById('filter-type').addEventListener('change', () => renderTable());

// ─── File Operations ────────────────────────────────────
async function handleOpen() {
  // Triggered by main process menu or button
  window.electronAPI.openFile();
}

window.electronAPI.onFileLoaded((data) => {
  state.aclPath = data.path;
  state.flights = data.flights;
  state.before = data.before;
  state.after = data.after;
  state.arrayContent = data.arrayContent;
  state.originalBlocks = data.originalBlocks;
  state.modified = false;
  state.selectedRows.clear();
  state.sortCol = null;
  state.sortAsc = true;
  document.getElementById('search-input').value = '';
  document.getElementById('filter-type').value = 'all';
  renderTable();
  showToast(`已加载 ${data.flights.length} 个航班`, 'success');
});

async function handleSave() {
  if (!state.aclPath) return handleSaveAs();

  try {
    const result = await window.electronAPI.saveFileDirect({
      path: state.aclPath,
      flights: state.flights,
      before: state.before,
      after: state.after,
      arrayContent: state.arrayContent,
      originalBlocks: state.originalBlocks,
    });

    if (result.success) {
      state.flights = result.flights;
      state.before = result.before;
      state.after = result.after;
      state.arrayContent = result.arrayContent;
      state.originalBlocks = result.originalBlocks;
      state.modified = false;
      renderTable();
      showToast('已保存', 'success');
    } else {
      showToast('保存失败: ' + result.error, 'error');
    }
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

async function handleSaveAs() {
  try {
    const result = await window.electronAPI.saveFile({
      flights: state.flights,
      before: state.before,
      after: state.after,
      arrayContent: state.arrayContent,
      originalBlocks: state.originalBlocks,
    });

    if (result.success) {
      state.aclPath = result.path;
      state.flights = result.flights;
      state.before = result.before;
      state.after = result.after;
      state.arrayContent = result.arrayContent;
      state.originalBlocks = result.originalBlocks;
      state.modified = false;
      renderTable();
      showToast('已保存', 'success');
    }
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

// ─── CSV ────────────────────────────────────────────────
window.electronAPI.onRequestSaveData(() => handleSaveAs());
window.electronAPI.onMenuSave(() => handleSave());

window.electronAPI.onCSVImported(({ flights, mode }) => {
  if (mode === 'replace') {
    state.flights = flights;
  } else {
    state.flights = [...state.flights, ...flights];
  }
  state.modified = true;
  renderTable();
  showToast(`已${mode === 'replace' ? '替换' : '追加'} ${flights.length} 个航班`, 'success');
});

window.electronAPI.onRequestCSVData(() => {
  if (state.flights.length === 0) {
    showToast('没有航班数据可导出', 'error');
    return;
  }
  window.electronAPI.exportCSV({ flights: state.flights }).then(result => {
    if (result.success) showToast('CSV 导出完成', 'success');
  });
});

// ─── Batch Operations ───────────────────────────────────
function batchCallsign() {
  showPromptForm('批量生成呼号', [
    { id: 'prefix', label: '前缀 (如 CCA)', value: 'CCA', type: 'text' },
    { id: 'start', label: '起始编号', value: '1', type: 'number' },
  ], (values) => {
    const prefix = values.prefix;
    const start = parseInt(values.start);
    state.flights.forEach((fl, i) => {
      fl.CallSign = `${prefix}${String(start + i).padStart(4, '0')}`;
    });
    state.modified = true;
    renderTable();
    const last = start + state.flights.length - 1;
    showToast(`呼号: ${prefix}${String(start).padStart(4, '0')} ~ ${prefix}${String(last).padStart(4, '0')}`, 'success');
  });
}

function batchVoice() {
  showPromptForm('批量设置语音', [
    { id: 'voice', label: '语音包名称', value: 'Yeager', type: 'text' },
  ], (values) => {
    state.flights.forEach(fl => fl.Voice = values.voice);
    state.modified = true;
    renderTable();
    showToast(`已设置语音: ${values.voice}`, 'success');
  });
}

function batchLanguage() {
  showPromptForm('批量设置语言', [
    { id: 'lang', label: '语言代码', value: 'en', type: 'select', options: ['en', 'zh'] },
  ], (values) => {
    state.flights.forEach(fl => fl.Language = values.lang);
    state.modified = true;
    renderTable();
    showToast(`已设置语言: ${values.lang}`, 'success');
  });
}

// ─── Modal Helpers ──────────────────────────────────────
function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = type;
  toast.classList.add('show');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => toast.classList.remove('show'), 2500);
}

function showConfirm(message, onConfirm) {
  const overlay = document.getElementById('modal-overlay');
  document.getElementById('modal-title').textContent = '确认操作';
  document.getElementById('modal-body').innerHTML = `<p style="color:var(--text-secondary)">${message}</p>`;
  document.getElementById('modal-actions').innerHTML = `
    <button class="btn-cancel" id="modal-cancel">取消</button>
    <button class="btn-danger" id="modal-confirm">确认删除</button>
  `;
  overlay.classList.remove('hidden');

  document.getElementById('modal-cancel').onclick = () => overlay.classList.add('hidden');
  document.getElementById('modal-confirm').onclick = () => {
    overlay.classList.add('hidden');
    onConfirm();
  };
}

function showPromptForm(title, fields, onSubmit) {
  const overlay = document.getElementById('modal-overlay');
  document.getElementById('modal-title').textContent = title;

  const bodyHtml = fields.map(f => `
    <label for="pf-${f.id}">${f.label}</label>
    ${f.type === 'select' ? `
      <select id="pf-${f.id}">${f.options.map(o => `<option value="${o}" ${o===f.value?'selected':''}>${o}</option>`).join('')}</select>
    ` : `
      <input id="pf-${f.id}" type="${f.type}" value="${f.value}"${f.type==='number'?' min="1"':''}>
    `}
  `).join('');

  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-actions').innerHTML = `
    <button class="btn-cancel" id="modal-cancel">取消</button>
    <button class="btn-confirm" id="modal-confirm">确定</button>
  `;
  overlay.classList.remove('hidden');

  document.getElementById('modal-cancel').onclick = () => overlay.classList.add('hidden');
  document.getElementById('modal-confirm').onclick = () => {
    const values = {};
    fields.forEach(f => {
      values[f.id] = document.getElementById(`pf-${f.id}`).value;
    });
    overlay.classList.add('hidden');
    onSubmit(values);
  };

  // Focus first input
  setTimeout(() => {
    const first = document.querySelector('#modal-body input, #modal-body select');
    first?.focus();
  }, 100);
}

// ─── Keyboard Shortcuts ─────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Don't handle shortcuts during inline editing
  if (state.editingCell) return;

  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key === 'o') { e.preventDefault(); handleOpen(); }
  if (mod && e.key === 's') { e.preventDefault(); handleSave(); }
  if (mod && e.key === 'n') { e.preventDefault(); addFlight(); }
  if (e.key === 'Delete') { e.preventDefault(); deleteSelected(); }
  if (e.key === 'Escape') {
    state.selectedRows.clear();
    refreshSelection();
    hideContextMenu();
  }
});

// ─── Toolbar Button Bindings ────────────────────────────
document.getElementById('btn-open').addEventListener('click', () => window.electronAPI.openFile());
document.getElementById('btn-save').addEventListener('click', handleSave);
document.getElementById('btn-save-as').addEventListener('click', handleSaveAs);
document.getElementById('btn-import-csv').addEventListener('click', () => {
  // Simple import menu via modal
  showPromptForm('导入 CSV', [
    { id: 'op', label: '模式', value: 'append', type: 'select', options: ['append', 'replace'] },
  ], (values) => {
    // Can't trigger file dialog from renderer directly; send to main
    showToast('请通过菜单栏: 文件 → 导入 CSV', 'error');
  });
});
document.getElementById('btn-export-csv').addEventListener('click', () => {
  if (state.flights.length === 0) { showToast('没有航班数据可导出', 'error'); return; }
  window.electronAPI.exportCSV({ flights: state.flights }).then(result => {
    if (result.success) showToast('CSV 导出完成', 'success');
  });
});
document.getElementById('btn-add').addEventListener('click', addFlight);
document.getElementById('btn-delete').addEventListener('click', deleteSelected);
document.getElementById('btn-duplicate').addEventListener('click', duplicateSelected);
document.getElementById('btn-batch-callsign').addEventListener('click', batchCallsign);
document.getElementById('btn-batch-voice').addEventListener('click', batchVoice);
document.getElementById('btn-batch-lang').addEventListener('click', batchLanguage);

// ─── Init ───────────────────────────────────────────────
buildTableHead();
renderTable();

console.log('AC27 Level Editor ready');
