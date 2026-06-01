// ─── Time helpers ──────────────────────────────────────────

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const parts = String(timeStr).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function timeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = String(timeStr).split(':');
  return (parseInt(parts[0], 10) || 0) * 3600 + (parseInt(parts[1], 10) || 0) * 60 + (parseInt(parts[2], 10) || 0);
}

function minutesToTimeStr(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00';
}

/**
 * Sort a timeline array in-place by time (ascending), stable.
 * Called before every render & save so entries are always time-ordered.
 */
function sortTimelineByTime(timeline) {
  if (!timeline || timeline.length < 2) return;
  timeline.sort((a, b) => timeToSeconds(a.time) - timeToSeconds(b.time));
}

// ─── Active range computation ─────────────────────────────
// Returns activeIndices (Set), validMinTime, validMaxTime (minutes), totalCount

function getTimelineActiveRange(timeline, startTime, endTime) {
  const result = {
    activeIndices: new Set(),
    validMinTime: null,
    validMaxTime: null,
    totalCount: timeline.length,
  };

  if (!startTime || !endTime || !timeline || timeline.length === 0) {
    // No level time range → all entries are active
    for (let i = 0; i < timeline.length; i++) result.activeIndices.add(i);
    return result;
  }

  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);

  // Stable sort by time (ascending)
  const sorted = timeline.map((e, i) => ({ ...e, _origIdx: i }))
    .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));

  // 1) All entries within level time range [startMin, endMin]
  for (const entry of sorted) {
    const t = timeToMinutes(entry.time);
    if (t >= startMin && t <= endMin) {
      result.activeIndices.add(entry._origIdx);
    }
  }

  // 2) First entry BEFORE level start (closest going backwards)
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (timeToMinutes(sorted[i].time) < startMin) {
      result.activeIndices.add(sorted[i]._origIdx);
      break;
    }
  }

  // 3) First entry AFTER level end (closest going forwards)
  for (let i = 0; i < sorted.length; i++) {
    if (timeToMinutes(sorted[i].time) > endMin) {
      result.activeIndices.add(sorted[i]._origIdx);
      break;
    }
  }

  // Compute valid range = min/max time of active entries
  const activeEntries = sorted.filter(e => result.activeIndices.has(e._origIdx));
  if (activeEntries.length > 0) {
    result.validMinTime = Math.min(...activeEntries.map(e => timeToMinutes(e.time)));
    result.validMaxTime = Math.max(...activeEntries.map(e => timeToMinutes(e.time)));
  }

  return result;
}

// ─── Time validation helpers ──────────────────────────────

function _getWeatherValidRange() {
  return getTimelineActiveRange(
    appState.weatherTimeline,
    appState._configStartTime,
    appState._configEndTime
  );
}

function _getWindValidRange() {
  return getTimelineActiveRange(
    appState.windTimeline,
    appState._configStartTime,
    appState._configEndTime
  );
}

function _getRunwayValidRange() {
  const start = appState._configStartTime;
  const end = appState._configEndTime;
  if (!start || !end) return { validMinTime: null, validMaxTime: null };
  return {
    validMinTime: timeToMinutes(start),
    validMaxTime: timeToMinutes(end),
  };
}

function _validateTimelineTime(newTime, validRange, label) {
  if (validRange.validMinTime == null || validRange.validMaxTime == null) return true;
  const t = timeToMinutes(newTime);
  if (t < validRange.validMinTime || t > validRange.validMaxTime) {
    const minStr = minutesToTimeStr(validRange.validMinTime).substring(0, 5);
    const maxStr = minutesToTimeStr(validRange.validMaxTime).substring(0, 5);
    showToast(`${label}时间 ${newTime} 超出有效范围 (${minStr} ~ ${maxStr})`, 'error');
    return false;
  }
  return true;
}

// ═══════════ WEATHER EDITOR ═══════════════════════════════

const WEATHER_PRESETS = ['Sunny', 'FewCloudy', 'MidCloudy', 'PartlyCloudy', 'OvercastSky', 'AfterRain'];

