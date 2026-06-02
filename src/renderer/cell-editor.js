// ─── Cell Click → Edit + highlight row ────────────────────
document.getElementById('sections-container').addEventListener('click', (e) => {
  if (appState.editingWidget) return;

  const td = e.target.closest('td');
  const tr = e.target.closest('tr');

  if (tr) {
    const idx = parseInt(tr.dataset.idx);
    if (!isNaN(idx)) appState.highlightedIdx = idx;
  }

  if (e.target.closest('input[type="checkbox"]')) return;

  if (td) {
    const col = td.dataset.col;
    const idx = parseInt(td.dataset.idx);
    startCellEdit(td, col, idx);
  } else {
    renderAllSections();
  }
});

// ─── Checkbox handlers ───────────────────────────────────
document.getElementById('sections-container').addEventListener('change', function(e) {
  if (e.target.classList.contains('chk-row')) {
    const idx = parseInt(e.target.dataset.idx);
    if (e.target.checked) appState.selectedIndices.add(idx);
    else appState.selectedIndices.delete(idx);
    renderAllSections();
  }
});

// ─── Drag-to-select multiple rows ──────────────────────────
(function() {
  let dragStartIdx = -1;
  let dragActive = false;
  let dragPending = false;
  let dragStartX = 0, dragStartY = 0;
  let dragSelectMode = true; // true = select, false = deselect
  let dragOriginalState = new Set(); // snapshot of selectedIndices at drag start

  document.getElementById('sections-container').addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.closest('.clock-popover')) return;
    const td = e.target.closest('td');
    if (!td) return;
    const tr = td.closest('tr');
    if (!tr) return;
    dragStartIdx = parseInt(tr.dataset.idx);
    if (isNaN(dragStartIdx)) return;

    dragSelectMode = !appState.selectedIndices.has(dragStartIdx);
    dragOriginalState = new Set(appState.selectedIndices); // snapshot
    dragPending = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
  });

  document.addEventListener('mousemove', (e) => {
    if (dragPending && !dragActive) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      dragActive = true;
      dragPending = false;
    }
    if (!dragActive) return;
    const tr = e.target.closest('tr');
    if (!tr) return;
    const currentIdx = parseInt(tr.dataset.idx);
    if (isNaN(currentIdx)) return;

    // Restore all checkboxes to original state, then apply mode to range
    const min = Math.min(dragStartIdx, currentIdx);
    const max = Math.max(dragStartIdx, currentIdx);
    const cbs = document.querySelectorAll('#sections-container .chk-row');
    cbs.forEach(cb => {
      const idx = parseInt(cb.dataset.idx);
      cb.checked = dragOriginalState.has(idx);
      if (dragOriginalState.has(idx)) appState.selectedIndices.add(idx);
      else appState.selectedIndices.delete(idx);
    });
    // Apply drag mode to range between start and current
    cbs.forEach(cb => {
      const idx = parseInt(cb.dataset.idx);
      if (idx >= min && idx <= max) {
        cb.checked = dragSelectMode;
        if (dragSelectMode) appState.selectedIndices.add(idx);
        else appState.selectedIndices.delete(idx);
      }
    });
  });

  document.addEventListener('mouseup', () => {
    if (dragActive || dragPending) {
      // Only refresh the flight tables, not the runway editor
      if (dragActive) {
        const arrivals = [], departures = [];
        for (const fl of appState.flights) {
          if ((fl.LandingTime || '').trim()) arrivals.push(fl);
          else departures.push(fl);
        }
        buildSectionTable('section-arrivals', '进港', arrivals, ARRIVAL_FIELDS, 'row-arrival');
        buildSectionTable('section-departures', '离港', departures, DEPARTURE_FIELDS, 'row-departure');
      }
      dragActive = false;
      dragPending = false;
      dragStartIdx = -1;
    }
  });
})();