function renderWeatherEditor() {
  const list = document.getElementById('weather-list');
  if (!list) return;

  sortTimelineByTime(appState.weatherTimeline);
  const range = _getWeatherValidRange();

  // ── Range indicator ──
  const rangeEl = document.getElementById('weather-range-indicator');
  if (rangeEl) {
    if (range.validMinTime != null && range.validMaxTime != null) {
      rangeEl.textContent = '有效范围: ' +
        minutesToTimeStr(range.validMinTime).substring(0, 5) + ' ~ ' +
        minutesToTimeStr(range.validMaxTime).substring(0, 5);
    } else {
      rangeEl.textContent = '';
    }
  }

  // ── Hidden count ──
  const hiddenEl = document.getElementById('weather-hidden-count');
  if (hiddenEl) {
    const hidden = range.totalCount - range.activeIndices.size;
    if (hidden > 0) {
      hiddenEl.textContent = `已隐藏 ${hidden} 条（超出本关卡范围）`;
    } else {
      hiddenEl.textContent = '';
    }
  }

  // ── Render only active entries (by real index) ──
  const activeEntries = [];
  for (let i = 0; i < appState.weatherTimeline.length; i++) {
    if (range.activeIndices.has(i)) {
      activeEntries.push({ entry: appState.weatherTimeline[i], realIdx: i });
    }
  }

  list.innerHTML = activeEntries.map(({ entry, realIdx }, displayIdx) => `
    <div class="tl-row" data-idx="${realIdx}">
      <input class="tl-input tl-time-click" type="text" data-field="time" data-idx="${realIdx}" value="${entry.time || ''}" placeholder="HH:MM" readonly>
      <select class="tl-select" data-field="preset" data-idx="${realIdx}">
        ${WEATHER_PRESETS.map(p => `<option value="${p}" ${entry.preset === p ? 'selected' : ''}>${p}</option>`).join('')}
        ${!WEATHER_PRESETS.includes(entry.preset) ? `<option value="${entry.preset}" selected>${entry.preset}</option>` : ''}
      </select>
      <button class="tl-btn-del" data-idx="${realIdx}" title="删除">X</button>
    </div>
  `).join('');

  // ── Event: preset change ──
  list.querySelectorAll('.tl-select').forEach(el => {
    el.addEventListener('change', () => {
      const i = parseInt(el.dataset.idx);
      appState.weatherTimeline[i].preset = el.value;
      appState.timelineModified.weather = true;
      updateTimelineStatus();
    });
  });

  // ── Weather time → clock popover (with validation) ──
  list.querySelectorAll('.tl-time-click').forEach(el => {
    el.addEventListener('click', () => {
      if (appState.editingWidget) return;
      const i = parseInt(el.dataset.idx);
      openTimeClockPopover(el, '天气', i, el.value, (newVal) => {
        const st = appState._configStartTime, et = appState._configEndTime;
        if (st && et) {
          const t = timeToMinutes(newVal), sm = timeToMinutes(st), em = timeToMinutes(et);
          if (t <= sm || t >= em) { showToast(`天气 ${newVal} 须严格介于 ${st} ~ ${et} 之间`, 'error'); return; }
        }
        const validRange = _getWeatherValidRange();
        if (!_validateTimelineTime(newVal, validRange, '天气')) return;
        appState.weatherTimeline[i].time = newVal;
        appState.timelineModified.weather = true;
        updateTimelineStatus();
        renderWeatherEditor();
      });
    });
  });

  // ── Event: delete ──
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
  const range = _getWeatherValidRange();
  // Default time: always at the end of the valid range
  let defaultTime = '06:00:00';
  if (range.validMaxTime != null) {
    defaultTime = minutesToTimeStr(range.validMaxTime - 1);
  }
  appState.weatherTimeline.push({ preset: 'Sunny', time: defaultTime });
  appState.timelineModified.weather = true;
  updateTimelineStatus();
  renderWeatherEditor();
});

// ═══════════ WIND EDITOR ══════════════════════════════════