// ═══════════ TIME CLOCK POPOVER ══════════════════════════
function openTimeClockPopover(anchorEl, col, idx, currentVal, onCommit) {
  const parsed = (currentVal || '00:00:00').split(':');
  let hour = parseInt(parsed[0]) || 0;
  let minute = parseInt(parsed[1]) || 0;
  let second = parseInt(parsed[2]) || 0;

  const SIZE = 220;
  const CX = SIZE / 2, CY = SIZE / 2;
  const R = 95;

  const overlay = document.createElement('div');
  overlay.className = 'time-clock-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) commit(); });

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
      <input class="clock-time-input" type="text" id="clock-time-input" placeholder="HH:MM:SS" maxlength="8" />
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
    setHand(hourHand, CX, CY, 42, ((hour % 12) + minute / 60 + second / 3600) * 30);
    setHand(minuteHand, CX, CY, 62, (minute + second / 60) * 6);
    setHand(secondHand, CX, CY, 70, second * 6);
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

  // Drag on clock face
  let dragging = false;
  let dragTarget = 'minute';
  const lastDragValues = { hour, minute, second };

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
      if (lastSec > 50 && newSecond < 10) { minute = (minute + 1) % 60; if (minute === 0) hour = (hour + 1) % 24; }
      else if (lastSec < 10 && newSecond > 50) { minute = (minute + 59) % 60; if (minute === 59) hour = (hour + 23) % 24; }
      second = newSecond;
      lastDragValues.second = second;
    } else {
      const newMinute = Math.round(angle / 6) % 60;
      const lastMin = lastDragValues.minute;
      if (lastMin > 50 && newMinute < 10) hour = (hour + 1) % 24;
      else if (lastMin < 10 && newMinute > 50) hour = (hour + 23) % 24;
      minute = newMinute;
      lastDragValues.minute = minute;
    }
    updateDisplay();
  }

  function dragEnd() { dragging = false; svg.classList.remove('clock-dragging'); }

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

  input.addEventListener('input', () => {
    const val = input.value;
    const m = val.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (m) {
      hour = Math.min(23, parseInt(m[1]) || 0);
      minute = Math.min(59, parseInt(m[2]) || 0);
      second = m[3] ? Math.min(59, parseInt(m[3]) || 0) : 0;
    } else if (/^\d+$/.test(val) && val.length <= 6) {
      hour = Math.min(23, parseInt(val.substring(0, 2)) || 0);
      if (val.length >= 3) minute = Math.min(59, parseInt(val.substring(2, 4)) || 0);
      if (val.length >= 5) second = Math.min(59, parseInt(val.substring(4, 6)) || 0);
    }
    _updateClockHands();
  });

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
      if (onCommit) { onCommit(newVal); }
      else {
        appState.flights[idx][col] = newVal;
        appState.modified = true;
        if (col === 'LandingTime' || col === 'OffBlockTime') autoSort();
      }
    }
    closePopover();
  }

  function cancel() { closePopover(); }

  function closePopover() {
    overlay.remove();
    appState.editingWidget = null;
    if (!onCommit) { anchorEl.innerHTML = appState.flights[idx][col] || ''; renderAllSections(); }
  }

  // Position popover
  const anchorRect = anchorEl.getBoundingClientRect();
  const popW = 300, popH = 380;
  let left = anchorRect.left + anchorRect.width / 2 - popW / 2;
  let top = anchorRect.bottom + 6;
  if (top + popH > window.innerHeight - 20) top = anchorRect.top - popH - 6;
  if (left < 10) left = 10;
  if (left + popW > window.innerWidth - 10) left = window.innerWidth - popW - 10;

  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
  appState.editingWidget = { col, idx, widget: overlay, popover: true };

  document.body.appendChild(overlay);
  setTimeout(() => popover.classList.add('show'), 10);
  input.focus();
  input.select();
}

// ═══════════ COMPASS POPOVER ══════════════════════════════
function openCompassPopover(anchorEl, idx, currentVal, onCommit) {
  let deg = parseInt(currentVal) || 0;
  if (deg < 0) deg = 0; if (deg > 359) deg = 359;

  const SIZE = 220;
  const CX = SIZE / 2, CY = SIZE / 2;
  const R = 95;

  const overlay = document.createElement('div');
  overlay.className = 'time-clock-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) commit(); });

  const popover = document.createElement('div');
  popover.className = 'time-clock-popover compass-popover';
  overlay.appendChild(popover);

  popover.innerHTML = `
    <div class="clock-title">风向 (deg)</div>
    <svg class="clock-svg compass-svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
      <circle class="clock-face-bg" cx="${CX}" cy="${CY}" r="${R}" />
      ${buildCompassTicks(CX, CY, R)}
      <line class="compass-hand" id="compass-hand" />
      <circle class="clock-center-dot compass-dot" cx="${CX}" cy="${CY}" r="4" />
      <polygon class="compass-arrowhead" id="compass-arrowhead" />
    </svg>
    <div class="clock-input-row">
      <input class="clock-time-input compass-input" type="text" id="compass-deg-input" placeholder="000" maxlength="3" />
      <span class="compass-unit">°</span>
      <button class="clock-btn clock-btn-ok" id="compass-btn-ok">&#10003;</button>
      <button class="clock-btn clock-btn-cancel" id="compass-btn-cancel">&#10005;</button>
    </div>
    <div class="compass-label" id="compass-label">N</div>
  `;

  const svg = popover.querySelector('.compass-svg');
  const hand = popover.querySelector('#compass-hand');
  const arrow = popover.querySelector('#compass-arrowhead');
  const input = popover.querySelector('#compass-deg-input');
  const label = popover.querySelector('#compass-label');

  const CARDINAL = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

  function _updateCompass() {
    const angle = (deg - 90) * Math.PI / 180;
    const tipX = CX + R * Math.cos(angle);
    const tipY = CY + R * Math.sin(angle);
    const baseAngle = angle + Math.PI;
    const baseR = 6;
    const bx1 = CX + baseR * Math.cos(baseAngle - 0.6);
    const by1 = CY + baseR * Math.sin(baseAngle - 0.6);
    const bx2 = CX + baseR * Math.cos(baseAngle + 0.6);
    const by2 = CY + baseR * Math.sin(baseAngle + 0.6);
    hand.setAttribute('x1', CX);
    hand.setAttribute('y1', CY);
    hand.setAttribute('x2', tipX);
    hand.setAttribute('y2', tipY);
    arrow.setAttribute('points', `${tipX},${tipY} ${bx1},${by1} ${bx2},${by2}`);
    input.value = String(deg);
    label.textContent = CARDINAL[Math.round(deg / 22.5) % 16] + '  ' + deg + '°';
  }

  _updateCompass();

  // Drag
  let dragging = false;
  let lastDragDeg = deg;

  function dragStart(e) {
    e.preventDefault();
    dragging = true;
    lastDragDeg = deg;
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
    deg = Math.round(angle) % 360;
    _updateCompass();
  }

  function dragEnd() { dragging = false; svg.classList.remove('clock-dragging'); }

  svg.addEventListener('mousedown', dragStart);
  svg.addEventListener('mousemove', dragMove);
  svg.addEventListener('mouseup', dragEnd);
  svg.addEventListener('mouseleave', dragEnd);
  svg.addEventListener('touchstart', dragStart, { passive: false });
  svg.addEventListener('touchmove', dragMove, { passive: false });
  svg.addEventListener('touchend', dragEnd);

  input.addEventListener('input', () => {
    const v = parseInt(input.value);
    if (!isNaN(v) && v >= 0 && v <= 359) { deg = v; _updateCompass(); }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  popover.querySelector('#compass-btn-ok').addEventListener('click', commit);
  popover.querySelector('#compass-btn-cancel').addEventListener('click', cancel);

  function commit() {
    const v = parseInt(input.value);
    const newVal = (!isNaN(v) && v >= 0 && v <= 359) ? v : deg;
    if (newVal !== parseInt(currentVal)) {
      if (onCommit) onCommit(newVal);
    }
    closePopover();
  }

  function cancel() { closePopover(); }

  function closePopover() {
    overlay.remove();
    appState.editingWidget = null;
  }

  // Position popover
  const anchorRect = anchorEl.getBoundingClientRect();
  const popW = 300, popH = 400;
  let left = anchorRect.left + anchorRect.width / 2 - popW / 2;
  let top = anchorRect.bottom + 6;
  if (top + popH > window.innerHeight - 20) top = anchorRect.top - popH - 6;
  if (left < 10) left = 10;
  if (left + popW > window.innerWidth - 10) left = window.innerWidth - popW - 10;

  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
  appState.editingWidget = { widget: overlay, popover: true };

  document.body.appendChild(overlay);
  setTimeout(() => popover.classList.add('show'), 10);
  input.focus();
  input.select();
}

function buildCompassTicks(cx, cy, r) {
  const DIRS = ['N','','','E','','','S','','','W','',''];
  let html = '';
  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 - 90) * Math.PI / 180;
    const inner = r - 12;
    const x1 = cx + inner * Math.cos(angle);
    const y1 = cy + inner * Math.sin(angle);
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    html += `<line class="clock-tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    if (DIRS[i]) {
      const numR = r - 24;
      const nx = cx + numR * Math.cos(angle);
      const ny = cy + numR * Math.sin(angle) + 5;
      html += `<text class="clock-num" x="${nx}" y="${ny}">${DIRS[i]}</text>`;
    }
  }
  for (let i = 0; i < 36; i++) {
    if (i % 3 === 0) continue;
    const angle = (i * 10 - 90) * Math.PI / 180;
    const inner = r - 6;
    const x1 = cx + inner * Math.cos(angle);
    const y1 = cy + inner * Math.sin(angle);
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    html += `<line class="clock-tick-minor" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
  }
  return html;
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
    const numR = r - 22;
    const nx = cx + numR * Math.cos(angle);
    const ny = cy + numR * Math.sin(angle) + 5;
    const num = i === 0 ? 12 : i;
    html += `<text class="clock-num" x="${nx}" y="${ny}">${num}</text>`;
  }
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