function renderWindEditor() {
  const list = document.getElementById('wind-list');
  if (!list) return;

  sortTimelineByTime(appState.windTimeline);
  const range = _getWindValidRange();

  // ── Range indicator ──
  const rangeEl = document.getElementById('wind-range-indicator');
  if (rangeEl) {
    if (range.validMinTime != null && range.validMaxTime != null) {
      rangeEl.textContent = '有效范围: ' +
        minutesToTimeStr(range.validMinTime).substring(0, 5) + ' ~ ' +
        minutesToTimeStr(range.validMaxTime).substring(0, 5);
    } else {
      rangeEl.textContent = '';
    }
  }

  // ── Hidden count ──
  const hiddenEl = document.getElementById('wind-hidden-count');
  if (hiddenEl) {
    const hidden = range.totalCount - range.activeIndices.size;
    if (hidden > 0) {
      hiddenEl.textContent = `已隐藏 ${hidden} 条（超出本关卡范围）`;
    } else {
      hiddenEl.textContent = '';
    }
  }

  // ── Render only active entries (by real index) ──
  const activeEntries = [];
  for (let i = 0; i < appState.windTimeline.length; i++) {
    if (range.activeIndices.has(i)) {
      activeEntries.push({ entry: appState.windTimeline[i], realIdx: i });
    }
  }

  list.innerHTML = activeEntries.map(({ entry, realIdx }, displayIdx) => `
    <div class="tl-row" data-idx="${realIdx}">
      <input class="tl-input tl-time-click" type="text" data-field="time" data-idx="${realIdx}" value="${entry.time || ''}" placeholder="HH:MM" readonly>
      <input class="tl-input tl-direction-click" type="text" data-field="direction" data-idx="${realIdx}" value="${entry.direction || 0}°" readonly>
      <div class="tl-speed-row">
        <input class="tl-speed-slider" type="range" min="0" max="40" value="${entry.speed || 0}" data-field="speed" data-idx="${realIdx}">
        <span class="tl-speed-val" data-idx="${realIdx}">${entry.speed || 0} kt</span>
      </div>
      <button class="tl-btn-del" data-idx="${realIdx}" title="删除">X</button>
    </div>
  `).join('');


  // ── Speed slider (live) ──
  list.querySelectorAll('.tl-speed-slider').forEach(slider => {
    const i = parseInt(slider.dataset.idx);
    const valSpan = list.querySelector(`.tl-speed-val[data-idx="${i}"]`);
    slider.addEventListener('input', () => {
      const v = parseInt(slider.value);
      valSpan.textContent = v + ' kt';
    });
    slider.addEventListener('change', () => {
      appState.windTimeline[i].speed = parseInt(slider.value);
      appState.timelineModified.wind = true;
      updateTimelineStatus();
    });
  });

  // ── Direction → compass popover ──
  list.querySelectorAll('.tl-direction-click').forEach(el => {
    el.addEventListener('click', () => {
      if (appState.editingWidget) return;
      const i = parseInt(el.dataset.idx);
      openCompassPopover(el, i, appState.windTimeline[i].direction, (newVal) => {
        appState.windTimeline[i].direction = newVal;
        appState.timelineModified.wind = true;
        updateTimelineStatus();
        renderWindEditor();
      });
    });
  });

  // ── Wind time → clock popover (with validation) ──
  list.querySelectorAll('.tl-time-click').forEach(el => {
    el.addEventListener('click', () => {
      if (appState.editingWidget) return;
      const i = parseInt(el.dataset.idx);
      openTimeClockPopover(el, '风向', i, el.value, (newVal) => {
        const st = appState._configStartTime, et = appState._configEndTime;
        if (st && et) {
          const t = timeToMinutes(newVal), sm = timeToMinutes(st), em = timeToMinutes(et);
          if (t <= sm || t >= em) { showToast(`风向 ${newVal} 须严格介于 ${st} ~ ${et} 之间`, 'error'); return; }
        }
        const validRange = _getWindValidRange();
        if (!_validateTimelineTime(newVal, validRange, '风向')) return;
        appState.windTimeline[i].time = newVal;
        appState.timelineModified.wind = true;
        updateTimelineStatus();
        renderWindEditor();
      });
    });
  });

  // ── Event: delete ──
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
  const range = _getWindValidRange();
  // Default time: always at the end of the valid range
  let defaultTime = '06:00:00';
  if (range.validMaxTime != null) {
    defaultTime = minutesToTimeStr(range.validMaxTime - 1);
  }
  appState.windTimeline.push({ direction: 180, speed: 5, time: defaultTime });
  appState.timelineModified.wind = true;
  updateTimelineStatus();
  renderWindEditor();
});

// ═══════════ RUNWAY EDITOR ════════════════════════════════

function _getRunwayDefaultTime() {
  const s = appState._configStartTime;
  const e = appState._configEndTime;
  if (s && e) {
    const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
    const mid = Math.floor((toMin(s) + toMin(e)) / 2);
    return String(Math.floor(mid / 60) % 24).padStart(2, '0') + ':' + String(mid % 60).padStart(2, '0') + ':00';
  }
  if (s) return String(s).substring(0, 8);
  if (e) return String(e).substring(0, 8);
  return '12:00:00';
}