// ═══════════ CELL EDIT (text/dropdown) ════════════════════
function startCellEdit(td, col, idx) {
  let currentVal;
  if (col === 'AirlineCode') currentVal = (appState.flights[idx].CallSign || '').substring(0, 3);
  else if (col === 'FlightNum') currentVal = (appState.flights[idx].CallSign || '').substring(3);
  else if (col === 'Registration') currentVal = appState.flights[idx]._Registration || appState.flights[idx].Registration || '';
  else currentVal = appState.flights[idx][col] || '';

  if (TIME_FIELDS.has(col)) { openTimeClockPopover(td, col, idx, currentVal); return; }

  const values = appState.airportValues[appState.currentAirport] || {};
  const compat = values._compat || { airlineToAircraft: {}, aircraftToAirline: {} };
  const audioData = appState.audioCallsigns;
  const currentAirlineCode = (appState.flights[idx].CallSign || '').substring(0, 3);
  let widget;
  let dropdownValues;

  switch (col) {
    case 'FlightNum':
      dropdownValues = [...(audioData.byAirline[currentAirlineCode] || [])];
      if (currentVal && !dropdownValues.includes(currentVal)) dropdownValues.push(currentVal);
      widget = document.createElement('select');
      widget.className = 'cell-widget';
      widget.innerHTML = dropdownValues.map(v => `<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${v}</option>`).join('');
      if (currentVal && !audioData.byAirline[currentAirlineCode]?.includes(currentVal)) widget.classList.add('highlight-invalid');
      break;
    case 'AirlineCode':
      dropdownValues = [...(audioData.allAirlines || [])];
      if (currentVal && !dropdownValues.includes(currentVal)) dropdownValues.push(currentVal);
      widget = document.createElement('select');
      widget.className = 'cell-widget';
      widget.innerHTML = dropdownValues.map(v => `<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${v}</option>`).join('');
      break;
    case 'AircraftType': {
      const acCode = (appState.flights[idx].CallSign || '').substring(0, 3);
      const validTypes = acCode ? (compat.airlineToAircraft[acCode] || null) : null;
      if (validTypes) dropdownValues = [...validTypes];
      else dropdownValues = [...(values['AircraftType'] || [])];
      if (currentVal && !dropdownValues.includes(currentVal)) dropdownValues.push(currentVal);
      widget = document.createElement('select');
      widget.className = 'cell-widget';
      widget.innerHTML = dropdownValues.map(v => `<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${v}</option>`).join('');
      if (currentVal && validTypes && !validTypes.includes(currentVal)) widget.classList.add('highlight-invalid');
      break;
    }
    case 'Voice':
      dropdownValues = values._voiceOptions ? [...values._voiceOptions] : [...(values['Voice'] || [])];
      if (currentVal && !dropdownValues.includes(currentVal)) dropdownValues.push(currentVal);
      widget = document.createElement('select');
      widget.className = 'cell-widget';
      widget.innerHTML = dropdownValues.map(v => `<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${v}</option>`).join('');
      break;
    case 'Registration': {
      const flt = appState.flights[idx];
      const acCode = (flt.CallSign || '').substring(0, 3);
      const acType = flt.AircraftType || '';
      const regMap = values._registrationMap || {};
      const key = acCode + '|' + acType;
      dropdownValues = regMap[key] ? [...regMap[key]] : [];
      if (currentVal && !dropdownValues.includes(currentVal)) dropdownValues.push(currentVal);
      widget = document.createElement('select');
      widget.className = 'cell-widget';
      widget.innerHTML = dropdownValues.map(v => `<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${v}</option>`).join('');
      if (currentVal && acCode && acType && regMap[key] && !regMap[key].includes(currentVal)) widget.classList.add('highlight-invalid');
      break;
    }
    case 'Airway':
      dropdownValues = [...(values['Airway'] || [])];
      if (currentVal && !dropdownValues.includes(currentVal)) dropdownValues.push(currentVal);
      widget = document.createElement('select');
      widget.className = 'cell-widget';
      widget.innerHTML = dropdownValues.map(v => `<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${v}</option>`).join('');
      break;
    case 'Language':
      dropdownValues = ['en', 'zh'];
      if (currentVal && !dropdownValues.includes(currentVal)) dropdownValues.push(currentVal);
      break;
    default:
      dropdownValues = values[col] || [];
      break;
  }

  if (!widget) {
    if (DROPDOWN_FIELDS.has(col)) {
      if (currentVal && !dropdownValues.includes(currentVal)) dropdownValues = [currentVal, ...dropdownValues];
      widget = document.createElement('select');
      widget.className = 'cell-widget';
      widget.innerHTML = dropdownValues.map(v => `<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${v}</option>`).join('');
      if (currentVal && !dropdownValues.includes(currentVal)) widget.innerHTML += `<option value="${escapeHtml(currentVal)}" selected>${currentVal}</option>`;
    } else {
      widget = document.createElement('input');
      widget.type = 'text';
      widget.className = 'cell-widget';
      widget.value = currentVal;
    }
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
        appState.flights[idx].AirlineName = newVal;
        const oldCs = appState.flights[idx].CallSign || '';
        const oldNum = oldCs.substring(3);
        const audioData = appState.audioCallsigns;
        appState.flights[idx].CallSign = newVal.substring(0, 3) + oldNum;

        for (const key of appState.highlightedCells) { if (key.startsWith(`${idx}:`)) appState.highlightedCells.delete(key); }

        if (audioData.allAirlines.length > 0) {
          const availNums = audioData.byAirline[newVal];
          if (availNums && availNums.length > 0 && !availNums.includes(oldNum)) {
            appState.flights[idx].CallSign = newVal.substring(0, 3) + availNums[0];
            appState.highlightedCells.add(`${idx}:FlightNum`);
          }
        }

        const currType = appState.flights[idx].AircraftType || '';
        if (currType) {
          const compatTypes = compat.airlineToAircraft[newVal];
          if (compatTypes && !compatTypes.includes(currType)) {
            appState.flights[idx].AircraftType = null;
            appState.highlightedCells.add(`${idx}:AircraftType`);
          }
        }

        if (appState.flights[idx]._Registration || appState.flights[idx].Registration) {
          appState.flights[idx]._Registration = null;
          appState.flights[idx].Registration = null;
          appState.highlightedCells.add(`${idx}:Registration`);
        }
      } else if (col === 'AircraftType') {
        appState.flights[idx].AircraftType = newVal;
        if (appState.flights[idx]._Registration || appState.flights[idx].Registration) {
          appState.flights[idx]._Registration = null;
          appState.flights[idx].Registration = null;
          appState.highlightedCells.add(`${idx}:Registration`);
        }
      } else if (col === 'FlightNum') {
        const cs = appState.flights[idx].CallSign || '';
        appState.flights[idx].CallSign = cs.substring(0, 3) + newVal;
      } else if (col === 'Registration') {
        appState.flights[idx]._Registration = newVal;
        appState.highlightedCells.delete(`${idx}:Registration`);
      } else {
        appState.flights[idx][col] = newVal;
      }
      appState.modified = true;
      if (col === 'LandingTime' || col === 'OffBlockTime') autoSort();
    }
    if (col === 'AirlineCode') td.innerHTML = (appState.flights[idx].CallSign || '').substring(0, 3);
    else if (col === 'FlightNum') td.innerHTML = (appState.flights[idx].CallSign || '').substring(3);
    else if (col === 'Registration') td.innerHTML = appState.flights[idx]._Registration || '';
    else td.innerHTML = appState.flights[idx][col] || '';
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