function renderRunwayEditor() {
  const container = document.getElementById('runway-editor');
  if (!container) return;

  const rw = appState.runwayTimeline;

  // Sort runway timeline entries by time
  const _toSec = (t) => { const p = String(t || '').split(':'); return (parseInt(p[0]) || 0) * 3600 + (parseInt(p[1]) || 0) * 60 + (parseInt(p[2]) || 0); };
  if (rw.timeline && rw.timeline.length > 1) {
    rw.timeline.sort((a, b) => _toSec(a.time) - _toSec(b.time));
  }

  const pairs = appState._runwayPairs || [];
  const hasPairs = pairs.length > 0;

  // Default time: midpoint of level timeline, fallback to "12:00:00"
  const defaultTime = _getRunwayDefaultTime();

  // First pair for auto-populate
  const defaultPair = hasPairs ? pairs[0] : null;

  // Collect all unique runway names from airport scan, pairs, and flights
  const rwFromPairs = pairs.length ? [...new Set(pairs.flatMap(p => [p.source, p.dest]))] : [];
  const rwFromValues = (appState.airportValues[appState.currentAirport]?.Runway) || [];
  const rwFromFlights = [...new Set((appState.flights || []).map(f => (f.Runway || '').trim()).filter(Boolean))];
  const allRunwayNames = [...new Set([...rwFromPairs, ...rwFromValues, ...rwFromFlights])].sort((a, b) => {
    const na = parseInt(a) || 0, nb = parseInt(b) || 0;
    if (na !== nb) return na - nb;
    return a.localeCompare(b);
  });
  const initialSet = new Set(rw.initialRunways || []);

  const checkboxesHTML = allRunwayNames.map(name => `
    <label class="rw-checkbox-label">
      <input class="rw-checkbox" type="checkbox" value="${escapeHtml(name)}" ${initialSet.has(name) ? 'checked' : ''}>
      ${escapeHtml(name)}
    </label>
  `).join('');

  container.innerHTML = `
    <div class="rw-initial-row">
      <span class="rw-initial-label">初始跑道:</span>
      <div class="rw-checkbox-grid">${checkboxesHTML || '<span class="text-muted">无跑道数据</span>'}</div>
    </div>
    <div class="rw-toolbar">
      <button id="btn-rw-change-add" class="btn-sm">+ 添加变更</button>
    </div>
    ${hasPairs ? `
      <div id="rw-changes-list">
        ${(rw.timeline || []).map((tle, i) => {
          const activeKeys = new Set((tle.changes || []).map(ch => ch.source + '|' + ch.dest));
          return `
          <div class="rw-change-card">
            <div class="rw-change-header">
              <input class="tl-input tl-time-click" type="text" data-idx="${i}" data-field="time" value="${tle.time || ''}" placeholder="HH:MM" readonly>
              <div class="rw-change-checkboxes">
                ${pairs.map(p => {
                  const key = p.source + '|' + p.dest;
                  return `
                  <label class="rw-checkbox-label">
                    <input class="rw-change-cb" type="checkbox" value="${escapeHtml(p.source)}|${escapeHtml(p.dest)}" data-tli="${i}" ${activeKeys.has(key) ? 'checked' : ''}>
                    ${escapeHtml(p.source)} → ${escapeHtml(p.dest)}
                  </label>
                `}).join('')}
              </div>
              <button class="tl-btn-del" data-idx="${i}" title="删除此变更">X</button>
            </div>
          </div>
        `}).join('')}
      </div>
    ` : ''}
  `;

  // Initial runways — checkbox changes update live
  container.querySelectorAll('.rw-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = container.querySelectorAll('.rw-checkbox:checked');
      appState.runwayTimeline.initialRunways = [...checked].map(c => c.value);
      appState.timelineModified.runway = true;
      updateTimelineStatus();
    });
  });

  if (!hasPairs) { updateTimelineStatus(); return; }

  // Change time — clock popover (with strict-bounds validation)
  container.querySelectorAll('.tl-time-click').forEach(el => {
    el.addEventListener('click', () => {
      if (appState.editingWidget) return;
      const i = parseInt(el.dataset.idx);
      openTimeClockPopover(el, '跑道变更', i, appState.runwayTimeline.timeline[i].time, (newVal) => {
        const range = _getRunwayValidRange();
        if (range.validMinTime != null) {
          const t = timeToMinutes(newVal);
          if (t <= range.validMinTime || t >= range.validMaxTime) {
            showToast(`跑道变更 ${newVal} 须严格介于 ${appState._configStartTime} ~ ${appState._configEndTime} 之间`, 'error');
            return;
          }
        }
        appState.runwayTimeline.timeline[i].time = newVal;
        appState.timelineModified.runway = true;
        updateTimelineStatus();
        renderRunwayEditor();
      });
    });
  });

  // Runway change checkboxes — rebuild changes[] from checked pairs
  container.querySelectorAll('.rw-change-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const tli = parseInt(cb.dataset.tli);
      const checked = container.querySelectorAll(`.rw-change-cb[data-tli="${tli}"]:checked`);
      appState.runwayTimeline.timeline[tli].changes = [...checked].map(c => {
        const [source, dest] = c.value.split('|');
        return { source, dest };
      });
      appState.timelineModified.runway = true;
      updateTimelineStatus();
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

  // Add change button (re-bind after innerHTML replace)
  const addBtn = document.getElementById('btn-rw-change-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const defaultTime = _getRunwayDefaultTime();
      appState.runwayTimeline.timeline.push({
        time: defaultTime,
        changes: []
      });
      appState.timelineModified.runway = true;
      updateTimelineStatus();
      renderRunwayEditor();
    });
  }

  updateTimelineStatus();
}
